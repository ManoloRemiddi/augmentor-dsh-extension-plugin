#!/bin/sh
# Real-composition boot test for dsh-augmentor.
#
# Boots a SEPARATE live `dsh web` instance (same npm CLI as the user's running
# server, different port, no prompts sent) with an overlay patch that mounts
# this plugin from source under an explicit action-channel token, then asserts
# the user-visible surface over HTTP/WS:
#   1. GET  /api/augmentor      -> 200 handshake, token reported (config source),
#                                  chatCwd reported + directory created
#   2. POST /api/augmentor      -> 405 (GET-only route)
#   3. WS   wrong token         -> refused (no welcome frame)
#   4. WS   right token         -> welcome frame
#   5. M3 lifecycle: session.create (cwd = chat dir) -> augmentor/save ->
#      workspace over chat dir exists with the session attached ->
#      augmentor/unsave -> detached
#   6. M3 housekeeping: with sub-second retention the sweep archives the stale
#      unattached session (verified via augmentor/state's archived list)
#
# Isolation: the test runs under a throwaway DSH_HOME. The user's home patch
# (`cordis.patch.yml`) is deliberately NOT present, because it already inserts
# `dsh-augmentor` and a second same-id insert row fails loud at boot
# ("duplicate loader entry id"). We symlink the profile bundle + config the web
# app needs, and give it a FRESH EMPTY sessions dir so the user's real session
# data is never opened. Exits 0 on all-pass, 1 otherwise. The test instance is
# killed on exit; the user's DSH home and running server are untouched.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(dirname "$(dirname "$SCRIPT_DIR")")
ENTRY="$PLUGIN_DIR/src/index.ts"
NODE_BIN=${NODE_BIN:-node}
REAL_HOME=${DSH_HOME:-$HOME/.dsh}

TMPDIR_T=$(mktemp -d)
DSH_PID=
trap 'kill $DSH_PID 2>/dev/null; rm -rf "$TMPDIR_T"' EXIT INT TERM

ISOLATED_HOME="$TMPDIR_T/home"
mkdir -p "$ISOLATED_HOME/sessions"
# M3: the dedicated chat dir lives INSIDE the isolated home (never the user's
# real ~/Augmentor), so Save/attach and the sweep touch only throwaway state.
CHATDIR="$ISOLATED_HOME/chat"
mkdir -p "$CHATDIR"
for p in profiles settings.yaml .anonymous-user-id llm-deepseek .agent-presets attachments; do
  [ -e "$REAL_HOME/$p" ] && ln -s "$REAL_HOME/$p" "$ISOLATED_HOME/$p"
done
# storages: COPY, never symlink (M3). The workspace table is written on
# Save/attach/sweep; a symlink would leak test writes into the user's real
# registry (a session accounted by two test workspaces breaks the workspace
# domain's startup validation and would kill the user's next boot). The copy
# gives the test a realistic initial state while confining every write to
# the throwaway home.
[ -e "$REAL_HOME/storages" ] && cp -r "$REAL_HOME/storages" "$ISOLATED_HOME/storages"
# No cordis.patch.yml on purpose (see isolation note above).

OVERLAY="$TMPDIR_T/overlay.yml"
sed -e "s|^    name: AUGMENTOR_ENTRY$|    name: '$ENTRY'|" \
    -e "s|^      chatDir: AUGMENTOR_CHATDIR$|      chatDir: '$CHATDIR'|" \
    "$SCRIPT_DIR/overlay-template.yml" > "$OVERLAY"

# Pick a free port.
PORT=$("$NODE_BIN" -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")

log() { printf '[boot-test] %s\n' "$*"; }

log "booting dsh web on port $PORT (isolated DSH_HOME, token-gated overlay)"
DSH_HOME="$ISOLATED_HOME" dsh --profile web --patch "$OVERLAY" --port "$PORT" --no-open >"$TMPDIR_T/dsh.log" 2>&1 &
DSH_PID=$!

BASE="http://127.0.0.1:$PORT"
READY=0
i=0
while [ $i -lt 60 ]; do
  if curl -sf -o /dev/null "$BASE/api/augmentor"; then READY=1; break; fi
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    log "FAIL: test dsh instance exited early:"; tail -20 "$TMPDIR_T/dsh.log"; exit 1
  fi
  i=$((i + 1)); sleep 1
done
[ "$READY" = 1 ] || { log "FAIL: instance not ready after 60s:"; tail -20 "$TMPDIR_T/dsh.log"; exit 1; }
log "instance ready (pid $DSH_PID)"

FAIL=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then log "PASS: $1"; else log "FAIL: $1 (expected $2, got $3)"; FAIL=1; fi
}

# 1. handshake: 200 + token reported from config
H=$(curl -s -w '\n%{http_code}' "$BASE/api/augmentor")
CODE=$(printf '%s' "$H" | tail -n1)
BODY=$(printf '%s' "$H" | head -n -1)
check "handshake status" 200 "$CODE"
printf '%s' "$BODY" | grep -q '"wsTokenRequired":true' && check "handshake reports token required" ok ok || { log "FAIL: handshake token flag: $BODY"; FAIL=1; }
printf '%s' "$BODY" | grep -q '"wsTokenSource":"config"' && check "token source is config" ok ok || { log "FAIL: token source: $BODY"; FAIL=1; }
# M3: the handshake carries the pinned chat dir (the SW creates sessions in it).
printf '%s' "$BODY" | grep -q "\"chatCwd\":\"$CHATDIR\"" && check "handshake reports chatCwd" ok ok || { log "FAIL: handshake chatCwd: $BODY"; FAIL=1; }

# 2. non-GET on the route -> 405
check "non-GET is 405" 405 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/augmentor")"

# 3+4. WS gate: wrong token refused, right token welcomed
WS_RESULT=$("$NODE_BIN" - "$BASE" "$PLUGIN_DIR" <<'EOF'
const [base, pluginDir] = process.argv.slice(2)
const WebSocket = require(require('path').join(pluginDir, 'node_modules', 'ws'))
function attempt(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/augmentor/ws?token=${token}`)
    const done = (r) => { try { ws.terminate() } catch {} ; resolve(r) }
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'welcome') done('welcome') })
    ws.on('close', () => done('refused'))
    ws.on('error', () => {})
    setTimeout(() => done('timeout'), 4000)
  })
}
;(async () => {
  console.log([await attempt('wrong-token'), await attempt('boot-test-token-0123456789abcdef')].join(' '))
})()
EOF
)
WRONG=$(printf '%s' "$WS_RESULT" | awk '{print $1}')
RIGHT=$(printf '%s' "$WS_RESULT" | awk '{print $2}')
check "wrong token refused" refused "$WRONG"
check "right token welcomed" welcome "$RIGHT"

# The explicit-config branch must not create or touch any per-machine token
# file: neither in the isolated home nor the user's real home.
if [ -f "$ISOLATED_HOME/augmentor-ws-token" ]; then
  log "FAIL: config branch created a token file in the isolated home"; FAIL=1
else
  log "PASS: no token file created in the isolated home (config branch used)"
fi
if [ -f "$REAL_HOME/augmentor-ws-token" ]; then
  if grep -q 'boot-test-token' "$REAL_HOME/augmentor-ws-token"; then
    log "FAIL: test token leaked into the user's per-machine token file"; FAIL=1
  else
    log "PASS: user's per-machine token file untouched"
  fi
else
  log "PASS: no per-machine token file in user home (config branch used)"
fi

# 5+6. M3 chat lifecycle + housekeeping, over the real composition:
# session.create (cwd = chat dir) -> save (workspace attach) -> unsave ->
# the fast sweep archives the stale unattached session (sub-second retention
# in the overlay). Runs as one node leg against HTTP + the token-gated WS.
M3_OUT=$("$NODE_BIN" - "$BASE" "$PLUGIN_DIR" "$CHATDIR" <<'EOF'
const [base, pluginDir, chatDir] = process.argv.slice(2)
const WebSocket = require(require('path').join(pluginDir, 'node_modules', 'ws'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function dsh(method, payload) {
  const rpcId = `m3test-${Math.random().toString(36).slice(2)}`
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await res.json()
  if (!res.ok || body?.type !== 'server-response' || !body.result?.ok) {
    throw new Error(`${method}: ${JSON.stringify(body?.result?.error ?? body)}`)
  }
  return body.result.value
}
async function main() {
  const SID = 'boot-m3-test'
  // The extension's own contract: sessions are created IN the chat dir.
  await dsh('session.create', { sessionId: SID, cwd: chatDir })
  // A created-but-never-prompted session has NO persistence artifact, so the
  // sweep (which lists artifacts) cannot see it — true for real extension
  // chats only before their first message. rename appends a session/title
  // event without any LLM, materializing the artifact the way the user's
  // first message would, so the housekeeping leg has a real header to find.
  await dsh('session.rename', { sessionId: SID, title: 'm3 boot test' })
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/augmentor/ws?token=boot-test-token-0123456789abcdef`)
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', (e) => rej(e)) })
  const waiters = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.type === 'reply' && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); w(m) }
  })
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${method} timed out`)), 8000)
    waiters.set(id, (m) => { clearTimeout(to); resolve(m) })
    ws.send(JSON.stringify({ type: 'request', id, method, params }))
  })
  const fail = (name, got) => { console.log(`M3FAIL: ${name} ${JSON.stringify(got)}`); process.exit(1) }
  // save: workspace over the chat dir + session attached
  let r = await call('m3-save', 'augmentor/save', { sessionId: SID })
  if (r.result?.ok !== true || r.result?.saved !== true) fail('save reply', r)
  console.log('M3PASS: save attaches the session (workspace over chat dir)')
  // workspace.list value: { items: WorkspaceView[], archivedSessionIds }
  let rows = (await dsh('workspace.list', {})).items ?? []
  let row = rows.find((w) => w.path === chatDir)
  if (!row || row.title !== 'Augmentor Chat') fail('workspace row', rows)
  if (!(row.sessionIds ?? []).includes(SID)) fail('workspace sessionIds', row)
  console.log('M3PASS: workspace.list shows Augmentor Chat with the session attached')
  // unsave: detached, workspace survives
  r = await call('m3-unsave', 'augmentor/unsave', { sessionId: SID })
  if (r.result?.ok !== true || r.result?.saved !== false) fail('unsave reply', r)
  rows = (await dsh('workspace.list', {})).items ?? []
  row = rows.find((w) => w.path === chatDir)
  if (!row) fail('workspace after unsave', rows)
  if ((row.sessionIds ?? []).includes(SID)) fail('session still attached', row)
  console.log('M3PASS: unsave detaches the session (workspace survives)')
  r = await call('m3-state', 'augmentor/state', {})
  if (r.result?.ok !== true || (r.result?.saved ?? []).includes(SID)) fail('state after unsave', r)
  console.log('M3PASS: augmentor/state reflects the detach')
  // housekeeping: retention ≈ 0.9 s, sweep every 0.5 s — poll state until the
  // stale unattached session lands in the archived list (≤ 20 s).
  let archived = false
  for (let i = 0; i < 40 && !archived; i++) {
    await sleep(500)
    const st = await call(`m3-wait-${i}`, 'augmentor/state', {})
    archived = (st.result?.archived ?? []).includes(SID)
  }
  if (!archived) fail('sweep did not archive the stale session', null)
  console.log('M3PASS: housekeeping sweep archived the stale unattached session')
  ws.close()
  console.log('M3 RESULT: ok')
}
main().catch((e) => { console.log(`M3 RESULT: error (${e.message})`); process.exit(1) })
EOF
)
printf '%s\n' "$M3_OUT" | grep '^M3PASS' | while IFS= read -r line; do log "${line#M3PASS: }"; done
printf '%s\n' "$M3_OUT" | grep -q '^M3 RESULT: ok' \
  && check "M3 chat lifecycle + housekeeping" ok ok \
  || { log "FAIL: M3 lifecycle:"; printf '%s\n' "$M3_OUT"; FAIL=1; }

[ "$FAIL" = 0 ] && { log "ALL PASS"; exit 0; } || { log "FAILURES PRESENT"; exit 1; }
