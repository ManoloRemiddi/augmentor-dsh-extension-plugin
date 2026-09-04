#!/usr/bin/env node

// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// install-proof.mjs — deterministic proof of the documented install journey.
//
// It runs a FRESH USER on a throwaway machine:
//
//   1. free port + temp work dir
//   2. git clone --depth 1 of the public repo (PROOF_REPO)
//   3. isolated DSH_HOME (never touches the runner's real ~/.dsh),
//      token handled exactly like a real install
//   4. `dsh web` boot — the CLI seeds the `web` profile from npm
//   5. `dsh plugin --profile web add <repo>/plugin` (PROOF_SOURCE=local)
//      or `dsh plugin --profile web add dsh-augmentor` (PROOF_SOURCE=npm,
//      requires the current dist to be published)
//   6. live-mount probe: is the plugin picked up WITHOUT an app restart?
//      (recorded, not asserted — copy must match the recorded fact)
//   7. real Chromium loads the unpacked extension; the REAL extension id
//      is read from the fresh profile (path-derived on Linux)
//   8. the DOCUMENTED ./install-native-host.sh <id> <config-dir> runs
//   9. app + Chrome restart
//   10. full chain: poll the plugin handshake until pipes: 1
//       (Chrome -> NativeMessagingHost -> pipe.mjs -> token-gated WS -> plugin)
//   11. handshake asserts (version == source version, token gating, preset)
//   12. optional LLM leg (PROOF_LLM=1): a real agent session drives the
//       headless browser via browser_navigate/browser_tabs_list and the
//       CDP target list proves the page really navigated.
//
// No npm dependencies (node: builtins only). Env:
//   PROOF_REPO    repo url/path to clone (default: the public GitHub repo)
//   PROOF_SOURCE  local (default) | npm
//   CHROME_BIN    chromium binary (default /usr/lib/chromium/chromium)
//   PROOF_PORT    fixed app port (default: any free port)
//   PROOF_LLM     1 = run the LLM browser leg (needs LLM credentials in env)
//   PROOF_KEEP    1 = keep the work dir (and leave logs for inspection)
//
// Exit 0 = every leg passed. The user's real ~/.dsh is only ever read
// (token / LLM config symlinks), never written.

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import {
  mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync,
  existsSync, readdirSync, openSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'

// ------------------------------------------------------------ config
const REPO = process.env.PROOF_REPO ?? 'https://github.com/ManoloRemiddi/augmentor-dsh-extension-plugin'
const SOURCE = process.env.PROOF_SOURCE === 'npm' ? 'npm' : 'local'
const CHROME_BIN = process.env.CHROME_BIN ?? '/usr/lib/chromium/chromium'
const WANT_LLM = process.env.PROOF_LLM === '1'
const KEEP = process.env.PROOF_KEEP === '1'
const REAL_HOME = homedir()
const ISOLATED_HOME = path.join(tmpdir(), `augmentor-proof-${process.pid}-home`)
const WORK = path.join(tmpdir(), `augmentor-proof-${process.pid}`)
const REPO_DIR = path.join(WORK, 'repo')
const CHROME_DIR = path.join(WORK, 'chrome')
const NODE = process.execPath
const DSH_BIN = execFileSync('sh', ['-c', 'command -v dsh || true'], { encoding: 'utf8' }).trim() || 'dsh'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + 's'

const results = []
const ok = (step, note) => { results.push({ step, ok: true, note }) ; console.log(`  [PASS] ${step}${note ? ' — ' + note : ''} (${elapsed()})`) }
const rec = (step, note) => { results.push({ step, ok: true, note, record: true }) ; console.log(`  [RECORD] ${step} — ${note} (${elapsed()})`) }
const fail = (step, note) => { results.push({ step, ok: false, note }) ; console.error(`  [FAIL] ${step} — ${note} (${elapsed()})`) ; cleanup() ; printTable() ; process.exit(1) }
const skip = (step, note) => { results.push({ step, ok: true, note, skipped: true }) ; console.log(`  [SKIP] ${step} — ${note}`) }

const children = []
function track(proc, label) { children.push({ proc, label }) ; return proc }
function cleanup() {
  for (const { proc, label } of children) {
    try { process.kill(-proc.pid, 'SIGTERM') } catch {}
    console.log(`cleanup: killed ${label} (pid ${proc.pid})`)
  }
  if (!KEEP) { try { rmSync(WORK, { recursive: true, force: true }) ; rmSync(ISOLATED_HOME, { recursive: true, force: true }) } catch {} }
  else console.log(`cleanup: kept ${WORK} and ${ISOLATED_HOME}`)
}
process.on('exit', printTable)
process.on('uncaughtException', (e) => {
  results.push({ step: `unexpected crash: ${e.message.slice(0, 120)}`, ok: false, note: 'see log above' })
  cleanup()
  printTable()
  process.exit(1)
})
let printed = false
function printTable() {
  if (printed) return
  printed = true
  if (!results.length) return
  console.log('\n================ INSTALL PROOF ================')
  for (const r of results)
    console.log(`  ${r.ok ? (r.skipped ? 'SKIP ' : r.record ? 'RECORD ' : 'PASS ') : 'FAIL '}  ${r.step}${r.note ? '  (' + r.note + ')' : ''}`)
  const failed = results.some((r) => !r.ok)
  console.log(`  => ${failed ? 'INSTALL PROOF: FAIL' : 'INSTALL PROOF: PASS'}  (total ${elapsed()})`)
  console.log('=============================================')
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const p = s.address().port ; s.close(() => res(p)) })
  s.on('error', rej)
})

// authCookie (declared in step 4) is read at call time — only the LLM leg
// (step 12) calls this, always after the first boot has authenticated.
const rpc = (base, method, payload) => fetch(`${base}/api/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(authCookie ? { cookie: authCookie } : {}) },
  body: JSON.stringify({ type: 'client-request', rpcId: `proof-${randomBytes(6).toString('hex')}`, method, payload }),
}).then(async (res) => {
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.type !== 'server-response' || !body.result?.ok)
    throw new Error(`${method}: ${JSON.stringify(body?.result?.error ?? body ?? res.status).slice(0, 300)}`)
  return body.result.value
})

// ============================================================ 1. port
const PORT = Number(process.env.PROOF_PORT) || await freePort()
const CDP_PORT = await freePort()
ok('free port', `app :${PORT}, cdp :${CDP_PORT}`)

// ============================================================ 2. clone
rmSync(WORK, { recursive: true, force: true })
rmSync(ISOLATED_HOME, { recursive: true, force: true })
mkdirSync(ISOLATED_HOME, { recursive: true })
execFileSync('git', ['clone', '--quiet', '--depth', '1', REPO, REPO_DIR], { stdio: 'pipe' })
const HEAD = execFileSync('git', ['-C', REPO_DIR, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim()
ok('git clone (fresh user copy)', HEAD.slice(0, 40))

// ============================================================ 3. isolated home
// Token: real install reads $HOME/.dsh/augmentor-ws-token (the pipe uses the
// real HOME env; the plugin uses $DSH_HOME). Mirror that exactly:
//   - real token exists -> symlink it into the isolated home (same bytes)
//   - no real token     -> generate one in the isolated home and export
//     DSH_AUGMENTOR_WS_TOKEN into the app AND Chrome env (env wins in pipe)
const realToken = path.join(REAL_HOME, '.dsh', 'augmentor-ws-token')
const appEnv = { ...process.env, DSH_HOME: ISOLATED_HOME }
const chromeEnv = { ...process.env, DSH_AUGMENTOR_URL: `http://127.0.0.1:${PORT}` }
if (existsSync(realToken)) {
  symlinkSync(realToken, path.join(ISOLATED_HOME, 'augmentor-ws-token'))
  ok('isolated DSH_HOME + token', 'real token symlinked (read-only)')
} else {
  const tok = randomBytes(16).toString('hex')
  const f = path.join(ISOLATED_HOME, 'augmentor-ws-token')
  writeFileSync(f, tok, { mode: 0o600 })
  appEnv.DSH_AUGMENTOR_WS_TOKEN = tok
  chromeEnv.DSH_AUGMENTOR_WS_TOKEN = tok
  ok('isolated DSH_HOME + token', 'generated 0600 token (no real home), env-injected')
}
// LLM leg needs the model config + persona preset roster (read-only symlinks)
for (const f of ['settings.yaml', '.anonymous-user-id', '.agent-presets']) {
  const src = path.join(REAL_HOME, '.dsh', f)
  const dst = path.join(ISOLATED_HOME, f)
  if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst)
}

// ============================================================ 4. boot dsh web
const appLog = path.join(WORK, 'dsh-app.log')
const appLogFd = openSync(appLog, 'a')
const app = track(spawn(DSH_BIN, ['web', '--no-open', '--port', String(PORT)], {
  env: appEnv, detached: true, stdio: ['ignore', appLogFd, appLogFd],
}), 'dsh app')
// ---- DSH 0.1.2 web auth -------------------------------------------------
// DSH 0.1.2+ gates `dsh web` behind a bootstrap token: a bare GET / returns
// 401 ("dsh web authentication required"), and the token printed in the
// banner URL (`dsh web: http://…/?token=…`) is exchanged for a session
// cookie (303 + Set-Cookie dsh-auth-…). Older DSH serves / open. On the old
// DSH authCookie stays null and every probe below degrades to a plain
// fetch; on 0.1.2+ the first 401 triggers the exchange and the cookie then
// rides along. (Releases #5/#6 of v0.1.31 failed on this: the app was up
// and listening, but the bare-`/` 200 probe could never see past the 401.)
let authCookie = null
const appFetch = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: authCookie ? { cookie: authCookie } : {} })
async function exchangeBannerToken() {
  try {
    const log = readFileSync(appLog, 'utf8')
    const hits = log.match(/token=([A-Za-z0-9_-]+)/g)
    if (!hits) return
    const r = await fetch(`http://127.0.0.1:${PORT}/?token=${hits.at(-1).slice(6)}`, { redirect: 'manual' }).catch(() => null)
    const sc = r?.status === 303 ? r.headers.get('set-cookie') : null
    if (sc) authCookie = sc.split(',')[0] // name=value (the cookie value carries no comma)
  } catch {}
}

let up = false
// 300 s grace (150 × 2 s): a fresh runner's first `dsh web` boot seeds the
// web profile from npm and can be slow under registry latency; a crashed
// boot bails early via app.exitCode, so a slow seed is what this window is
// for.
for (let i = 0; i < 150; i++) {
  const r = await appFetch('/').catch(() => null)
  if (r?.status === 200) { up = true ; break }
  if (r?.status === 401) await exchangeBannerToken() // 0.1.2+: the app is up — exchange, retry
  if (app.exitCode !== null) break
  await sleep(2000)
}
if (!up) { console.error(readFileSync(appLog, 'utf8').slice(-2000)) ; fail('dsh web boot (fresh DSH_HOME)', 'never served / — see dsh-app.log') }
ok('dsh web boot (fresh DSH_HOME, profile seeded from npm)', `GET / 200${authCookie ? ' (0.1.2 token-gated)' : ''}`)

// ============================================================ 5. install plugin
const tAdd = Date.now()
// npm path spec: bare name by default; PROOF_NPM_SPEC can pin a version
// (pnpm >= 11 enforces a 24h minimum-release-age by default and SILENTLY
// falls back to the newest version that passes — right after a publish the
// documented bare spec can land on the PREVIOUS release; the check below
// catches that in seconds instead of at plugin load 200s later)
const npmSpec = process.env.PROOF_NPM_SPEC || 'dsh-augmentor'
const addArgs = SOURCE === 'npm' ? [npmSpec] : [path.join(REPO_DIR, 'plugin')]
execFileSync(DSH_BIN, ['plugin', '--profile', 'web', 'add', ...addArgs], { env: appEnv, stdio: 'pipe' })
const addedIn = ((Date.now() - tAdd) / 1000).toFixed(1) + 's'
const pluginPkg = JSON.parse(readFileSync(path.join(REPO_DIR, 'plugin', 'package.json'), 'utf8'))
ok(`dsh plugin --profile web add ${SOURCE === 'npm' ? `${npmSpec} (registry)` : '<clone>/plugin (local dir)'}`, addedIn)
if (SOURCE === 'npm' && !process.env.PROOF_NPM_SPEC) {
  const installed = JSON.parse(readFileSync(path.join(ISOLATED_HOME, 'profiles', 'web', 'node_modules', 'dsh-augmentor', 'package.json'), 'utf8')).version
  const published = execFileSync('npm', ['view', 'dsh-augmentor', 'version'], { encoding: 'utf8' }).trim()
  if (installed !== published)
    fail('npm spec resolved to previous release', `profile has dsh-augmentor@${installed} but the registry latest is ${published} — pnpm's 24h minimum-release-age gate fell back. Re-run with PROOF_NPM_SPEC='dsh-augmentor@${published}' (pin), or wait for the release to age past 24h.`)
}

// ============================================================ 6. live-mount probe
let liveMount = false
for (let i = 0; i < 8 && !liveMount; i++) {
  try { liveMount = (await appFetch('/api/augmentor')).status === 200 } catch {}
  await sleep(2000)
}
rec('live-mount probe (no restart)', liveMount ? 'true — app hot-mounted the plugin' : 'false — plugin composes at app boot (restart required)')

// ============================================================ 7. Chrome + extension
const chromeFlags = [
  '--headless=new',
  `--user-data-dir=${CHROME_DIR}`,
  `--remote-debugging-port=${CDP_PORT}`,
  `--load-extension=${path.join(REPO_DIR, 'extension')}`,
  '--disable-extensions-except=' + path.join(REPO_DIR, 'extension'),
  '--no-first-run', '--no-default-browser-check',
  '--disable-dev-shm-usage', // CI runners have a 64MB /dev/shm; Chrome crashes without this
  '--no-sandbox', // disposable proof browser: the sandbox proves nothing about the
  // documented flow, and CI runners' playwright build has no setuid sandbox
  // helper — without this flag Chrome FATALs at startup on ubuntu-latest
  'about:blank',
]
const chromeLog = path.join(WORK, 'chrome.log')
const chromeLogFd = openSync(chromeLog, 'a')
let chrome = track(spawn(CHROME_BIN, chromeFlags, { env: chromeEnv, detached: true, stdio: ['ignore', chromeLogFd, chromeLogFd] }), 'chromium')
// real unpacked id: read from the fresh profile. ANCHOR ON THE PATH — the
// settings entry of an unpacked extension carries its absolute load path, so
// match the exact directory we passed to --load-extension. Never pick the
// first [a-p]{32} id: the Chrome-for-Testing builds (Playwright's CI
// chromium) ship a Chrome-Web-Store component extension (web_store,
// location 5) into the profile BEFORE our unpacked one, and its id would
// poison the NMH manifest's allowed_origins -> connectNative denied ->
// pipes=0, while the log stays silent (access denials land in the SW
// console, not chrome's stderr).
const extLoadDir = path.join(REPO_DIR, 'extension')
let extId = ''
for (let i = 0; i < 60 && !extId; i++) {
  if (!existsSync(CHROME_DIR)) { await sleep(1000) ; continue }
  for (const prof of readdirSync(CHROME_DIR).filter((d) => d === 'Default' || d.startsWith('Profile'))) {
    const pf = path.join(CHROME_DIR, prof, 'Preferences')
    if (!existsSync(pf)) continue
    try {
      const p = JSON.parse(readFileSync(pf, 'utf8'))
      extId = Object.entries(p?.extensions?.settings ?? {})
        .find(([id, v]) => /^[a-p]{32}$/.test(id) && v?.path && path.resolve(String(v.path)) === extLoadDir)?.[0] ?? ''
    } catch {}
    if (extId) break
  }
  await sleep(1000)
}
if (!extId) {
  // A crashed Chrome writes a FATAL dump: the reason line sits near the top
  // of the dump, not at its tail — surface FATAL/Check-failed lines + tail.
  const diag = (() => {
    if (!existsSync(chromeLog)) return '(no chrome log)'
    const lines = readFileSync(chromeLog, 'utf8').split('\n')
    const fatal = lines.map((l, i) => (/FATAL|Check failed|# Fatal|Running as root without|--no-sandbox|sandbox/.test(l) ? i : -1)).filter((i) => i >= 0)
    const ctx = fatal.length ? lines.slice(Math.max(0, fatal[0] - 2), fatal[0] + 10).join('\n') + '\n…\n' : ''
    return ctx + lines.slice(-10).join('\n')
  })()
  fail('chromium + unpacked extension', `no extension id in fresh profile — chrome log:\n${diag}`)
}
ok('chromium + unpacked extension (real id from fresh profile)', extId)

// ============================================================ 8. documented installer
const manifest = path.join(CHROME_DIR, 'NativeMessagingHosts', 'com.deepseek.dsh.augmentor.json')
execFileSync('sh', [path.join(REPO_DIR, 'install-native-host.sh'), extId, CHROME_DIR], { stdio: 'pipe', env: { ...process.env } })
if (!existsSync(manifest) || !existsSync(path.join(REPO_DIR, 'bin', 'pipe-host.sh')))
  fail('install-native-host.sh', 'manifest or launcher missing')
const m = JSON.parse(readFileSync(manifest, 'utf8'))
if (!m.allowed_origins?.includes(`chrome-extension://${extId}/`))
  fail('install-native-host.sh', 'manifest allowed_origins does not carry the real extension id')
ok('install-native-host.sh <id> <chrome-user-data-dir>', 'manifest + launcher + deps')

// ============================================================ 9. restart app + Chrome
for (const { proc } of children) { try { process.kill(-proc.pid, 'SIGTERM') } catch {} }
// the old app must actually release the port before the new one binds —
// otherwise the 200s in the polls below come from the DYING (plugin-less) app
const portFree = () => new Promise((res) => {
  const s = createServer()
  s.once('error', () => res(false))
  s.once('listening', () => { s.close(() => res(true)) })
  s.listen(PORT, '127.0.0.1')
})
for (let i = 0; i < 20 && !(await portFree()); i++) {
  if (i === 12) for (const { proc } of children) { try { process.kill(-proc.pid, 'SIGKILL') } catch {} }
  await sleep(1000)
}
if (!(await portFree())) fail('app + chromium restart', `old app still holds port ${PORT}`)
const app2 = track(spawn(DSH_BIN, ['web', '--no-open', '--port', String(PORT)], {
  env: appEnv, detached: true, stdio: ['ignore', appLogFd, appLogFd],
}), 'dsh app (restart)')
chrome = track(spawn(CHROME_BIN, chromeFlags, { env: chromeEnv, detached: true, stdio: ['ignore', chromeLogFd, chromeLogFd] }), 'chromium (restart)')
authCookie = null // a restarted app re-signs the session cookie — exchange fresh
for (let i = 0; i < 45; i++) {
  const r = await appFetch('/').catch(() => null)
  if (r?.status === 200) break
  if (r?.status === 401) await exchangeBannerToken()
  await sleep(2000)
}
ok('app + chromium restart', 'relaunched on a free port')

// ============================================================ 10. full chain: pipes: 1
let hs = null
const tChain = Date.now()
for (let i = 0; i < 60; i++) {
  try {
    const r = await appFetch('/api/augmentor')
    if (r.status === 200) { hs = await r.json() ; if (hs.pipes >= 1) break }
  } catch {}
  await sleep(2000)
}
const appTail = () => existsSync(appLog) ? '\napp log tail:\n' + readFileSync(appLog, 'utf8').split('\n').slice(-15).join('\n') : ''
if (!hs) fail('full chain (Chrome→NMH→pipe→plugin)', 'no handshake after restart' + appTail())
if (hs.pipes < 1) {
  // A dead transport usually announces itself once, early (native-messaging
  // spawn/access error) — the log TAIL is GCM/dbus noise. Surface every
  // line that looks like the actual problem, then the tail.
  const diag = (() => {
    if (!existsSync(chromeLog)) return '(no chrome log)'
    const lines = readFileSync(chromeLog, 'utf8').split('\n')
    const hits = lines
      .map((l, i) => [i, l])
      .filter(([, l]) => /native|host|FATAL|Check failed|Cannot find|ENOENT|EACCES|EPERM|error.*launch|launch.*error|access denied/i.test(l))
      .filter(([, l]) => !/gcm|dbus|dbus|registration_request|vkCreateInstance|VulkanError|maxDynamic/i.test(l))
      .slice(0, 25)
      .map(([i, l]) => `L${i + 1}: ${l}`)
      .join('\n')
    return (hits ? hits + '\n…\n' : '(no suspicious lines — full tail follows)\n') + lines.slice(-10).join('\n')
  })()
  fail('full chain (Chrome→NMH→pipe→plugin)', `pipes=${hs.pipes} — chrome log:\n${diag}${appTail()}`)
}
ok('full chain: handshake pipes: 1', `${((Date.now() - tChain) / 1000).toFixed(1)}s (Chrome→NMH→pipe.mjs→WS→plugin)`)

// ============================================================ 11. handshake asserts
const problems = []
if (hs.wsTokenRequired !== true) problems.push(`wsTokenRequired=${hs.wsTokenRequired}`)
if (SOURCE === 'npm') {
  const pub = execFileSync('npm', ['view', 'dsh-augmentor', 'version'], { encoding: 'utf8' }).trim()
  if (hs.version !== pub) problems.push(`handshake v${hs.version} != published v${pub}`)
} else if (hs.version !== pluginPkg.version) problems.push(`handshake v${hs.version} != repo v${pluginPkg.version}`)
if (hs.agentPreset !== 'augmentor') problems.push(`agentPreset=${hs.agentPreset}`)
if (!hs.chatCwd) problems.push('chatCwd missing')
if (hs.wsPath !== '/api/augmentor/ws') problems.push(`wsPath=${hs.wsPath}`)
if (problems.length) fail('handshake asserts', problems.join('; '))
ok('handshake asserts', `v${hs.version}, token-gated, preset=${hs.agentPreset}, chatCwd=${hs.chatCwd}`)

// ============================================================ 12. optional LLM leg
if (!WANT_LLM) {
  skip('LLM browser leg', 'PROOF_LLM=1 to run it (needs LLM credentials in env)')
} else {
  const SID = `proof-${randomBytes(4).toString('hex')}`
  try {
    await rpc(`http://127.0.0.1:${PORT}`, 'session.create', { sessionId: SID, cwd: hs.chatCwd, agentPreset: 'augmentor' })
    const acc = await rpc(`http://127.0.0.1:${PORT}`, 'session.prompt', {
      sessionId: SID, mode: 'queue',
      content: [{ type: 'text', text: 'Use the browser_navigate tool to open https://example.com . Then call browser_tabs_list . Reply with one line: the URL of the active tab.' }],
    })
    if (acc?.accepted !== true) fail('LLM browser leg', `prompt not accepted: ${JSON.stringify(acc)}`)
    let assistantText = ''
    let turnDone = false
    for (let i = 0; i < 90 && !turnDone; i++) {
      await sleep(2000)
      const h = await rpc(`http://127.0.0.1:${PORT}`, 'session.history', { sessionId: SID })
      for (const e of h.events ?? []) {
        const ev = e.event
        if (ev.type === 'assistant/message') {
          for (const c of ev.data?.message?.content ?? []) if (c.type === 'text') assistantText += c.text
        }
        if (ev.type === 'turn/end') turnDone = true
      }
    }
    if (!turnDone) fail('LLM browser leg', 'turn did not complete in 180s')
    if (!assistantText.includes('example.com')) fail('LLM browser leg', `agent reply lacks example.com: ${assistantText.slice(0, 200)}`)
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
    if (!targets.some((t) => String(t.url).includes('example.com')))
      fail('LLM browser leg', `CDP targets never show example.com: ${JSON.stringify(targets.map((t) => t.url))}`)
    ok('LLM browser leg (real agent drove the real browser)', `reply: ${assistantText.trim().slice(0, 60)}`)
  } catch (e) {
    fail('LLM browser leg', e.message)
  }
}

cleanup()
printTable()
process.exit(0)
