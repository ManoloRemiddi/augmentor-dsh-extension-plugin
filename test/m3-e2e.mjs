// M3 slice-1 acceptance in REAL Chrome (headless=new, CDP-driven): the panel's
// Save button works end to end against the LIVE DSH server and the real
// registry — the boot test proves the wire on a fresh copy; this proves the
// panel + SW + pipe chain on the user's actual deployment.
//
// Fresh user-data-dir (the user's browser is never touched) + --load-extension
// (same extension dir) + host manifest + the sidepanel.html page. The
// extension spawns its own NMH pipe (the plugin admits many pipes).
//
// Flow: connect -> assert the M3 buttons exist -> send one prompt (the live
// default model is the local Qwen — no CloudFront) -> identify the new
// ~/Augmentor session -> tap #save (badge flips, workspace.list shows the
// attach) -> tap again (badge clears, detach) -> #openindsh (new target at
// the app endpoint) -> cleanup: archive the probe session (the 14-day sweep's
// end state, immediate).
//
// Repo home: augmentor/test/m3-e2e.mjs (uses plugin/node_modules/ws).
// Env: E2E_PORT (default 9226), E2E_PROFILE (default /tmp/chrome-m3-profile),
//      DSH_BASE (default http://127.0.0.1:3080), M3_PROMPT.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const AUG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(AUG, 'extension')
const WebSocket = require(path.join(AUG, 'plugin/node_modules/ws'))

const PORT = Number(process.env.E2E_PORT ?? 9226)
const PROFILE = process.env.E2E_PROFILE ?? '/tmp/chrome-m3-profile'
const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const CHATDIR = path.join(os.homedir(), 'Augmentor')
const PROMPT = process.env.M3_PROMPT ?? 'Reply with exactly one line: M3 OK'
const MARKER = 'M3 OK'
const fail = (m) => { console.error('M3-E2E FAIL:', m); try { chromium?.kill() } catch {} ; process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- DSH /api client (same envelope the pipe uses) ----------
const rpc = (method, payload) =>
  fetch(`${BASE}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `m3e2e-${Math.random().toString(36).slice(2)}`, method, payload }),
  }).then((r) => r.json()).then((b) => {
    if (!b?.result?.ok) throw new Error(method + ': ' + JSON.stringify(b?.result?.error ?? b))
    return b.result.value
  })

// ---------- fresh profile + host manifest ----------
fs.rmSync(PROFILE, { recursive: true, force: true })
const nmh = path.join(PROFILE, 'NativeMessagingHosts')
fs.mkdirSync(nmh, { recursive: true })
fs.copyFileSync(
  path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'),
  path.join(nmh, 'com.deepseek.dsh.augmentor.json'),
)

// ---------- launch real Chromium ----------
const logs = fs.openSync('/tmp/chrome-m3.log', 'w')
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
process.stderr.write(`[m3] chromium pid ${chromium.pid}\n`)

const jfetch = async (p, opts) => (await fetch(`http://127.0.0.1:${PORT}${p}`, opts)).json()
let ver = null
for (let i = 0; i < 60; i++) { await sleep(500); try { ver = await jfetch('/json/version'); break } catch {} }
if (!ver) fail('CDP endpoint never came up')
process.stderr.write(`[m3] CDP: ${ver.Browser}\n`)

const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json'), 'utf8'))
const EXT_ID = m.allowed_origins[0].match(/chrome-extension:\/\/([^/]+)/)[1]

// ---------- browser WS: sidepanel target ----------
const bws = new WebSocket(ver.webSocketDebuggerUrl)
let bseq = 0
const bpend = new Map()
bws.on('message', (d) => { const r = JSON.parse(d); if (r.id && bpend.has(r.id)) { bpend.get(r.id)(r); bpend.delete(r.id) } })
const bcall = (method, params = {}) => new Promise((res, rej) => {
  const id = ++bseq; bpend.set(id, (r) => (r.error ? rej(new Error(method + ': ' + r.error.message)) : res(r.result)))
  bws.send(JSON.stringify({ id, method, params }))
})
await new Promise((res, rej) => { bws.once('open', res); bws.once('error', rej) })
await bcall('Target.createTarget', { url: `chrome-extension://${EXT_ID}/sidepanel.html` })
await sleep(1500)
let page = null
for (let i = 0; i < 20; i++) {
  const list = await jfetch('/json')
  page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('sidepanel'))
  if (page) break
  await sleep(500)
}
if (!page) fail('sidepanel page target not found')
process.stderr.write(`[m3] page target: ${page.url}\n`)

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
for (let i = 0; i < 40; i++) {
  const rs = await ev('document.readyState').catch(() => 'loading')
  if (rs === 'complete') break
  await sleep(500)
}
if (!await ev('!!document.getElementById("connect")')) fail('sidepanel DOM not ready')
process.stderr.write('[m3] sidepanel DOM ready\n')

// ---------- 1. Connect (real SW + NMH pipe + live server) ----------
await ev('document.getElementById("connect").click()')
let status = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  status = await ev('document.getElementById("status").textContent')
  if (status === 'connected') break
  if (String(status).startsWith('error')) fail(`panel error: ${status}`)
}
if (status !== 'connected') fail(`never connected (status=${status})`)
process.stderr.write('[m3] connected (real SW + pipe + live server)\n')

// ---------- 2. The M3 buttons exist (new panel shipped) ----------
if (!await ev('!!document.getElementById("save")')) fail('#save button missing — stale panel?')
if (!await ev('!!document.getElementById("openindsh")')) fail('#openindsh button missing — stale panel?')
process.stderr.write('[m3] M3 buttons present (#save, #openindsh)\n')

// ---------- 3. Snapshot ~/Augmentor sessions, then send one prompt ----------
const augmSessions = () =>
  rpc('session.list', {}).then((v) => (v.items ?? []).filter((s) => s.cwd === CHATDIR).map((s) => s.sessionId))
const before = new Set(await augmSessions())
await ev(`(function(){ const i = document.getElementById('input'); i.value = ${JSON.stringify(PROMPT)}; document.getElementById('send').click(); return true })()`)
process.stderr.write(`[m3] prompt sent: ${JSON.stringify(PROMPT)}\n`)
let reply = null
for (let i = 0; i < 90; i++) {
  await sleep(2000)
  const t = (await ev('document.getElementById("log").textContent')) ?? ''
  if (t.includes(MARKER)) { reply = t; break }
}
if (!reply) fail('no assistant reply in real Chrome (agent broken?)')
// turn settled (Send visible again)
let settled = false
for (let i = 0; i < 30; i++) { await sleep(1000); if (await ev('!document.getElementById("send").hidden')) { settled = true; break } }
process.stderr.write(`[m3] reply rendered (${reply.length} chars, settled=${settled})\n`)

// ---------- 4. The SW created the session IN ~/Augmentor (cwd pinning) ----------
const after = new Set(await augmSessions())
const newIds = [...after].filter((id) => !before.has(id))
if (newIds.length !== 1) fail(`expected exactly one new ${CHATDIR} session, got ${JSON.stringify(newIds)} (before=${[...before]})`)
const SID = newIds[0]
process.stderr.write(`[m3] new session ${SID} in ${CHATDIR} (cwd pinning)\n`)

// ---------- 5. Tap #save -> badge + workspace attach ----------
const saveState = () => ev('(() => ({ text: document.getElementById("save").textContent, cls: document.getElementById("save").className }))()')
if ((await saveState()).text.trim() !== '☆ Save') fail('badge should start unsaved', await saveState())
await ev('document.getElementById("save").click()')
let savedUi = null
for (let i = 0; i < 20; i++) { await sleep(500); savedUi = await saveState(); if (savedUi.text.includes('Saved')) break }
if (!savedUi?.text.includes('Saved') || !String(savedUi?.cls).includes('saved')) fail('save badge did not flip', savedUi)
let row = ((await rpc('workspace.list', {})).items ?? []).find((w) => w.path === CHATDIR)
if (!row || row.title !== 'Augmentor Chat') fail('workspace row', row)
if (!(row.sessionIds ?? []).includes(SID)) fail('session not attached after panel Save', row)
process.stderr.write('[m3] SAVE: badge flipped + workspace.list shows the attach (real registry)\n')

// ---------- 6. Tap again -> unsave (detach, workspace survives) ----------
await ev('document.getElementById("save").click()')
let unsavedUi = null
for (let i = 0; i < 20; i++) { await sleep(500); unsavedUi = await saveState(); if (unsavedUi?.text.trim() === '☆ Save') break }
if (unsavedUi?.text.trim() !== '☆ Save') fail('unsave badge did not clear', unsavedUi)
row = ((await rpc('workspace.list', {})).items ?? []).find((w) => w.path === CHATDIR)
if (!row) fail('workspace vanished after unsave', row)
if ((row.sessionIds ?? []).includes(SID)) fail('session still attached after unsave', row)
process.stderr.write('[m3] UNSAVE: badge cleared + detach confirmed (workspace survives)\n')

// ---------- 7. #openindsh -> new target at the app endpoint (Option A) ----------
const targetsBefore = new Set((await jfetch('/json')).map((t) => t.url))
await ev('document.getElementById("openindsh").click()')
let opened = null
for (let i = 0; i < 20; i++) {
  await sleep(500)
  opened = (await jfetch('/json')).find((t) => !targetsBefore.has(t.url) && t.url.startsWith(BASE.replace(/\/$/, '') + '/'))
  if (opened) break
}
if (!opened) fail('#openindsh did not open the app endpoint', [...targetsBefore])
process.stderr.write(`[m3] OPEN-IN-DSH: new target ${opened.url}\n`)

// ---------- 8. Cleanup: archive the probe (the sweep's end state) ----------
await rpc('workspace.archiveSession', { sessionId: SID })
const archived = (await rpc('workspace.list', {})).archivedSessionIds ?? []
if (!archived.includes(SID)) fail('probe not archived', archived)
process.stderr.write(`[m3] cleanup: ${SID} archived (end state = swept chat)\n`)

// ---------- evidence ----------
console.log(JSON.stringify({
  status,
  buttons: { save: (await saveState()).text, openindsh: await ev('!!document.getElementById("openindsh")') },
  prompt: { marker: MARKER, replyChars: reply.length, settled },
  session: { id: SID, cwd: CHATDIR },
  save: { badge: '✓ Saved', attachedInWorkspaceList: true },
  unsave: { badge: '☆ Save', detachedInWorkspaceList: true },
  openInDsh: opened.url,
  cleanup: { archived: true },
}, null, 1))
console.error('M3-E2E: OK — panel Save/Unsave/Open-in-DSH works in real Chrome against the live deployment')
bws.close(); pws.close()
chromium.kill()
process.exit(0)
