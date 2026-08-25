// M1 exit proof, headless: REAL sidepanel.js + chat-render.js (ES modules in
// jsdom) + REAL sw.js (vm) + REAL pipe (host-manifest spawn) + live DSH server.
//
// Repo home: augmentor/test/panel-e2e.mjs — deps: `cd test && npm i`
// (jsdom + marked; test/package.json). The panel code under test is the
// unmodified extension module graph; the SW is the unmodified sw.js.
// Emulated: only the chrome.* surfaces (connectNative bridged to the spawned
// pipe; SW<->panel messages bridged; one shared storage.local Map).
// Flow: click #connect -> wait 'connected' -> click #sessions -> click Probe
// (asserts pipe persisted) -> click the target session row -> assert the
// conversation's text rendered into #log.
import { spawn } from 'node:child_process'
import vm from 'node:vm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const markedNpm = (await import('marked')).marked

const AUG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(AUG, 'extension')
const MANIFEST =
  process.env.NMH_MANIFEST ??
  path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json')
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const EXT_ID = m.allowed_origins?.[0]?.match(/chrome-extension:\/\/([^/]+)/)?.[1]
const TARGET = process.env.TARGET_SESSION ?? 'session-71a131cc-dc6b-4adb-b022-8a25e561985a'
const fail = (msg) => { console.error('RENDER FAIL:', msg); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- pipe (spawned as Chrome would) ----------
const pipe = spawn(m.path, [`chrome-extension://${EXT_ID}/`], { stdio: ['pipe', 'pipe', 'pipe'] })
let pipeBuf = Buffer.alloc(0)
let maxFrame = 0
const portListeners = { onMessage: [], onDisconnect: [] }
function pipeSend(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8')
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length)
  pipe.stdin.write(Buffer.concat([h, b]))
}
pipe.stdout.on('data', (d) => {
  pipeBuf = Buffer.concat([pipeBuf, d])
  while (pipeBuf.length >= 4) {
    const len = pipeBuf.readUInt32LE(0)
    if (pipeBuf.length < 4 + len) return
    const msg = JSON.parse(pipeBuf.subarray(4, 4 + len).toString('utf8'))
    pipeBuf = pipeBuf.subarray(4 + len)
    maxFrame = Math.max(maxFrame, 4 + len)
    for (const fn of portListeners.onMessage) fn(msg)
  }
})
pipe.stderr.on('data', (d) => {
  const s = d.toString()
  if (/starting|shaped|ready|error|ERROR|closed|exited/.test(s)) process.stderr.write('[pipe] ' + s)
})
pipe.on('exit', (c) => process.stderr.write(`[pipe] exited ${c}\n`))

// ---------- shared storage (Chrome storage.local is one store) ----------
const storage = new Map()
const storageShim = {
  local: {
    get: (_k, cb) => cb({}),
    set: (obj, cb) => { for (const [k, v] of Object.entries(obj)) storage.set(k, v); cb && cb() },
  },
  onChanged: { addListener: () => {} },
}

// ---------- SW (real sw.js in a vm) ----------
const swRuntimeListeners = []
let panelEvtListener = null
const swChrome = {
  runtime: {
    id: EXT_ID,
    lastError: undefined,
    connectNative: (host) => { process.stderr.write(`[shim] connectNative(${host})\n`); return fakePort },
    onMessage: { addListener: (fn) => swRuntimeListeners.push(fn) },
    // SW -> panel: in Chrome this reaches the panel's runtime.onMessage
    sendMessage: (msg) => { panelEvtListener?.(msg, {}); return Promise.resolve() },
  },
  sidePanel: { setPanelBehavior: () => {}, setOptions: () => {} },
  storage: storageShim,
  tabs: {
    query: (_q, cb) => cb([]), get: (_i, cb) => cb(undefined), create: (_p, cb) => cb({ id: 999 }),
    update: (id, _p, cb) => cb && cb({ id }),
    onActivated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} }, Tab: {},
  },
  windows: { getLastFocused: (_w, cb) => cb({ id: 1 }) },
  scripting: { executeScript: (_i, cb) => cb && cb([]) },
}
const fakePort = {
  onMessage: { addListener: (fn) => portListeners.onMessage.push(fn) },
  onDisconnect: { addListener: (fn) => portListeners.onDisconnect.push(fn) },
  postMessage: (o) => pipeSend(o),
  disconnect: () => { try { pipe.kill() } catch {} },
}
const swSandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  crypto, URL, TextEncoder, TextDecoder, fetch,
  chrome: swChrome,
  self: { location: { origin: `chrome-extension://${EXT_ID}` } },
}
let swCtx
swSandbox.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), swCtx)
swCtx = vm.createContext(swSandbox)
vm.runInContext(fs.readFileSync(path.join(EXT, 'sw.js'), 'utf8'), swCtx)
if (swRuntimeListeners.length === 0) fail('sw.js registered no runtime.onMessage listener')
const swHandler = swRuntimeListeners[swRuntimeListeners.length - 1]
// panel -> SW: exactly what chrome.runtime.sendMessage does in Chrome
function swDispatch(msg) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const ok = swHandler(msg, { tab: { id: 1 } }, done)
    if (ok === true) setTimeout(() => done(undefined), 30000)
    else done(undefined)
  })
}

// ---------- panel (real sidepanel.js in jsdom) ----------
const dom = new JSDOM(fs.readFileSync(path.join(EXT, 'sidepanel.html'), 'utf8'), {
  // jsdom's localStorage rejects the chrome-extension: scheme (opaque origin);
  // the scheme is irrelevant to the code under test
  url: 'http://localhost/sidepanel.html',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const { window } = dom
const panelListeners = []
const panelChrome = {
  runtime: {
    id: EXT_ID,
    lastError: undefined,
    sendMessage: (msg) => swDispatch(msg),
    onMessage: { addListener: (fn) => panelListeners.push(fn) },
  },
  storage: storageShim,
}
// theme-tokens.js (classic IIFE -> globalThis.__dshAugTheme), as in the HTML
// (vm.runInThisContext — Node 24.19's V8 chokes on the `(0, eval)(...)`
// source pattern; see proposal §10 V8 note)
vm.runInThisContext(fs.readFileSync(path.join(EXT, 'theme-tokens.js'), 'utf8'))
globalThis.window = window
globalThis.document = window.document
globalThis.MutationObserver = window.MutationObserver
globalThis.localStorage = window.localStorage
globalThis.location = window.location
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((cb) => setTimeout(cb, 16))
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) ?? clearTimeout
globalThis.chrome = panelChrome
window.marked = markedNpm // chat-render.js: window.marked.parse(...)
window.dispatchEvent(new window.Event('DOMContentLoaded'))
await import(path.join(EXT, 'sidepanel.js'))
// route SW broadcasts to the panel's 'evt' listener
for (const fn of panelListeners) panelEvtListener = fn
process.stderr.write(`[harness] panel imported; listeners: panel=${panelListeners.length} sw=${swRuntimeListeners.length}\n`)

const doc = window.document
const statusText = () => doc.getElementById('status')?.textContent

// ---------- 1. Connect ----------
await doc.getElementById('connect').click()
let waited = 0
while (!['connected'].includes(statusText()) && waited < 30000) {
  if (statusText()?.startsWith('error')) fail(`panel error state: ${statusText()}`)
  await sleep(250); waited += 250
}
if (statusText() !== 'connected') fail(`panel never reached 'connected' (got: ${statusText()})`)
process.stderr.write(`[harness] panel status: connected (after ${waited}ms)\n`)

// ---------- 2. Sessions popover ----------
await doc.getElementById('sessions').click()
waited = 0
let rows = doc.querySelectorAll('.sp-row')
while (rows.length === 0 && waited < 15000) {
  if (doc.querySelector('.sp-strip.err')) fail('session list error: ' + doc.querySelector('.sp-strip.err').textContent)
  await sleep(250); waited += 250
  rows = doc.querySelectorAll('.sp-row')
}
if (!rows.length) fail('no session rows rendered')
process.stderr.write(`[harness] sessions popover: ${rows.length} rows\n`)

// ---------- 3. Probe (before opening a session; strip lives in the popover) ----------
const probeFile = path.join(AUG, 'trace/fence-probe.json')
const before = fs.existsSync(probeFile) ? fs.statSync(probeFile).mtimeMs : 0
const probeBtn = [...doc.querySelectorAll('.sp-strip button')].find((b) => b.textContent === 'Probe')
if (!probeBtn) fail('Probe button not in popover')
await probeBtn.click()
waited = 0
while (waited < 15000) {
  await sleep(250); waited += 250
  if (fs.existsSync(probeFile) && fs.statSync(probeFile).mtimeMs > before) break
}
if (!fs.existsSync(probeFile) || fs.statSync(probeFile).mtimeMs <= before) fail('probe did not persist a fresh fence-probe.json')
const probeData = JSON.parse(fs.readFileSync(probeFile, 'utf8'))
process.stderr.write(`[harness] probe persisted: api=${probeData.api?.status} root=${probeData.root?.status} fenced=${probeData.fenced?.status} origin=${probeData.origin}\n`)

// ---------- 4. Open the target conversation ----------
// expected text: first user message of the target session (raw API, no shaping —
// user messages always survive shaping)
const rpc = (method, payload) =>
  fetch('http://127.0.0.1:3080/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rt-1', method, payload }),
  }).then((r) => r.json()).then((b) => {
    if (!b?.result?.ok) throw new Error(method + ': ' + JSON.stringify(b?.result?.error))
    return b.result.value
  })
// the NEWEST user message — shaping keeps the newest events, so it must render
let expectedUserText = null
for (const h of (await rpc('session.history', { sessionId: TARGET, maxMessages: 50 })).events ?? []) {
  const ev = h.event
  if (ev?.type === 'user/message') {
    const parts = ev.data?.message?.content ?? ev.data?.content
    const text = (Array.isArray(parts) ? parts.filter((p) => p?.type === 'text').map((p) => p.text).join('') : String(parts ?? '')).trim()
    if (text) expectedUserText = text.slice(0, 80) // keep going; last one wins
  }
}
if (!expectedUserText) fail('could not find a user message in the target session for the render assertion')

// match the target row by its title/cwd (rows carry sp-title text + title=cwd)
const listItem = (await rpc('session.list', {})).items.find((s) => s.sessionId === TARGET)
if (!listItem) fail('target session not in session.list')
const row = [...rows].find((r) =>
  (r.querySelector('.sp-title')?.textContent ?? '') === (listItem.projections?.values?.title ?? '')
  || (r.getAttribute('title') ?? '') === (listItem.cwd ?? '')
) ?? [...rows].at(-1)
if (!row) fail('no row matched the target session')
await row.click()
process.stderr.write(`[harness] clicked row: title="${row.querySelector('.sp-title')?.textContent}"\n`)

waited = 0
let logText = ''
while (waited < 30000) {
  await sleep(500); waited += 500
  logText = doc.getElementById('log')?.textContent ?? ''
  if (logText.includes(expectedUserText)) break
}
const renderedUser = logText.includes(expectedUserText)
const renderedMsgCount = doc.querySelectorAll('#log .msg, #log .user, #log .assistant, #log [class*="bubble"]').length
const assistantBubbles = doc.querySelectorAll('#log .assistant').length
const userBubbles = doc.querySelectorAll('#log .user').length
const titleText = doc.getElementById('title')?.textContent
process.stderr.write(
  `[harness] log: ${logText.length} chars, user=${userBubbles} assistant=${assistantBubbles} title="${titleText}" userTextRendered=${renderedUser}\n`,
)

const out = {
  status: statusText(),
  sessionRows: rows.length,
  probe: { api: probeData.api?.status, root: probeData.root?.status, fenced: probeData.fenced?.status, persisted: true },
  target: TARGET,
  rendered: {
    logChars: logText.length,
    userBubbles,
    assistantBubbles,
    title: titleText,
    expectedUserText,
    userTextRendered: renderedUser,
  },
  maxPipeFrameBytes: maxFrame,
  under1MiB: maxFrame < 1024 * 1024,
}
console.log(JSON.stringify(out, null, 1))
if (!renderedUser || logText.length < 200) fail(`conversation not visibly rendered (logChars=${logText.length}, userTextRendered=${renderedUser})`)
console.error('RENDER: OK — a DSH conversation is visible in the (headless) Augmentor panel')
try { pipe.kill() } catch {}
process.exit(0)
