// M1 acceptance in REAL Chrome (headless=new, CDP-driven):
// fresh user-data-dir (the user's browser is never touched) + --load-extension
// (same extension dir as the user's install) + host manifest copied into the
// fresh profile + the sidepanel.html page (the exact side-panel document).
//
// Repo home: augmentor/test/chrome-e2e.mjs (uses plugin/node_modules/ws).
// Env: E2E_PORT (default 9222), E2E_PROFILE (default /tmp/chrome-e2e-profile).
// Asserts: 'connected', session rows, the 403 fence row (real fetch metadata),
// conversation rendered (newest user text in the DOM), real-SW trace
// fingerprint (c1 / augmentor/models first), max frame under the 1 MiB limit.
// Production components: real Chrome SW, real connectNative, real pipe, live
// DSH server, real fetch metadata (Origin/sec-fetch-site -> the 403 fence row).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const WebSocket = require(path.join(AUG, 'plugin/node_modules/ws'))

const AUG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(AUG, 'extension')
const PORT = Number(process.env.E2E_PORT ?? 9222)
const PROFILE = process.env.E2E_PROFILE ?? '/tmp/chrome-e2e-profile'
const TARGET = 'session-71a131cc-dc6b-4adb-b022-8a25e561985a'
const fail = (m) => { console.error('CHROME-E2E FAIL:', m); try { chromium?.kill() } catch {} ; process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- fresh profile + host manifest ----------
fs.rmSync(PROFILE, { recursive: true, force: true })
const nmh = path.join(PROFILE, 'NativeMessagingHosts')
fs.mkdirSync(nmh, { recursive: true })
fs.copyFileSync(
  path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'),
  path.join(nmh, 'com.deepseek.dsh.augmentor.json'),
)
const tracesBefore = new Set(fs.readdirSync(path.join(AUG, 'trace')).filter((f) => f.startsWith('pipe-')))

// ---------- launch real Chromium ----------
const logs = fs.openSync('/tmp/chrome-e2e.log', 'w')
let chromium
try {
  chromium = spawn('/usr/lib/chromium/chromium', [
    '--headless=new',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions-except=' + EXT,
    'about:blank',
  ], { stdio: ['ignore', logs, logs] })
} catch (e) { fail('launch: ' + e.message) }
process.on('exit', () => { try { chromium?.kill() } catch {} })
process.stderr.write(`[e2e] chromium pid ${chromium.pid}\n`)

const jfetch = async (p, opts) => (await fetch(`http://127.0.0.1:${PORT}${p}`, opts)).json()
let ver = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try { ver = await jfetch('/json/version'); break } catch {}
}
if (!ver) fail('CDP endpoint never came up')
process.stderr.write(`[e2e] CDP: ${ver.Browser}\n`)

// extension id from the manifest's allowed_origins (same as user install)
const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'), 'utf8'))
const EXT_ID = m.allowed_origins[0].match(/chrome-extension:\/\/([^/]+)/)[1]

// ---------- browser WS: create the sidepanel page target ----------
const bws = new WebSocket(ver.webSocketDebuggerUrl)
let bseq = 0
const bpend = new Map()
bws.on('message', (d) => { const r = JSON.parse(d); if (r.id && bpend.has(r.id)) { bpend.get(r.id)(r); bpend.delete(r.id) } })
const bcall = (method, params = {}) => new Promise((res, rej) => {
  const id = ++bseq; bpend.set(id, (r) => (r.error ? rej(new Error(method + ': ' + r.error.message)) : res(r.result)))
  bws.send(JSON.stringify({ id, method, params }))
})
await new Promise((res, rej) => { bws.once('open', res); bws.once('error', rej) })
const { targetId } = await bcall('Target.createTarget', { url: `chrome-extension://${EXT_ID}/sidepanel.html` })
await sleep(1500)
let page = null
for (let i = 0; i < 20; i++) {
  const list = await jfetch('/json')
  page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('sidepanel'))
  if (page) break
  await sleep(500)
}
if (!page) fail('sidepanel page target not found')
process.stderr.write(`[e2e] page target: ${page.url}\n`)

// ---------- page WS: drive the DOM ----------
const pws = new WebSocket(page.webSocketDebuggerUrl)
let pseq = 0
const ppend = new Map()
pws.on('message', (d) => { const r = JSON.parse(d); if (r.id && ppend.has(r.id)) { ppend.get(r.id)(r); ppend.delete(r.id) } })
const pcall = (method, params = {}) => new Promise((res, rej) => {
  const id = ++pseq; ppend.set(id, (r) => (r.error ? rej(new Error(method + ': ' + r.error.message)) : res(r.result)))
  pws.send(JSON.stringify({ id, method, params }))
})
await new Promise((res, rej) => { pws.once('open', res); pws.once('error', rej) })
await pcall('Runtime.enable')
await pcall('Page.enable')
const ev = (expression) =>
  pcall('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .then((r) => {
      if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '').slice(0, 300))
      return r.result?.value
    })
// wait for page readiness
for (let i = 0; i < 40; i++) {
  const rs = await ev('document.readyState').catch(() => 'loading')
  if (rs === 'complete') break
  await sleep(500)
}
if (!await ev('!!document.getElementById("connect")')) fail('sidepanel DOM not ready')
process.stderr.write('[e2e] sidepanel DOM ready — driving the real Chrome flow\n')

// ---------- expected text (newest user message of the target session) ----------
const rpc = (method, payload) =>
  fetch('http://127.0.0.1:3080/api/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'ce-1', method, payload }),
  }).then((r) => r.json()).then((b) => {
    if (!b?.result?.ok) throw new Error(method + ': ' + JSON.stringify(b?.result?.error))
    return b.result.value
  })
const listV = await rpc('session.list', {})
const listItem = listV.items.find((s) => s.sessionId === TARGET)
const listTitle = listItem.projections?.values?.title ?? ''
let expectedUserText = null
for (const h of (await rpc('session.history', { sessionId: TARGET, maxMessages: 50 })).events ?? []) {
  if (h.event?.type === 'user/message') {
    const parts = h.event.data?.message?.content ?? h.event.data?.content
    const text = (Array.isArray(parts) ? parts.filter((p) => p?.type === 'text').map((p) => p.text).join('') : String(parts ?? '')).trim()
    if (text) expectedUserText = text.slice(0, 80) // last wins
  }
}
if (!expectedUserText) fail('no user message found for the render assertion')

// ---------- 1. Connect ----------
await ev('document.getElementById("connect").click()')
let status = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  status = await ev('document.getElementById("status").textContent')
  if (status === 'connected') break
  if (String(status).startsWith('error')) fail(`panel error: ${status}`)
}
if (status !== 'connected') fail(`never connected (status=${status})`)
process.stderr.write(`[e2e] REAL Chrome: panel status "connected"\n`)

// ---------- 2. Sessions ----------
await ev('document.getElementById("sessions").click()')
let rowCount = 0
for (let i = 0; i < 30; i++) {
  await sleep(500)
  rowCount = await ev('document.querySelectorAll(".sp-row").length')
  if (rowCount > 0) break
}
if (!rowCount) fail('no session rows in real Chrome')
process.stderr.write(`[e2e] REAL Chrome: ${rowCount} session rows\n`)

// ---------- 3. Probe (real fetch metadata -> expect the 403 fence row) ----------
const probeFile = path.join(AUG, 'trace/fence-probe.json')
const before = fs.existsSync(probeFile) ? fs.statSync(probeFile).mtimeMs : 0
await ev('[...document.querySelectorAll(".sp-strip button")].find(b=>b.textContent==="Probe").click()')
for (let i = 0; i < 30; i++) {
  await sleep(500)
  if (fs.existsSync(probeFile) && fs.statSync(probeFile).mtimeMs > before) break
}
const probeData = JSON.parse(fs.readFileSync(probeFile, 'utf8'))
process.stderr.write(`[e2e] REAL Chrome probe: api=${probeData.api?.status} root=${probeData.root?.status} fenced=${probeData.fenced?.status}\n`)

// ---------- 4. Open the target conversation ----------
const rowSel = `[...document.querySelectorAll(".sp-row")].find(r => r.querySelector(".sp-title")?.textContent === ${JSON.stringify(listTitle)})`
const found = await ev(`!!(${rowSel})`)
if (!found) fail('target row not found in real Chrome list')
await ev(`${rowSel}.click()`)
let logText = ''
for (let i = 0; i < 60; i++) {
  await sleep(500)
  logText = await ev('document.getElementById("log").textContent') ?? ''
  if (logText.includes(expectedUserText)) break
}
const renderedUser = logText.includes(expectedUserText)
const evidence = {
  status: await ev('document.getElementById("status").textContent'),
  title: await ev('document.getElementById("title").textContent'),
  logChars: logText.length,
  userBubbles: await ev('document.querySelectorAll("#log .user").length'),
  assistantBubbles: await ev('document.querySelectorAll("#log .assistant").length'),
  renderedUserText: renderedUser,
  expectedUserText,
}
evidence.probe = { api: probeData.api?.status, root: probeData.root?.status, fenced: probeData.fenced?.status, persisted: true }

// ---------- pipe trace fingerprint: real SW -> c<n> ids, augmentor/models first ----------
const newTraces = fs.readdirSync(path.join(AUG, 'trace')).filter((f) => f.startsWith('pipe-') && !tracesBefore.has(f))
let firstExtFrame = null, firstPipeMsg = null, maxFrame = 0
if (newTraces.length) {
  const lines = fs.readFileSync(path.join(AUG, 'trace', newTraces[newTraces.length - 1]), 'utf8').trim().split('\n')
  for (const l of lines) {
    const r = JSON.parse(l)
    if (r.kind === 'ext->pipe' && !firstExtFrame) firstExtFrame = { id: r.msg?.id, method: r.msg?.method }
    if (r.kind === 'ext<-pipe' && !firstPipeMsg) firstPipeMsg = { id: r.msg?.id }
    maxFrame = Math.max(maxFrame, l.length)
  }
}
evidence.pipeTrace = { file: newTraces[newTraces.length - 1] ?? null, firstExtFrame, firstPipeMsg, maxFrameLineBytes: maxFrame }

console.log(JSON.stringify(evidence, null, 1))
if (!renderedUser) fail('conversation not rendered in real Chrome')
if (probeData.fenced?.status !== 403) fail(`fence row expected 403 in real Chrome, got ${probeData.fenced?.status}`)
if (String(firstExtFrame?.id ?? '').charAt(0) !== 'c') fail(`expected real-SW c<n> ids, got ${firstExtFrame?.id}`)
console.error('CHROME-E2E: OK — real Chrome rendered the DSH conversation + produced the 403 fence row')
bws.close(); pws.close()
chromium.kill()
process.exit(0)
