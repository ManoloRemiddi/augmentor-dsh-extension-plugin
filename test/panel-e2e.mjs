// M1 exit proof, headless: REAL sidepanel.js + chat-render.js (ES modules in
// jsdom) + REAL sw.js (vm) + REAL pipe (host-manifest spawn) + live DSH server.
//
// Repo home: augmentor/test/panel-e2e.mjs — deps: `cd test && npm i`
// (jsdom + marked; test/package.json). The panel code under test is the
// unmodified extension module graph; the SW is the unmodified sw.js.
// Emulated: only the chrome.* surfaces (connectNative bridged to the spawned
// pipe; SW<->panel messages bridged; one shared storage.local Map).
// Flow: wait for the SW's auto-connect (top-level ensurePort; no button) ->
// wait 'connected' -> click #sessions -> click Probe (asserts pipe persisted)
// -> send a unique marker prompt -> assert the user bubble + assistant prose
// rendered into #log -> reopen the session from the popover and assert the
// history replay -> archive the probe session.
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
// panel -> SW: exactly what chrome.runtime.sendMessage does in Chrome.
// The sender mirrors real Chrome for the extension's OWN pages (id +
// chrome-extension:// url) — sw.js validates the sender (audit S5), so the
// shim must be Chrome-faithful or every message is (correctly) dropped.
const panelSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/sidepanel.html`, tab: { id: 1 } }
function swDispatch(msg) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const ok = swHandler(msg, panelSender, done)
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
// 0.1.17: the header's "connected" status text was removed (the panel is
// auto-connected; no persistent readout). Readiness is observed through the
// send button, which updateChrome enables only when phase === 'ready'.
const sendReady = () => !doc.getElementById('send').disabled

// ---------- 1. Auto-connect (the real sw.js connects at vm-boot) ----------
let waited = 0
while (!sendReady() && waited < 30000) {
  await sleep(250); waited += 250
}
if (!sendReady()) fail('panel never reached ready (send button stayed disabled)')
process.stderr.write(`[harness] panel ready: send enabled (after ${waited}ms)\n`)

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

// ---------- 4. Send a unique marker prompt; assert the conversation renders ----------
// Drift-free target: the old version pinned a hardcoded live session, and once
// that session fell outside the popover's 20-row window the row matcher picked
// the WRONG row and asserted text from a session that was never opened. Now
// the test creates its own session with a unique marker (same pattern as
// m3-e2e), so the render assertion can only be true for the conversation this
// run actually sent.
const rpc = (method, payload) =>
  fetch('http://127.0.0.1:3080/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rt-1', method, payload }),
  }).then((r) => r.json()).then((b) => {
    if (!b?.result?.ok) throw new Error(method + ': ' + JSON.stringify(b?.result?.error))
    return b.result.value
  })
const MARKER = 'PANEL_E2E_OK_' + Math.random().toString(36).slice(2, 10)
const PROMPT = `${MARKER} — reply with exactly one line: OK`
const idsBefore = new Set((await rpc('session.list', {})).items.map((s) => s.sessionId))
doc.getElementById('input').value = PROMPT
await doc.getElementById('send').click()
process.stderr.write(`[harness] prompt sent: ${JSON.stringify(MARKER)}\n`)
// The user bubble paints immediately; the assistant reply proves the full
// downlink path, including the md() render of assistant text.
waited = 0
let logText = ''
while (waited < 120000) {
  await sleep(500); waited += 500
  logText = doc.getElementById('log')?.textContent ?? ''
  const prose = [...doc.querySelectorAll('#log .msg.assistant .md')].map((n) => n.textContent || '').join('')
  if (logText.includes(MARKER) && prose.trim()) break
}
const renderedUser = logText.includes(MARKER)
const assistantBubbles = doc.querySelectorAll('#log .assistant').length
const userBubbles = doc.querySelectorAll('#log .user').length
const titleText = doc.getElementById('title')?.textContent
process.stderr.write(
  `[harness] log: ${logText.length} chars, user=${userBubbles} assistant=${assistantBubbles} title="${titleText}" userTextRendered=${renderedUser}\n`,
)

// ---------- 4b. Reopen the session from the popover (row click -> history replay) ----------
// The list captured in step 2 predates the new session: close and reopen.
await doc.getElementById('sessions').click() // close
await sleep(300)
await doc.getElementById('sessions').click() // reopen, fresh list
let targetRow = null
waited = 0
while (!targetRow && waited < 10000) {
  await sleep(250); waited += 250
  targetRow =
    [...doc.querySelectorAll('.sp-row')].find(
      (r) => (r.querySelector('.sp-title')?.textContent ?? '').includes(MARKER),
    ) ?? null
}
if (!targetRow) fail('new session row (marker title) not in reopened popover')
await targetRow.click()
process.stderr.write(`[harness] clicked row: title="${targetRow.querySelector('.sp-title')?.textContent}"\n`)
let replayText = ''
waited = 0
while (waited < 30000) {
  await sleep(500); waited += 500
  replayText = [...doc.querySelectorAll('#log .msg.assistant .md')].map((n) => n.textContent || '').join('\n')
  if (replayText.trim()) break
}
if (!replayText.trim()) fail('history replay rendered no assistant prose')
process.stderr.write(`[harness] history replay: ${replayText.trim().length} chars of assistant prose\n`)

// ---------- 4c. Cleanup: archive the probe session (the sweep's end state) ----------
const idsAfter = new Set((await rpc('session.list', {})).items.map((s) => s.sessionId))
const newIds = [...idsAfter].filter((id) => !idsBefore.has(id))
if (newIds.length !== 1) fail(`expected exactly one new session, got ${JSON.stringify(newIds)}`)
const SID = newIds[0]
await rpc('workspace.archiveSession', { sessionId: SID })
const archived = (await rpc('workspace.list', {})).archivedSessionIds ?? []
if (!archived.includes(SID)) fail('probe session not archived', archived)
process.stderr.write(`[harness] cleanup: ${SID} archived\n`)

const out = {
  status: sendReady() ? 'ready' : 'not-ready',
  sessionRows: rows.length,
  probe: { api: probeData.api?.status, root: probeData.root?.status, fenced: probeData.fenced?.status, persisted: true },
  marker: MARKER,
  session: { id: SID, archived: true },
  rendered: {
    logChars: logText.length,
    userBubbles,
    assistantBubbles,
    title: titleText,
    userTextRendered: renderedUser,
    historyReplayChars: replayText.trim().length,
  },
  maxPipeFrameBytes: maxFrame,
  under1MiB: maxFrame < 1024 * 1024,
}
console.log(JSON.stringify(out, null, 1))
if (!renderedUser || logText.length < 200) fail(`conversation not visibly rendered (logChars=${logText.length}, userTextRendered=${renderedUser})`)
console.error('RENDER: OK — a DSH conversation is visible in the (headless) Augmentor panel')
try { pipe.kill() } catch {}
process.exit(0)
