#!/usr/bin/env node
/**
 * model-picker-verify.mjs — E2E verification of the Augmentor model picker
 * path, emulating the Chrome side exactly: it spawns `bridge.mjs` the way
 * Chromium's connectNative would and speaks the native-messaging wire
 * (4-byte LE length + JSON frames) on its stdio.
 *
 * Legs:
 *   1. `augmentor/models`      — the bridge serves the DSH app's catalog:
 *                                every llm-pi-ai route in $DSH_HOME/settings.yaml
 *                                (same models, same order) + the built-in
 *                                deepseek-official route (3 default models).
 *   2. unknown-model switch    — bridge-local rejection (-32602), never
 *                                forwarded to the runtime.
 *   3. initialize + prompt     — a local-model turn settles with the answer
 *                                (codeword BANANA remembered).
 *   4. same-selection switch   — no-op ({ok, changed:false}).
 *   5. switchModel → DeepSeek  — {ok, changed:true}: the bridge restarts the
 *                                runtime process (Chrome port stays up).
 *   6. re-initialize + prompt  — the SAME session id resumes from its
 *                                persisted log on the new model; the DeepSeek
 *                                model recalls the codeword (proves both the
 *                                resume and that the new model answers).
 *   7. switchModel → local     — back (changed:true), re-initialize, one
 *                                more local turn.
 *   8. shutdown                — runtime + bridge exit.
 *
 * Usage: node lab/model-picker-verify.mjs [--local]
 *   --local  skip the real DeepSeek API leg: the restart round-trip is
 *            exercised through the gx10 route instead, whose prompt is
 *            expected to END in a credentials error in this environment —
 *            which itself proves the new model took effect. Use when
 *            api.deepseek.com is unreachable.
 *
 * Cost: three turns on local llama.cpp + (full mode) one small DeepSeek API
 * call with the key from ~/.dsh/.credentials.yaml (a few cents).
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, unlinkSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLONE = path.resolve(BASE, '..', 'deepseek-harness')
const LOCAL_ONLY = process.argv.includes('--local')
const GLOBAL_TIMEOUT_MS = 8 * 60 * 1000
const SESSION_ID = `aug-verify-${Date.now().toString(36)}`

// ---------------------------------------------------------------- harness
let seq = 0
let buf = Buffer.alloc(0)
const pending = new Map() // id -> {resolve}
let turnEndSeq = 0
let lastTurnEnd = null
let lastAssistantText = ''
const turnEndWaiters = []
let bridgeExitResolve
const bridgeExit = new Promise((r) => { bridgeExitResolve = r })
const results = []

const bridge = spawn(process.execPath, [path.join(BASE, 'bridge.mjs')], {
  cwd: BASE,
  env: {
    ...process.env,
    // Deterministic local key even when the launching shell lacks one
    // (llama.cpp ignores auth; a real shell export wins when present — the
    // bridge's env merge keeps the process env on top).
    DASH_LOCAL_QWEN_KEY: process.env.DASH_LOCAL_QWEN_KEY ?? 'local-augmentor-key',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
bridge.on('exit', (code, signal) => bridgeExitResolve({ code, signal }))
let stderrTail = ''
bridge.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-2000) })

function check(name, cond, detail) {
  const pass = Boolean(cond)
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function writeFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(payload.length, 0)
  bridge.stdin.write(Buffer.concat([head, payload]))
}

function request(method, params, timeoutMs = 120000) {
  const id = `v${++seq}`
  writeFrame(params === undefined ? { id, method } : { id, method, params })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout after ${timeoutMs} ms: ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (frame) => {
        clearTimeout(timer)
        if (frame.error) reject(new Error(`${method}: ${frame.error.message ?? JSON.stringify(frame.error)}`))
        else resolve(frame.result)
      },
    })
  })
}

bridge.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) break
    const raw = buf.subarray(4, 4 + len).toString('utf8')
    buf = buf.subarray(4 + len)
    let frame
    try { frame = JSON.parse(raw) } catch { continue }
    // Response to one of our requests.
    if (frame.id !== undefined && pending.has(frame.id)) {
      pending.get(frame.id).resolve(frame)
      continue
    }
    // Server->client notification (session.event / session.status).
    if (frame.method === 'session.event' && frame.params?.sessionId === SESSION_ID) {
      const ev = frame.params.event
      if (ev?.type === 'assistant/message') {
        const text = (ev.data?.message?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
        if (text) lastAssistantText += (lastAssistantText ? '\n' : '') + text
      }
      if (ev?.type === 'turn/end') {
        turnEndSeq += 1
        lastTurnEnd = ev.data?.reason ?? { kind: 'unknown' }
        const waiters = turnEndWaiters.splice(0)
        for (const w of waiters) w()
      }
    }
  }
})

function waitTurnEnd(afterSeq, timeoutMs = 120000) {
  if (turnEndSeq > afterSeq) return Promise.resolve(lastTurnEnd)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = turnEndWaiters.indexOf(onEnd)
      if (i !== -1) turnEndWaiters.splice(i, 1)
      reject(new Error(`turn/end timeout after ${timeoutMs} ms`))
    }, timeoutMs)
    const onEnd = () => {
      clearTimeout(timer)
      resolve(lastTurnEnd)
    }
    turnEndWaiters.push(onEnd)
  })
}

async function promptTurn(text, timeoutMs = 120000) {
  const beforeSeq = turnEndSeq
  lastAssistantText = ''
  const t0 = Date.now()
  await request('session/prompt', { sessionId: SESSION_ID, contentBlocks: [{ type: 'text', text }] })
  const reason = await waitTurnEnd(beforeSeq, timeoutMs)
  const ms = Date.now() - t0
  const errDetail =
    reason?.kind === 'error'
      ? ` turn/error: ${reason.error?.message ?? JSON.stringify(reason.error ?? reason)}`
      : ''
  return { reason, ms, text: lastAssistantText, detail: `${Math.round(ms / 1000)} s${errDetail}` }
}

// ------------------------------------------------------------ settings read
function settingsProviders() {
  // Mirror the bridge's catalog source: the llm-pi-ai routes of
  // $DSH_HOME/settings.yaml (the document under test).
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const file = path.join(dshHome, 'settings.yaml')
  if (!existsSync(file)) return null
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
      const YAML = req(path.join(dir, 'dist', 'index.js'))
      const settings = YAML.parse(readFileSync(file, 'utf8')) ?? {}
      const providers = settings['llm-pi-ai']?.providers
      return providers && typeof providers === 'object' ? Object.entries(providers) : []
    } catch { /* next candidate */ }
  }
  throw new Error('yaml package not found under the DSH clone')
}

// ------------------------------------------------------------------- run
const watchdog = setTimeout(() => {
  console.log('FAIL  global watchdog (8 min) — killing the bridge')
  try { bridge.kill('SIGKILL') } catch { /* ignore */ }
  process.exit(1)
}, GLOBAL_TIMEOUT_MS)

try {
  console.log(`\naugmentor model-picker E2E — session ${SESSION_ID} (${LOCAL_ONLY ? 'LOCAL-ONLY' : 'FULL'} mode)\n`)

  // 1. Catalog: the DSH app's model set.
  const catalog = await request('augmentor/models', undefined, 15000)
  const groups = catalog?.groups ?? []
  check('catalog: served with groups', Array.isArray(groups) && groups.length > 0, JSON.stringify(catalog))
  const dsGroup = groups.find((g) => g.provider === 'deepseek-official')
  check('catalog: deepseek-official group with the 3 default models',
    dsGroup?.models?.length === 3
    && dsGroup.models.some((m) => m.model === 'deepseek-v4-flash')
    && dsGroup.models.some((m) => m.model === 'deepseek-v4-pro')
    && dsGroup.models.some((m) => m.model === 'deepseek-v4-flash-vision-exp'),
    JSON.stringify(dsGroup))
  // Mirror check: every llm-pi-ai route in the settings document appears,
  // with its models, in settings order.
  const providers = settingsProviders()
  if (providers) {
    const localGroups = groups.filter((g) => g.provider !== 'deepseek-official')
    check(`catalog: mirrors settings.yaml (${providers.map(([k]) => k).join(', ')})`,
      localGroups.length === providers.length
      && providers.every(([key, profile], i) => {
        const g = localGroups[i]
        if (!g || g.provider !== key) return false
        const wanted = (Array.isArray(profile.models) ? profile.models : []).filter((m) => m?.id)
        return wanted.length === g.models.length && wanted.every((m, j) => g.models[j]?.model === m.id)
      }),
      JSON.stringify({ settings: providers.map(([k, p]) => ({ k, models: p?.models?.map((m) => m.id) })), served: localGroups }))
  }
  check('catalog: default = first model of first group',
    catalog?.default && groups[0] && groups[0].models[0]
    && catalog.default.provider === groups[0].provider
    && catalog.default.model === groups[0].models[0].model,
    JSON.stringify(catalog?.default))
  const localSel = groups[0]?.models?.[0]
  if (!localSel || !dsGroup) throw new Error('catalog lacks the expected selections')

  // 2. Unknown model: bridge-local rejection (never reaches the runtime).
  let unknownErr
  try { await request('augmentor/switchModel', { provider: 'nope', model: 'none' }, 15000) } catch (e) { unknownErr = e }
  check('switchModel unknown model → -32602 error', /unknown model|model catalog/i.test(unknownErr?.message ?? ''), unknownErr?.message)

  // 3. Initialize on the local default (mirrors the SW handshake).
  const init1 = await request('initialize', {
    cwd: 'chrome-extension://augmentor',
    provider: localSel.provider,
    model: localSel.model,
  })
  check('initialize (local)', init1?.serverInfo?.name === 'deepseek-harness-sdk-runtime', JSON.stringify(init1))

  // 4. Local turn: remember a codeword.
  const t1 = await promptTurn('Remember the secret codeword BANANA. Reply with exactly: HELLO1')
  check('local turn: turn/end completed', t1.reason?.kind === 'completed', t1.detail)
  check('local turn: model answered HELLO1', t1.text.includes('HELLO1'), `assistant: ${JSON.stringify(t1.text.slice(0, 200))}`)

  // 5. Same-selection switch: no-op (the bridge knows the live selection).
  const noop = await request('augmentor/switchModel', { provider: localSel.provider, model: localSel.model }, 15000)
  check('switchModel same selection → {ok, changed:false}', noop?.ok === true && noop?.changed === false, JSON.stringify(noop))

  // 6. Switch to DeepSeek: the bridge restarts the runtime process.
  const switch1 = await request('augmentor/switchModel', { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  check('switchModel → DeepSeek: {ok, changed:true} (runtime restarted)', switch1?.ok === true && switch1?.changed === true, JSON.stringify(switch1))

  // 7. Re-initialize the fresh process with the new selection.
  const init2 = await request('initialize', {
    cwd: 'chrome-extension://augmentor',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  check('re-initialize (DeepSeek)', init2?.serverInfo?.name === 'deepseek-harness-sdk-runtime', JSON.stringify(init2))

  // 8. Same session id on the new process: the runtime resumes the
  //    conversation from its persisted log on the new model.
  let t2
  if (LOCAL_ONLY) {
    // gx10 route: proves the restart round-trip without DeepSeek. Its key is
    // not present in this environment, so the turn is expected to end in a
    // credentials error — which itself proves the new model took effect.
    const switchGx = await request('augmentor/switchModel', { provider: 'gx10-qwen', model: 'qwen38-27b-nvfp4' })
    check('switchModel → gx10: {ok, changed:true}', switchGx?.ok === true && switchGx?.changed === true, JSON.stringify(switchGx))
    const initGx = await request('initialize', {
      cwd: 'chrome-extension://augmentor',
      provider: 'gx10-qwen',
      model: 'qwen38-27b-nvfp4',
    })
    check('re-initialize (gx10)', initGx?.serverInfo?.name === 'deepseek-harness-sdk-runtime', JSON.stringify(initGx))
    t2 = await promptTurn('Say exactly: PING')
    check('gx10 turn: ended in a credentials error (new model took effect)',
      t2.reason?.kind === 'error'
      && /credential|api key|401|unauthor|key/i.test(String(t2.reason?.error?.message ?? JSON.stringify(t2.reason))),
      t2.detail)
  } else {
    t2 = await promptTurn('What was the secret codeword I told you to remember? Reply with only the codeword.', 180000)
    check('DeepSeek turn: turn/end completed', t2.reason?.kind === 'completed', t2.detail)
    check('DeepSeek turn: same session resumed — model recalls the codeword BANANA',
      t2.text.includes('BANANA'), `assistant: ${JSON.stringify(t2.text.slice(0, 200))}`)
  }

  // 9. Switch back to local; the conversation still resumes.
  const switch2 = await request('augmentor/switchModel', { provider: localSel.provider, model: localSel.model })
  check('switchModel → local again: {ok, changed:true}', switch2?.ok === true && switch2?.changed === true, JSON.stringify(switch2))
  const init3 = await request('initialize', {
    cwd: 'chrome-extension://augmentor',
    provider: localSel.provider,
    model: localSel.model,
  })
  check('re-initialize (local)', init3?.serverInfo?.name === 'deepseek-harness-sdk-runtime', JSON.stringify(init3))
  const t3 = await promptTurn('Reply with exactly: BYE2')
  check('local turn after switch-back: completed + BYE2',
    t3.reason?.kind === 'completed' && t3.text.includes('BYE2'), t3.detail)

  // 10. Shutdown: the runtime exits; the bridge follows (its cleanup path).
  writeFrame({ id: `v${++seq}`, method: 'shutdown' })
  const exit = await Promise.race([
    bridgeExit,
    new Promise((r) => setTimeout(() => r(null), 30000)),
  ])
  check('shutdown: bridge exited cleanly', exit !== null && exit?.code === 0, JSON.stringify(exit))

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`
    + (failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join(' | ')}` : ' — ALL GREEN'))
  console.log(`session log: ${path.join(BASE, 'sessions', SESSION_ID + '.jsonl')}`)
  if (!failed.length) {
    // Tidy the one-off verify session on success; keep it for debugging on failure.
    const logFile = path.join(BASE, 'sessions', SESSION_ID + '.jsonl')
    if (existsSync(logFile)) unlinkSync(logFile)
  }
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.log(`\nFAIL  harness aborted: ${e?.message ?? e}`)
  if (stderrTail.trim()) console.log(`bridge stderr tail:\n${stderrTail.trim()}`)
  console.log(`session log: ${path.join(BASE, 'sessions', SESSION_ID + '.jsonl')}`)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  pending.forEach((p) => p.resolve({ error: { message: 'harness ended' } }))
  try { bridge.kill('SIGKILL') } catch { /* already gone */ }
}
