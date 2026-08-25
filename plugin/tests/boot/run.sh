#!/bin/sh
# Real-composition boot test for dsh-augmentor.
#
# Boots a SEPARATE live `dsh web` instance (same npm CLI as the user's running
# server, different port, no prompts sent) with an overlay patch that mounts
# this plugin from source under an explicit action-channel token, then asserts
# the user-visible surface over HTTP/WS:
#   1. GET  /api/augmentor      -> 200 handshake, token reported (config source)
#   2. POST /api/augmentor      -> 405 (GET-only route)
#   3. WS   wrong token         -> refused (no welcome frame)
#   4. WS   right token         -> welcome frame
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
for p in profiles settings.yaml .anonymous-user-id llm-deepseek storages .agent-presets attachments; do
  [ -e "$REAL_HOME/$p" ] && ln -s "$REAL_HOME/$p" "$ISOLATED_HOME/$p"
done
# No cordis.patch.yml on purpose (see isolation note above).

OVERLAY="$TMPDIR_T/overlay.yml"
sed "s|^    name: AUGMENTOR_ENTRY$|    name: '$ENTRY'|" "$SCRIPT_DIR/overlay-template.yml" > "$OVERLAY"

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

[ "$FAIL" = 0 ] && { log "ALL PASS"; exit 0; } || { log "FAILURES PRESENT"; exit 1; }
