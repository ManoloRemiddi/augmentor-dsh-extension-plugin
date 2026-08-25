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
 *                                    └─[WS /api/augmentor/ws]──▶ dsh-augmentor plugin
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
 * Everything else passes through verbatim to POST /api/<method>.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'

const VERSION = '0.1.0'
const AUGMENTOR_DIR = path.dirname(fileURLToPath(import.meta.url))
const TRACE_DIR = path.join(AUGMENTOR_DIR, 'trace')
const DSH_BASE = (process.env.DSH_AUGMENTOR_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const PLUGIN_WS_PATH = '/api/augmentor/ws'

// Action-channel token (drives the user's browser, so it is gated). Same
// resolution as the plugin: explicit env > $DSH_HOME/augmentor-ws-token
// (0600, created by whichever side boots first) > generate. Both sides of
// the channel converge on the same secret.
function resolveToken() {
  if (process.env.DSH_AUGMENTOR_WS_TOKEN) return { token: process.env.DSH_AUGMENTOR_WS_TOKEN, source: 'env' }
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const file = path.join(home, 'augmentor-ws-token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return { token: existing, source: 'file' }
  } catch {
    /* first boot: generate */
  }
  const token = randomBytes(16).toString('hex')
  try {
    writeFileSync(file, token + '\n', { mode: 0o600 })
  } catch {
    /* unresolvable home: the plugin's copy (if any) still gates; we'll fail the upgrade */
  }
  return { token, source: 'generated' }
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
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}

// ---------------------------------------------------------------- trace
const traceName = `pipe-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
const traceFile = path.join(TRACE_DIR, traceName)
await mkdir(TRACE_DIR, { recursive: true })
function trace(entry) {
  entry.at = Date.now()
  try {
    writeFileSync(traceFile, JSON.stringify(entry) + '\n', { flag: 'a' })
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
let stdoutDrained = true
function sendToExt(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8')
  const frame = Buffer.allocUnsafe(4)
  frame.writeUInt32LE(json.length, 0)
  trace({ kind: 'ext<-pipe', msg: obj })
  if (!stdoutDrained) return
  stdoutDrained = false
  process.stdout.write(Buffer.concat([frame, json]), () => { stdoutDrained = true })
}

// Ext reply id → origin: host server-requests we forwarded (rpcId) vs plugin
// browser round trips (plugin UUID). First match wins; ids never collide in
// practice (different minters).
const forwardedRpc = new Map() // rpcId → 'mux' | 'host'
const pluginPending = new Map() // plugin id → true

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
function pluginSend(obj) {
  if (pluginWs && pluginWs.readyState === WebSocket.OPEN) pluginWs.send(JSON.stringify(obj))
}
const WS_TOKEN = resolveToken()

function openPluginWs() {
  if (pluginWs) return
  const url = `${DSH_BASE.replace(/^http/, 'ws')}${PLUGIN_WS_PATH}${WS_TOKEN.token ? `?token=${encodeURIComponent(WS_TOKEN.token)}` : ''}`
  const ws = new WebSocket(url)
  pluginWs = ws
  ws.on('open', () => log('plugin ws connected', PLUGIN_WS_PATH))
  ws.on('message', (data) => {
    let frame
    try {
      frame = JSON.parse(String(data))
    } catch {
      return
    }
    trace({ kind: 'plugin', dir: 'plugin->pipe', msg: frame })
    if (frame.type !== 'request' || frame.id === undefined) return // welcome etc.
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
    try {
      onDownlinkFrame(stream, JSON.parse(String(data)))
    } catch (e) {
      log('downlink frame error', stream, e.message)
    }
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
      open()
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
        models: (g.models ?? []).map((m) => ({ model: m.id, name: m.name, description: m.description })),
      })),
      failures: models.failures ?? [],
      default: { provider: describe.provider, model: describe.model },
    }
  },
  async initialize() {
    const describe = await dsh('host.describe', {})
    return {
      serverInfo: {
        name: 'dsh-augmentor-pipe',
        version: VERSION,
        dshVersion: describe.version,
        home: describe.home,
        cwd: describe.cwd,
        attachedSessions: describe.attachedSessions,
        transport: 'dsh-api-pipe',
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
  try {
    const value = localMethods[msg.method] ? await localMethods[msg.method](msg.params) : await dsh(msg.method, msg.params ?? {})
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
  openPluginWs()
}

// --------------------------------------------------------------- lifecycle
process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk])
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0)
    if (stdinBuf.length < 4 + len) break
    const raw = stdinBuf.subarray(4, 4 + len)
    stdinBuf = stdinBuf.subarray(4 + len)
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch (e) {
      log('bad frame from extension', e.message)
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
