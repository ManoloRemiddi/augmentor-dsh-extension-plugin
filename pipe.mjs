#!/usr/bin/env node
/**
 * pipe.mjs — Augmentor native messaging host (M1).
 *
 * Replaces the old sidecar bridge (bridge.mjs). Instead of spawning a second
 * DSH runtime, it pipes the extension's frames to the RUNNING DSH app's stock
 * /api surface. The extension's chrome-extension Origin is refused by the
 * trust fence (loopback-Host only, cross-site fetch metadata), so this
 * loopback Node process is the browser's stand-in client — a non-browser
 * loopback client passes the reachability policy:
 *
 *   Chrome SW ──[native frames]──▶ pipe.mjs ──[POST /api/<method>]──▶ DSH app
 *                                    │  └─[WS /api/events.mux]──▶ downlink frames
 *                                    │  └─[WS /api/events.host]─▶ downlink frames
 *                                    └─[WS <wsPath from the plugin's GET
 *                                       /api/augmentor handshake>]─▶ plugin
 *
 * Frame vocabulary with the extension is UNCHANGED from the old bridge
 * (sw.js stays the baseline):
 *   ext → pipe:  {id, method, params}                      (client request)
 *   pipe → ext:  {id, result} | {id, error: {message}}     (response)
 *                {id, method: 'browser/execute', params}   (server→client request)
 *                {method: 'session.event' | 'session.status' | …, params} (notification)
 *
 * Downlink ServerRequest frames ({type:'server-request', rpcId, method:<frame
 * type>, payload}) map as frame type 'a/b' → ext method 'a.b'. Answerable
 * frames (approval/requested, question/requested) forward with id = rpcId, so
 * the extension's {id, result|error} reply is echoed to POST /api/respond as
 * a client-response.
 *
 * Local methods answered without a DSH round trip:
 *   augmentor/models      llm.models + host.describe, reshaped to the legacy
 *                         catalog.groups[{provider, models[{model}]}] + default
 *   initialize            {serverInfo} from host.describe — the DSH app IS the
 *                         runtime; there is nothing to start
 *   augmentor/switchModel error (per-session model switching lands in M3 via
 *                         session.selectModel)
 *   trace/fence-probe     writes trace/fence-probe.json (ext-Origin fence evidence)
 *   shutdown              {ok:true}, then clean exit
 * Everything else passes through verbatim to POST /api/<method>, with one
 * exception: session.history responses are shaped (shapeHistory) —
 * assistant/chunk stripped and oldest events dropped until the frame fits
 * under the 1 MiB native-messaging wire limit. See the function comment.
 */
import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { readFile, mkdir, chmod } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
// F5 (audit): shared frame codec + pending table — one implementation with
// the plugin and the extension service worker (wire.mjs; the extension ships
// a byte-identical copy, asserted by sw-e2e).
import { decode as wireDecode, encode as wireEncode, Pending } from './wire.mjs'

const AUGMENTOR_DIR = path.dirname(fileURLToPath(import.meta.url))

// F7 (audit): the sidecar's version tracks the extension's — read it from the
// manifest the pipe always ships with (single source of truth) instead of
// hand-duplicating a frozen '0.1.0'.
function manifestVersion() {
  try {
    const m = JSON.parse(readFileSync(path.join(AUGMENTOR_DIR, 'extension', 'manifest.json'), 'utf8'))
    return typeof m.version === 'string' && m.version ? m.version : 'unknown'
  } catch {
    return 'unknown' // bare copy without extension/ — never crash the pipe
  }
}
const VERSION = manifestVersion()
const TRACE_DIR = path.join(AUGMENTOR_DIR, 'trace')
const DSH_BASE = (process.env.DSH_AUGMENTOR_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const PLUGIN_WS_PATH = '/api/augmentor/ws'

// Action-channel token (drives the user's browser, so it is gated). Same
// resolution as the plugin: explicit env > $DSH_HOME/augmentor-ws-token
// (0600, created by whichever side boots first) > generate. Both sides of
// the channel converge on the same secret.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function resolveToken() {
  if (process.env.DSH_AUGMENTOR_WS_TOKEN) return { token: process.env.DSH_AUGMENTOR_WS_TOKEN, source: 'env' }
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const file = path.join(home, 'augmentor-ws-token')
  const readExisting = () => {
    try {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing) return existing
    } catch { /* missing */ }
    return null
  }
  const existing = readExisting()
  if (existing) return { token: existing, source: 'file' }
  // S15 (audit): first boot. The old read→write was racy — two first boots
  // (plugin + pipe) could each generate a DIFFERENT token and last-write-wins
  // split the channel silently. O_EXCL makes creation atomic: exactly one
  // side wins; the loser re-reads the winner (retries while it mid-writes).
  const token = randomBytes(16).toString('hex')
  try {
    const fd = openSync(file, 'wx', 0o600)
    try { writeSync(fd, token + '\n') } finally { closeSync(fd) }
    return { token, source: 'generated' }
  } catch (e) {
    if (e.code !== 'EEXIST') {
      /* unresolvable home: the plugin's copy (if any) still gates; we'll fail the upgrade */
      return { token, source: 'generated' }
    }
    for (let i = 0; i < 20; i++) {
      const winner = readExisting()
      if (winner) return { token: winner, source: 'file' }
      sleepSync(5)
    }
    log('token race: concurrent create, re-read came up empty — falling back to the local token (channel may reject it)')
    return { token, source: 'generated' }
  }
}

// ---------------------------------------------------------------- .env
// Minimal KEY=VALUE fallback merge (existing process env wins). The pipe no
// longer spawns a runtime, so credentials here are only a forward-looking
// seam; today the DSH app resolves its own.
{
  let envText = ''
  try {
    envText = await readFile(path.join(AUGMENTOR_DIR, '.env'), 'utf8')
  } catch {
    /* no .env: process env only */
  }
  for (const line of envText.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    // S14 (audit): dotenv semantics — the old capture kept ' # …' inline
    // comments inside the value (and quote characters). Quoted values keep
    // their interior verbatim; unquoted values strip from the first ' #'.
    let val = m[2].trim()
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1)
    } else {
      const hash = val.indexOf(' #')
      if (hash !== -1) val = val.slice(0, hash).trim()
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
}

// ---------------------------------------------------------------- trace
const traceName = `pipe-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
const traceFile = path.join(TRACE_DIR, traceName)
await mkdir(TRACE_DIR, { recursive: true, mode: 0o700 })
// S3 (audit): traces capture prompts, typed text and tool results — an
// existing 0755 dir from before the mode fix still leaks them to other local
// users, so tighten best-effort on every boot.
try { await chmod(TRACE_DIR, 0o700) } catch { /* not the owner: leave as-is */ }
// 0.1.18: the trace was growing without bound — one live session with the
// GUI streaming through the pipe produced 212 MB in 17 minutes (every
// downlink frame AND its ext<-pipe echo were writeFileSync'd to disk),
// adding synchronous disk I/O to every relayed frame. The audit trail that
// matters (ext->pipe requests, log, respond, plugin, fence) is kept; pure
// relay frames are skipped and the file stops growing at the cap.
const TRACE_MAX_BYTES = 50 * 1024 * 1024
let traceBytes = 0
let traceCapped = false
// S3 (audit): never let credential-shaped values land in a trace file.
// Applied to the serialized line, so it catches any nesting level:
// "…password": "…", sk-… keys, and token=… query params.
const REDACT_VALUE_RE = /("(?:passw(?:or)?d|secret|token|api_?key|authorization|cookie)"\s*:\s*")([^"]*)"/gi
const REDACT_SK_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g
const REDACT_QUERY_RE = /([?&]token=)[^&\s"']{6,}/gi
function redactTrace(line) {
  // Callback signature: (match, group1, group2, offset, string) — the value
  // quote is part of the match, so re-add it in the replacement.
  return line
    .replace(REDACT_VALUE_RE, (m, pre, val) => pre + (val ? '***redacted***' : '') + '"')
    .replace(REDACT_SK_RE, 'sk-***redacted***')
    .replace(REDACT_QUERY_RE, '$1***redacted***')
}
function trace(entry) {
  entry.at = Date.now()
  if (entry.kind === 'downlink' || entry.kind === 'ext<-pipe') return
  if (traceCapped) return
  const line = redactTrace(JSON.stringify(entry)) + '\n'
  traceBytes += line.length
  if (traceBytes > TRACE_MAX_BYTES) {
    traceCapped = true
    log('trace capped at ~50 MB — stopping trace writes (kept: ' + traceFile + ')')
    return
  }
  try {
    writeFileSync(traceFile, line, { flag: 'a', mode: 0o600 }) // S3: owner-only
  } catch {
    /* tracing must never kill the pipe */
  }
}
const log = (...parts) => {
  const line = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  trace({ kind: 'log', line })
  process.stderr.write(`[pipe] ${line}\n`)
}

// ------------------------------------------------------- DSH /api client
let rpcSeq = 0
/** One client request: POST /api/<method> with the client-request envelope. */
async function dsh(method, payload = {}) {
  // S12 (audit): the method is interpolated into the URL path — constrain it
  // to the stock method shape (session.prompt, host.describe,
  // trace/fence-probe, …). Dotted/slash-separated alphanumeric segments only;
  // `..`, leading dots and stray path characters are rejected.
  if (typeof method !== 'string' || !/^[a-z][a-z0-9_-]*(?:[./][a-z0-9_-]+)*$/i.test(method)) {
    throw new Error(`dsh: refusing invalid method name ${JSON.stringify(method)}`)
  }
  const rpcId = `pipe-${++rpcSeq}`
  const res = await fetch(`${DSH_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body || body.type !== 'server-response' || body.rpcId !== rpcId) {
    throw new Error(`${method}: unexpected envelope (http ${res.ok ? 'ok' : res.status})`)
  }
  if (!body.result.ok) {
    const e = body.result.error ?? {}
    throw new Error(e.message ?? JSON.stringify(e))
  }
  return body.result.value
}

/** Answer a host-initiated server-request: POST /api/respond, client-response. */
async function dshRespond(rpcId, extMsg) {
  const result = extMsg.error
    ? { ok: false, error: { code: 'bad-request', message: extMsg.error.message ?? 'client refused', details: { issues: [] } } }
    : { ok: true, value: extMsg.result }
  const res = await fetch(`${DSH_BASE}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId, result }),
  })
  const receipt = await res.json().catch(() => null)
  trace({ kind: 'respond', rpcId, receipt })
  if (!receipt?.accepted) log('respond rejected', rpcId, receipt)
}

// ------------------------------------------------- extension frame I/O
// 0.1.18: queue + drain-chaining. The old version DROPPED a frame whenever a
// previous write was still draining — under the DSH GUI's downlink firehose
// stdout is almost always busy, so extension REQUEST RESPONSES (session.list,
// models, initialize, …) could silently vanish and the SW's pending waiter
// hung for the full timeout. Every frame now enters the queue; the pump
// flushes on 'drain' and never loses one.
let outQueue = []
let outPumping = false
// 0.1.21: Chrome's native-messaging channel caps host→extension messages at
// 1 MiB. A bigger frame doesn't error — Chrome KILLS the connection and the
// extension only sees "Error when communicating with the native messaging
// host." (the exact dead-end behind the M1 Browse failure: the session list
// payload was 4.7 MB). Never emit an oversized frame: a request gets a small
// readable error frame instead; a push frame is dropped (logged).
const NMH_FRAME_MAX = 1024 * 1024
function pushFrame(obj) {
  const json = Buffer.from(wireEncode(obj), 'utf8')
  const frame = Buffer.allocUnsafe(4)
  frame.writeUInt32LE(json.length, 0)
  trace({ kind: 'ext<-pipe', msg: obj })
  outQueue.push(Buffer.concat([frame, json]))
  pumpOut()
}
function sendToExt(obj) {
  const json = Buffer.from(wireEncode(obj), 'utf8')
  if (json.length + 4 > NMH_FRAME_MAX) {
    log('oversized frame suppressed', obj.id ?? obj.method ?? '?', `${json.length} bytes (>1 MiB)`)
    if (obj.id !== undefined) {
      pushFrame({ id: obj.id, error: { message: 'response exceeds the 1 MiB native-messaging channel limit' } })
    }
    return
  }
  pushFrame(obj)
}
function pumpOut() {
  if (outPumping) return
  outPumping = true
  const step = () => {
    let buf
    while ((buf = outQueue.shift()) !== undefined) {
      if (!process.stdout.write(buf)) {
        process.stdout.once('drain', step)
        return
      }
    }
    outPumping = false
  }
  step()
}

// Ext reply id → origin: host server-requests we forwarded (rpcId) vs plugin
// browser round trips (plugin UUID). First match wins; ids never collide in
// practice (different minters).
const forwardedRpc = new Map() // rpcId → 'mux' | 'host'
const pluginPending = new Map() // plugin id → true
// Extension-originated lifecycle requests (augmentor/save|unsave|state)
// forwarded to the plugin, waiting for its reply frame.
const pluginReplyWaiters = new Pending() // F5: id → {resolve, reject, timer, …}
const PLUGIN_TIMEOUT_MS = 30000

async function routeExtReply(msg) {
  if (forwardedRpc.has(msg.id)) {
    forwardedRpc.delete(msg.id)
    await dshRespond(msg.id, msg)
    return
  }
  if (pluginPending.has(msg.id)) {
    pluginPending.delete(msg.id)
    pluginSend({ type: 'reply', id: msg.id, ...(msg.error ? { error: msg.error } : { result: msg.result }) })
    return
  }
  log('reply for unknown id (late or stale)', msg.id)
}

// ------------------------------------------------------- plugin channel
let pluginWs = null
// F8 (audit, 2026-08-28 field finding): liveness flag for the heartbeat below.
let wsAlive = true
function pluginSend(obj) {
  if (pluginWs && pluginWs.readyState === WebSocket.OPEN) pluginWs.send(wireEncode(obj))
}
const WS_TOKEN = resolveToken()

// D5 (audit): the pipe's copy of the wire protocol the plugin must speak.
// Each endpoint declares what it expects; a mismatch is logged loudly at the
// handshake and at the plugin's welcome frame (below).
const PROTOCOL_EXPECTED = 'augmentor-pipe/v1'

// D5 (audit): the plugin's HTTP handshake (GET <apiPath>) carries the live
// wsPath (configurable in the plugin config) plus its protocol/version.
// Resolved on every (re)connect; PLUGIN_WS_PATH is only the offline fallback
// (app down / plugin not up yet — the connect will retry anyway).
let pluginInfo = null
async function fetchPluginHandshake() {
  try {
    const res = await fetch(`${DSH_BASE}/api/augmentor`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) {
      log('plugin handshake failed:', res.status)
      pluginInfo = null
      return null
    }
    const body = await res.json()
    pluginInfo = body
    log(`plugin handshake: ${body.name} ${body.protocol} v${body.version}, wsPath=${body.wsPath}`)
    return body
  } catch (e) {
    log('plugin handshake failed:', e.message)
    pluginInfo = null
    return null
  }
}

async function openPluginWs() {
  if (pluginWs) return
  const info = await fetchPluginHandshake()
  if (info?.protocol && info.protocol !== PROTOCOL_EXPECTED) {
    log(`PROTOCOL MISMATCH: pipe expects ${PROTOCOL_EXPECTED}, plugin reports ${info.protocol} — frames may not interoperate`)
  }
  // D5 (audit): the wsPath comes from the handshake, not the constant.
  const wsPath = info?.wsPath || PLUGIN_WS_PATH
  // S7 (audit): the token rides ONLY the WS handshake header. The query
  // param was a temporary legacy shim for pre-header plugins (a query token
  // lands in any request log the DSH app keeps); it is now dropped — the
  // live app runs the plugin that prefers the header, so a header-only
  // handshake is the full contract.
  const url = `${DSH_BASE.replace(/^http/, 'ws')}${wsPath}`
  const ws = new WebSocket(url, { headers: WS_TOKEN.token ? { 'x-augmentor-token': WS_TOKEN.token } : {} })
  pluginWs = ws
  wsAlive = true
  ws.on('open', () => log('plugin ws connected', wsPath))
  ws.on('pong', () => { wsAlive = true })
  ws.on('message', (data) => {
    const frame = wireDecode(String(data))
    if (!frame || typeof frame !== 'object') return
    trace({ kind: 'plugin', dir: 'plugin->pipe', msg: frame })
    if (frame.type === 'welcome') {
      // D5 (audit): the plugin identifies itself on connect — validate it
      // (name/protocol/version) instead of silently dropping the frame.
      if (frame.name !== 'dsh-augmentor') log('unexpected plugin name in welcome:', frame.name)
      if (frame.protocol !== PROTOCOL_EXPECTED) {
        log(`PROTOCOL MISMATCH: pipe expects ${PROTOCOL_EXPECTED}, plugin sent ${frame.protocol} — frames may not interoperate`)
      } else {
        log(`plugin hello: ${frame.name} ${frame.protocol} v${frame.version}`)
      }
      return
    }
    if (frame.type === 'reply' && frame.id !== undefined) {
      // Answer to an augmentor/save|unsave|state request we forwarded.
      pluginReplyWaiters.settle(frame.id, frame.result, frame.error ? new Error(frame.error.message ?? JSON.stringify(frame.error)) : null)
      return
    }
    if (frame.type !== 'request' || frame.id === undefined) return
    if (frame.method !== 'browser/execute') {
      pluginSend({ type: 'reply', id: frame.id, error: { message: `unsupported method: ${frame.method}` } })
      return
    }
    pluginPending.set(frame.id, true)
    sendToExt({ id: frame.id, method: 'browser/execute', params: frame.params })
  })
  ws.on('close', () => {
    pluginWs = null
    log('plugin ws closed; retrying')
    scheduleReconnect(openPluginWs, 'plugin')
  })
  ws.on('error', (e) => log('plugin ws error', e.message))
}

// F8 (audit, 2026-08-28 field finding): the DSH app hot-swaps the plugin
// module IN-PLACE (a ?src= query bump reloads it inside the same process).
// The old plugin's WS server is abandoned with its client sockets still
// ESTABLISHED — the kernel keeps the TCP connection open and silent, so this
// pipe's 'close' event never fires and the reconnect loop below never runs:
// the zombie-pipe mode (process alive, ext leg alive, plugin leg dead,
// "pipes: 0"). A liveness ping catches exactly that: a healthy server
// auto-pongs, an orphaned socket never does. A real process restart still
// surfaces as 'close' and goes through the ordinary reconnect path.
const PLUGIN_HEARTBEAT_MS = 20000
const pluginHb = setInterval(() => {
  if (!pluginWs || pluginWs.readyState !== WebSocket.OPEN) return
  if (!wsAlive) {
    log('plugin ws stale (no pong) — terminating for reconnect')
    wsAlive = true
    pluginWs.terminate() // 'close' handler → scheduleReconnect(openPluginWs)
    return
  }
  wsAlive = false
  pluginWs.ping()
}, PLUGIN_HEARTBEAT_MS)
pluginHb.unref()

// ------------------------------------------------------------ downlinks
const downlinks = new Map() // 'mux' | 'host' → {ws, open}
const DOWNLINK_PATHS = { mux: '/api/events.mux', host: '/api/events.host' }
const ANSWERABLE = new Set(['approval/requested', 'question/requested'])

function onDownlinkFrame(stream, frame) {
  trace({ kind: 'downlink', stream, msg: frame })
  if (frame.type !== 'server-request') return
  const t = frame.method // the frame type discriminator
  const payload = frame.payload
  if (t === 'stream/error') {
    log('stream error on', stream, payload?.error)
    return
  }
  if (t === 'host/session-status') {
    // The old bridge's status vocabulary: the SW compares params.status.
    sendToExt({ method: 'session.status', params: { sessionId: payload.sessionId, status: payload.running ? 'running' : 'idle' } })
    return
  }
  if (ANSWERABLE.has(t)) {
    forwardedRpc.set(frame.rpcId, stream)
    sendToExt({ id: frame.rpcId, method: t.replace('/', '.'), params: payload })
    return
  }
  sendToExt({ method: t.replace('/', '.'), params: payload })
}

function openDownlink(stream) {
  if (downlinks.get(stream)?.open) return
  const ws = new WebSocket(`${DSH_BASE.replace(/^http/, 'ws')}${DOWNLINK_PATHS[stream]}`)
  downlinks.set(stream, { ws, open: true })
  ws.on('open', () => log('downlink open', stream))
  ws.on('message', (data) => {
    const frame = wireDecode(String(data))
    if (!frame) return
    onDownlinkFrame(stream, frame)
  })
  ws.on('close', () => {
    downlinks.set(stream, { ws, open: false })
    log('downlink closed', stream, '— reopening (v1: reopen + refetch, no since)')
    scheduleReconnect(() => openDownlink(stream), stream)
  })
  ws.on('error', (e) => log('downlink error', stream, e.message))
}

// ------------------------------------------------------------- reconnect
const retryTimers = new Map()
function scheduleReconnect(open, key) {
  if (retryTimers.has(key)) return
  const delay = Math.min(10000, 1000 * 2 ** (retryTimers.size % 4))
  const timer = setTimeout(() => {
    retryTimers.delete(key)
    try {
      const r = open()
      // F5 (audit): retry targets may be async (openPluginWs, boot) — a
      // rejected promise escapes the try/catch above and becomes an
      // unhandledRejection instead of a logged, rescheduled retry.
      if (r && typeof r.catch === 'function') {
        r.catch((e) => {
          log('reconnect failed', key, e.message)
          scheduleReconnect(open, key)
        })
      }
    } catch (e) {
      log('reconnect failed', key, e.message)
      scheduleReconnect(open, key)
    }
  }, delay)
  timer.unref()
  retryTimers.set(key, timer)
}

// ------------------------------------------------------------ local methods
const localMethods = {
  async 'augmentor/models'() {
    const [models, describe] = await Promise.all([dsh('llm.models', {}), dsh('host.describe', {})])
    return {
      groups: (models.groups ?? []).map((g) => ({
        provider: g.id,
        name: g.name,
        // Each model entry carries its provider: the panel's picker
        // (unmodified legacy contract, sidepanel.js) reads m.provider per row
        // to address session.selectModel — omitting it made row clicks send
        // {provider: undefined}.
        models: (g.models ?? []).map((m) => ({ provider: g.id, model: m.id, name: m.name, description: m.description })),
      })),
      failures: models.failures ?? [],
      default: { provider: describe.provider, model: describe.model },
    }
  },
  async initialize() {
    const describe = await dsh('host.describe', {})
    // Fold the plugin's handshake into serverInfo: the extension needs the
    // pinned chat cwd (to create sessions in it) and the saved-session list
    // (badge state) without a second wire round trip. Tolerate the plugin
    // being down — the SW then falls back to the old cwd and shows no badge.
    let augmentor = null
    try {
      const res = await fetch(`${DSH_BASE}/api/augmentor`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) augmentor = await res.json()
    } catch {
      /* plugin not up yet: live Save will fail with a readable error */
    }
    return {
      serverInfo: {
        name: 'dsh-augmentor-pipe',
        version: VERSION,
        dshVersion: describe.version,
        home: describe.home,
        cwd: describe.cwd,
        attachedSessions: describe.attachedSessions,
        transport: 'dsh-api-pipe',
        // M3: the running DSH app's base URL (Open-in-DSH button) + the
        // plugin's chat-lifecycle state.
        endpoint: DSH_BASE,
        augmentor,
      },
    }
  },
  'augmentor/switchModel'() {
    throw new Error('model switching lands in M3 (session.selectModel); M1 is read-only')
  },
  'trace/fence-probe'(params) {
    const out = path.join(TRACE_DIR, 'fence-probe.json')
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...params }, null, 2) + '\n')
    log('fence probe recorded', out)
    return { ok: true, path: out }
  },
  shutdown() {
    log('shutdown requested by extension')
    setTimeout(() => cleanup(0), 50)
    return { ok: true }
  },
}

// --------------------------------------------------------- dispatch (ext)
let shuttingDown = false
// --------------------------------------------------- history byte shaping
// Chrome's native messaging limit is **1 MiB per host->extension message**
// (developer.chrome.com, native-messaging: "The maximum size of a single
// message from the native messaging host is 1 MB"). A full DSH session
// history is chunk-heavy — one event per streamed token: a 99-message
// session measured 10.8 MB on the wire, a 500-message tail 92 MB. The
// panel's history renderer (chat-render.js) renders whole turns from
// `assistant/message` (its text is authoritative — "covers providers
// without chunks"), `user/message`, `tool/call`, `tool/result`, turn/step
// frames; `assistant/chunk` only matters for *live* streaming, where it
// arrives as tiny individual downlink frames. So for the bulk history
// frame we: (1) strip assistant/chunk, (2) keep the NEWEST events and
// drop from the oldest side until under the byte budget — the recent
// context always renders. Live streaming is untouched.
const HISTORY_BUDGET = 850 * 1024 // well under the 1 MiB wire limit
function shapeHistory(value) {
  if (!value?.events?.length) return value
  const events = value.events.filter((h) => h?.event?.type !== 'assistant/chunk')
  if (!events.length) return { ...value, events: [] }
  const envelopeCost = JSON.stringify({ ...value, events: [] }).length
  let budget = HISTORY_BUDGET - envelopeCost
  let start = events.length // nothing fits yet
  for (let i = events.length - 1; i >= 0; i--) {
    const cost = JSON.stringify(events[i]).length + 2 // +2 for ", "
    if (cost > budget) break
    budget -= cost
    start = i
  }
  if (start === events.length) {
    // Pathological: not even the newest event fits. Keep the newest one and
    // cap its long strings so the frame still lands under the wire limit.
    const capStrings = (o) => {
      if (typeof o === 'string' && o.length > 50 * 1024)
        return o.slice(0, 50 * 1024) + ` …[truncated ${o.length - 50 * 1024} chars]`
      if (Array.isArray(o)) return o.map(capStrings)
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) o[k] = capStrings(o[k])
      }
      return o
    }
    return { ...value, events: [capStrings({ ...events[events.length - 1] })], truncatedEarlier: events.length - 1 }
  }
  const out = { ...value, events: events.slice(start) }
  if (start > 0) out.truncatedEarlier = start
  return out
}

// 0.1.21: the raw /api/session.list payload grows with the user's session
// history (projections, usage stats) — it hit 4.7 MB on this machine, which
// blew past the 1 MiB native-messaging limit and made Chrome KILL the host
// connection (surfacing as "Error when communicating with the native
// messaging host." on every Browse click). The panel renders exactly five
// fields per row, so the pipe ships the slim shape — and, per the user's
// call, only the LATEST LIST_MAX_ROWS rows (newest by updatedAt): 20 slim
// rows are ~4 KB, so the frame can never approach the wire limit by
// accumulation. `total` carries the full count so the panel can show
// "Latest 20 of 67" instead of silently hiding older sessions:
const LIST_MAX_ROWS = 20
const LIST_BUDGET = 850 * 1024 // outermost safety, should never trigger now
function shapeSessionList(value) {
  const items = value?.items
  if (!Array.isArray(items) || !items.length) return value
  const slim = (i) => ({
    sessionId: i.sessionId,
    cwd: i.cwd ?? null,
    running: !!i.running,
    updatedAt: i.updatedAt ?? null,
    ...(i.projections?.values?.title ? { projections: { values: { title: i.projections.values.title } } } : {}),
  })
  const sorted = [...items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const kept = sorted.slice(0, LIST_MAX_ROWS)
  let out = { ...value, items: kept.map(slim), total: items.length }
  if (JSON.stringify(out).length > LIST_BUDGET) {
    // Pathological (e.g. gigantic titles): keep the newest rows that fit.
    let k = kept
    while (k.length > 1 && JSON.stringify({ ...out, items: k.map(slim) }).length > LIST_BUDGET) {
      k = k.slice(0, Math.max(1, Math.floor(k.length * 0.7)))
    }
    out = { ...value, items: k.map(slim), total: items.length, truncatedEarlier: items.length - k.length }
  }
  return out
}

let stdinBuf = Buffer.alloc(0)
async function handleExtMessage(msg) {
  trace({ kind: 'ext->pipe', msg })
  // Response form: id present, no method.
  if (msg.id !== undefined && msg.method === undefined) {
    await routeExtReply(msg)
    return
  }
  if (!msg.method) {
    log('dropping frame without id or method')
    return
  }
  const id = msg.id
  // M3: the chat-lifecycle methods are served by the PLUGIN over the action
  // channel WS (it holds the workspaceRegistry), not by the /api surface —
  // forward them there and await the plugin's reply frame.
  const PLUGIN_METHODS = new Set(['augmentor/save', 'augmentor/unsave', 'augmentor/state'])
  try {
    let value
    if (PLUGIN_METHODS.has(msg.method)) {
      if (!pluginWs || pluginWs.readyState !== WebSocket.OPEN) {
        throw new Error('plugin channel not connected — the DSH app or the Augmentor plugin is not up')
      }
      // F5: the waiter is the wire Pending — add() returns the promise and
      // owns the timeout (it rejects the entry and settle() clears it on a
      // reply), so no manual timer bookkeeping (and no stale-timer crash 30
      // s after a plugin request, which the old Map-style code left behind
      // because Pending has no set/delete).
      const reply = pluginReplyWaiters.add(id, { timeoutMs: PLUGIN_TIMEOUT_MS })
      pluginSend({ type: 'request', id, method: msg.method, params: msg.params ?? {} })
      value = await reply
    } else {
      value = localMethods[msg.method] ? await localMethods[msg.method](msg.params) : await dsh(msg.method, msg.params ?? {})
    }
    if (msg.method === 'session.history') {
      value = shapeHistory(value)
      if (value.truncatedEarlier) log('history shaped', { truncatedEarlier: value.truncatedEarlier })
    }
    if (msg.method === 'session.list') {
      value = shapeSessionList(value)
      if (value.truncatedEarlier) log('list shaped', { truncatedEarlier: value.truncatedEarlier })
    }
    sendToExt({ id, result: value })
  } catch (e) {
    sendToExt({ id, error: { message: e.message ?? String(e) } })
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    const describe = await dsh('host.describe', {})
    log(`DSH app ready: dsh ${describe.version}, home ${describe.home}, ${describe.attachedSessions} attached session(s)`)
  } catch (e) {
    log('DSH app not reachable yet:', e.message)
    scheduleReconnect(boot, 'boot')
    return
  }
  openDownlink('mux')
  openDownlink('host')
  log('action-channel token source:', WS_TOKEN.source)
  void openPluginWs()
}

// --------------------------------------------------------------- lifecycle
process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk])
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0)
    if (stdinBuf.length < 4 + len) break
    const raw = stdinBuf.subarray(4, 4 + len)
    stdinBuf = stdinBuf.subarray(4 + len)
    const msg = wireDecode(raw.toString('utf8'))
    if (!msg || typeof msg !== 'object') {
      log('bad frame from extension')
      continue
    }
    void handleExtMessage(msg)
  }
})

function cleanup(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const d of downlinks.values()) {
    try { d.ws.terminate() } catch { /* already dead */ }
  }
  try { pluginWs?.terminate() } catch { /* already dead */ }
  process.exit(code)
}

process.stdin.on('end', () => {
  log('extension port closed (stdin end)')
  cleanup(0)
})
process.stdin.resume()
process.on('SIGTERM', () => cleanup(0))
process.on('SIGINT', () => cleanup(130))

log(`pipe ${VERSION} starting; DSH base ${DSH_BASE}; trace ${traceName}`)
void boot()
