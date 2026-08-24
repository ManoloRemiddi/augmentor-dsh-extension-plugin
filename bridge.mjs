#!/usr/bin/env node
/**
 * Augmentor (powered by DSH) — native messaging host bridge.
 *
 * Chrome launches this process (via the native messaging host manifest) with
 * stdio = the native messaging port: 4-byte little-endian length prefix +
 * UTF-8 JSON payload.
 *
 * This bridge:
 *   1. spawns the dsh JSON-RPC runtime (NDJSON JSON-RPC 2.0 on child stdio)
 *   2. relays frames both ways, re-framing between the two codecs
 *   3. serves a loopback HTTP endpoint that the in-runtime `dsh-browser` CLI
 *      posts browser actions to; each action becomes a server->client-style
 *      request {id, method:'browser/execute', params} on the Chrome port and
 *      resolves when the extension answers {id, result|error}
 *   4. serves the bridge-local model methods the extension's picker needs:
 *      `augmentor/models` (the DSH app's model catalog, read from
 *      $DSH_HOME/settings.yaml so the sidecar offers exactly what the DSH app
 *      offers) and `augmentor/switchModel` (restarts the runtime process so
 *      the new selection reaches the current session, which resumes from its
 *      persisted log)
 *   5. appends every frame to a JSONL trace file for data collection
 *
 * All logs go to the trace file and stderr; stdout carries ONLY native
 * frames (the child's stdout carries ONLY JSON-RPC — both must stay pure).
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = path.dirname(fileURLToPath(import.meta.url))
const CLONE = process.env['DSH_AUGMENTOR_CLONE'] ?? path.resolve(BASE, '..', 'deepseek-harness')
const RUNTIME_BIN = path.join(CLONE, 'packages', 'examples', 'jsonrpc-demo', 'lib', 'bin.js')
const CORDIS_YML = path.join(CLONE, 'examples', 'jsonrpc-agent', 'augmentor.cordis.yml')
const WORKDIR = path.join(BASE, 'agent-workdir')
const SESSION_ROOT = path.join(BASE, 'sessions')
const TRACE_DIR = path.join(BASE, 'trace')

mkdirSync(WORKDIR, { recursive: true })
mkdirSync(SESSION_ROOT, { recursive: true })
mkdirSync(TRACE_DIR, { recursive: true })

const T0 = Date.now()
const TRACE = path.join(TRACE_DIR, `bridge-${new Date(T0).toISOString().replace(/[:.]/g, '-')}.jsonl`)

function trace(dir, obj) {
  try {
    appendFileSync(TRACE, JSON.stringify({ t: Date.now() - T0, dir, ...obj }) + '\n')
  } catch {
    /* trace must never kill the bridge */
  }
  try {
    process.stderr.write(`[bridge] ${JSON.stringify(obj).slice(0, 500)}\n`)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- env
function loadDotEnv(file) {
  if (!existsSync(file)) return {}
  const out = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const dotenv = loadDotEnv(path.join(BASE, '.env'))
const persona = readFileSync(path.join(BASE, 'persona.md'), 'utf8')
const SECRET = randomBytes(8).toString('hex')

// ------------------------------------------- model catalog (the DSH app's)
// The picker lists the DSH app's own model set: the `llm-pi-ai:` provider
// routes of $DSH_HOME/settings.yaml (the same document the DSH app loads —
// mx-qwen, gx10-qwen, …) plus the built-in DeepSeek route. The file is
// re-read per `augmentor/models` request, so a DSH app settings edit lands in
// the sidecar's picker without a reload, and the two never drift.
const dshHome = () => process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh')

// The clone's yaml parser (the bridge itself stays dependency-free): the
// direct node_modules entry first, then the pnpm store layout.
function yamlLib() {
  const req = createRequire(import.meta.url)
  const candidates = [path.join(CLONE, 'node_modules', 'yaml')]
  const pnpm = path.join(CLONE, 'node_modules', '.pnpm')
  if (existsSync(pnpm)) {
    for (const dir of readdirSync(pnpm)) {
      if (dir.startsWith('yaml@')) candidates.push(path.join(pnpm, dir, 'node_modules', 'yaml'))
    }
  }
  for (const dir of candidates) {
    try {
      return req(path.join(dir, 'dist', 'index.js'))
    } catch {
      /* next candidate */
    }
  }
  throw new Error('yaml package not found under the DSH clone (node_modules/yaml)')
}

// Built-in DeepSeek catalog when the settings carry no `llm-deepseek.models`
// override: mirrors dsh-llm-deepseek's DEFAULT_MODELS (adapter.ts).
const DEEPSEEK_ROUTE = 'deepseek-official'
const DEFAULT_DEEPSEEK_MODELS = [
  { provider: DEEPSEEK_ROUTE, model: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
  { provider: DEEPSEEK_ROUTE, model: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { provider: DEEPSEEK_ROUTE, model: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp' },
]

/**
 * Read the DSH app's model set for the extension's picker.
 * @returns {{groups: Array<object>, default: {provider: string, model: string} | null, error?: string}}
 *   groups in settings.yaml order (local routes first, DeepSeek last);
 *   default is the first model, so the sidecar's default is the DSH app's
 *   first-configured model.
 */
function loadModelCatalog() {
  const groups = []
  let error
  try {
    const YAML = yamlLib()
    const file = path.join(dshHome(), 'settings.yaml')
    const settings = existsSync(file) ? (YAML.parse(readFileSync(file, 'utf8')) ?? {}) : {}
    const providers = settings['llm-pi-ai']?.providers
    if (providers && typeof providers === 'object') {
      for (const [route, profile] of Object.entries(providers)) {
        const models = Array.isArray(profile?.models) ? profile.models : []
        if (!models.length) continue
        groups.push({
          provider: route,
          name: typeof profile?.displayName === 'string' && profile.displayName ? profile.displayName : route,
          models: models
            .filter((m) => typeof m?.id === 'string' && m.id)
            .map((m) => ({
              provider: route,
              model: m.id,
              name: typeof m.name === 'string' && m.name ? m.name : m.id,
            })),
        })
      }
    }
    const dsModels = Array.isArray(settings['llm-deepseek']?.models)
      ? settings['llm-deepseek'].models
          .filter((m) => typeof m?.id === 'string' && m.id)
          .map((m) => ({
            provider: DEEPSEEK_ROUTE,
            model: m.id,
            name: typeof m.name === 'string' && m.name ? m.name : m.id,
          }))
      : DEFAULT_DEEPSEEK_MODELS
    groups.push({ provider: DEEPSEEK_ROUTE, name: 'DeepSeek', models: dsModels })
  } catch (e) {
    error = String(e?.message ?? e)
  }
  const flat = groups.flatMap((g) => g.models)
  return { groups, default: flat[0] ?? null, ...error ? { error } : {} }
}

// ------------------------------------------------------- native framing
const CHUNK = 4
let pending = Buffer.alloc(0)
const pendingClientRequests = new Map() // id -> {method, t}
const pendingBrowserReqs = new Map() // id -> {resolve, reject, timer}
let browserSeq = 0

function sendFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(payload.length)
  process.stdout.write(Buffer.concat([len, payload]))
}

// The selection the live runtime process was initialized with (null before the
// first initialize). switchModel compares against it: a same-selection switch
// is a no-op, a changed one restarts the process.
let initializedSelection = null
// Set while a switchModel restart is in flight; makes the old runtime's exit
// event a restart step instead of a bridge shutdown.
let restarting = false

/**
 * Serve `augmentor/switchModel`: validate the selection against the catalog,
 * then restart the runtime so the new model reaches the CURRENT session (the
 * SDK's initialize only re-points sessions created afterwards; a fresh process
 * re-creates the session from its persisted log on the new model). The Chrome
 * port is untouched — the extension re-sends initialize on the new process.
 */
function handleSwitchModel(frame) {
  const provider = frame.params?.provider
  const model = frame.params?.model
  const catalog = loadModelCatalog()
  const known = catalog.groups.some(
    (g) => g.provider === provider && g.models.some((m) => m.model === model),
  )
  if (!known) {
    trace('bridge', { event: 'switch-model-rejected', provider, model, error: catalog.error ?? 'unknown model' })
    sendFrame({
      id: frame.id,
      error: { code: -32602, message: catalog.error ? `model catalog: ${catalog.error}` : `unknown model: ${provider}/${model}` },
    })
    return
  }
  if (initializedSelection && initializedSelection.provider === provider && initializedSelection.model === model) {
    trace('bridge', { event: 'switch-model-noop', provider, model })
    sendFrame({ id: frame.id, result: { ok: true, changed: false } })
    return
  }
  trace('bridge', { event: 'switch-model-restart', from: initializedSelection, to: { provider, model } })
  restartRuntime()
    .then(() => sendFrame({ id: frame.id, result: { ok: true, changed: true } }))
    .catch((e) => {
      trace('bridge', { event: 'switch-model-failed', error: String(e?.message ?? e) })
      sendFrame({ id: frame.id, error: { code: -32000, message: String(e?.message ?? e) } })
      // A failed respawn leaves the bridge with no runtime: end it so the
      // extension's reconnect boots a clean pair.
      cleanup(1)
    })
}

function handleChromeFrame(frame) {
  // Request from the extension (initialize / session/prompt / shutdown, plus
  // the bridge-local model methods).
  if (frame.id !== undefined && frame.method !== undefined) {
    pendingClientRequests.set(frame.id, { method: frame.method, t: Date.now() - T0 })
    // Bridge-local: the DSH app's model catalog, never forwarded to the runtime.
    if (frame.method === 'augmentor/models') {
      const catalog = loadModelCatalog()
      trace('bridge', { event: 'models-served', groups: catalog.groups.map((g) => `${g.provider}:${g.models.length}`), error: catalog.error ?? null })
      sendFrame({ id: frame.id, result: catalog })
      return
    }
    // Bridge-local: restart the runtime for the new selection (see above).
    if (frame.method === 'augmentor/switchModel') {
      handleSwitchModel(frame)
      return
    }
    // The extension's initialize carries a synthetic cwd ('chrome-extension://…');
    // the runtime uses it as the bash tool's default workdir, and spawning in a
    // nonexistent directory surfaces as "spawn bash ENOENT". Pin it to the real
    // agent workdir so default-workdir commands work from any client.
    if (frame.method === 'initialize') {
      frame.params = { ...(frame.params ?? {}), cwd: WORKDIR }
      trace('bridge', { event: 'initialize-cwd-pinned', cwd: WORKDIR })
      initializedSelection = { provider: frame.params?.provider, model: frame.params?.model }
    }
    trace('chrome->runtime', frame)
    child.stdin.write(JSON.stringify(frame) + '\n')
    return
  }
  // Response to a browser/execute we sent.
  if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
    trace('extension->bridge (browser reply)', frame)
    const waiter = pendingBrowserReqs.get(frame.id)
    pendingBrowserReqs.delete(frame.id)
    if (waiter) {
      clearTimeout(waiter.timer)
      if (frame.error) waiter.reject(new Error(frame.error.message ?? JSON.stringify(frame.error)))
      else waiter.resolve(frame.result)
    }
    return
  }
  // Unsolicited notification from the extension (unused in Augmentor).
  trace('chrome->bridge (unhandled)', frame)
}

process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= CHUNK) {
    const len = pending.readUInt32LE(0)
    if (pending.length < CHUNK + len) break
    const raw = pending.subarray(CHUNK, CHUNK + len).toString('utf8')
    pending = pending.subarray(CHUNK + len)
    let frame
    try {
      frame = JSON.parse(raw)
    } catch (e) {
      trace('chrome->bridge (bad frame)', { error: String(e), raw: raw.slice(0, 200) })
      continue
    }
    handleChromeFrame(frame)
  }
})
process.stdin.on('end', () => {
  trace('chrome->bridge', { event: 'stdin-end' })
  cleanup(1)
})

// --------------------------------------------------- browser relay (HTTP)
const httpServer = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/browser') {
    res.writeHead(404).end()
    return
  }
  if (req.headers['x-augmentor-secret'] !== SECRET) {
    res.writeHead(403).end(JSON.stringify({ ok: false, error: 'bad secret' }))
    return
  }
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > 1e6) req.destroy()
  })
  req.on('end', () => {
    let params
    try {
      params = JSON.parse(body)
    } catch (e) {
      res.writeHead(400).end(JSON.stringify({ ok: false, error: `invalid JSON: ${e.message}` }))
      return
    }
    const id = `b${++browserSeq}`
    trace('runtime->extension (browser/execute)', { id, params })
    const sent = Date.now()
    sendFrame({ id, method: 'browser/execute', params })
    const timer = setTimeout(() => {
      pendingBrowserReqs.delete(id)
      res.writeHead(504).end(JSON.stringify({ ok: false, error: 'browser action timed out (120s)' }))
    }, 120000)
    pendingBrowserReqs.set(id, {
      resolve: (result) => {
        trace('extension->runtime (browser result)', { id, ms: Date.now() - sent, result })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...result }))
      },
      reject: (e) => {
        trace('extension->runtime (browser error)', { id, ms: Date.now() - sent, error: e.message })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      },
      timer,
    })
  })
})

// ------------------------------------------------------------- runtime
let child
let cleanedUp = false
function cleanup(code) {
  if (cleanedUp) return
  cleanedUp = true
  try {
    httpServer.close()
  } catch {
    /* ignore */
  }
  if (child && !child.killed) child.kill('SIGTERM')
  process.exit(code)
}

const nodeDir = path.dirname(process.execPath)
const RESTART_KILL_TIMEOUT_MS = 5000

// Spawn the JSON-RPC runtime child (first boot or after a model switch).
// Same composition and environment every time: the selected model travels in
// the initialize params, not in the process environment.
function spawnRuntime() {
  const port = httpServer.address().port
  child = spawn(process.execPath, [RUNTIME_BIN, CORDIS_YML], {
    cwd: BASE,
    env: {
      // Launching-shell env wins over augmentor/.env (Node loadEnvFile
      // semantics: the file only fills names the process env lacks) — the
      // DASH_* keys a user exports in the shell that launches Chrome beat
      // the .env placeholders, matching the DSH credentials layering.
      ...dotenv,
      ...process.env,
      // The runtime's bash tool must find `node` and `dsh-browser`.
      // Chrome hands native hosts a scrubbed environment (no shell PATH),
      // so always append the standard system dirs — never trust inherited.
      PATH: `${BASE}${path.sep}bin${path.delimiter}${nodeDir}${path.delimiter}${process.env.PATH ?? ''}${path.delimiter}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      DSH_CWD: WORKDIR,
      DSH_SYSTEM_PROMPT: persona,
      DSH_SESSION_ROOT: SESSION_ROOT,
      DSH_BROWSER_BRIDGE: `http://127.0.0.1:${port}`,
      DSH_BROWSER_SECRET: SECRET,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  trace('bridge', { event: 'spawn-runtime', bin: RUNTIME_BIN, config: CORDIS_YML, trace: TRACE })

  let runtimeLineBuf = ''
  child.stdout.on('data', (chunk) => {
    runtimeLineBuf += chunk.toString('utf8')
    let nl
    while ((nl = runtimeLineBuf.indexOf('\n')) !== -1) {
      const line = runtimeLineBuf.slice(0, nl)
      runtimeLineBuf = runtimeLineBuf.slice(nl + 1)
      if (!line.trim()) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch (e) {
        trace('runtime->chrome (bad line)', { error: String(e), line: line.slice(0, 200) })
        continue
      }
      trace('runtime->chrome', frame)
      sendFrame(frame)
    }
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim()
    if (text) trace('runtime-stderr', { text: text.slice(0, 2000) })
  })

  child.on('exit', (code, signal) => {
    if (restarting) {
      // Part of a deliberate model switch: restartRuntime() owns this exit.
      trace('bridge', { event: 'restart-old-runtime-exit', code, signal })
      return
    }
    trace('bridge', { event: 'runtime-exit', code, signal })
    cleanup(code ?? 0)
  })
}

/**
 * Kill the current runtime and spawn a fresh one. Resolves when the new
 * process is spawned (its stdin is pipe-buffered, so the extension's follow-up
 * initialize can be sent immediately — the runtime consumes it once booted).
 * @returns {Promise<void>}
 */
function restartRuntime() {
  if (restarting) return Promise.reject(new Error('runtime restart already in progress'))
  restarting = true
  return new Promise((resolve, reject) => {
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, RESTART_KILL_TIMEOUT_MS)
    const onExit = () => {
      clearTimeout(force)
      restarting = false
      try {
        spawnRuntime()
        resolve()
      } catch (e) {
        reject(e)
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      // Already dead: nothing to wait for.
      clearTimeout(force)
      restarting = false
      try {
        spawnRuntime()
        resolve()
      } catch (e) {
        reject(e)
      }
      return
    }
    child.once('exit', onExit)
    try {
      child.kill('SIGTERM')
    } catch (e) {
      clearTimeout(force)
      child.removeListener('exit', onExit)
      restarting = false
      reject(e)
    }
  })
}

httpServer.listen(0, '127.0.0.1', () => {
  const port = httpServer.address().port
  // The harness scrubs ALL DSH_* (and credential-shaped) env vars before the
  // bash tool's spawn (dsh-subprocess scrubbedParentEnv), so env cannot carry
  // the relay coordinates. The shim resolves this file relative to itself.
  writeFileSync(path.join(BASE, '.browser-endpoint'), JSON.stringify({ url: `http://127.0.0.1:${port}`, secret: SECRET }))
  trace('bridge', { event: 'browser-relay-listening', port })
  spawnRuntime()
})

process.on('SIGTERM', () => cleanup(0))
process.on('SIGINT', () => cleanup(130))
