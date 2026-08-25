#!/bin/sh
# Installs the Chromium native messaging host manifest for the Augmentor bridge.
#
# usage: ./install-native-host.sh <extension-id> [config-dir]
#   extension-id  from chrome://extensions (unpacked, developer mode)
#   config-dir    defaults to ~/.config/chromium
#
# The manifest must be readable by the browser user and the `node` binary
# must be resolvable (launch Chromium from a terminal where `node` works,
# or set NODE in this script).
set -eu

EXT_ID="${1:?usage: $0 <extension-id> [config-dir]}"
CONFIG_DIR="${2:-$HOME/.config/chromium}"
HOST_NAME="com.deepseek.dsh.augmentor"
NODE_BIN="${NODE:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH; set NODE=/abs/path/to/node and re-run" >&2
  exit 1
fi

AUGMENTOR_DIR="$(cd "$(dirname "$0")" && pwd)"
# M1: the host is the /api pipe (pipe.mjs), not the sidecar bridge (bridge.mjs).
# A fresh wrapper name so an in-flight bridge process never sees the change.
BRIDGE_SH="$AUGMENTOR_DIR/bin/pipe-host.sh"
cat > "$BRIDGE_SH" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$AUGMENTOR_DIR/pipe.mjs"
EOF
chmod +x "$BRIDGE_SH"
[ -f "$AUGMENTOR_DIR/bin/dsh-browser" ] && chmod +x "$AUGMENTOR_DIR/bin/dsh-browser" || true

# Per-machine action-channel secret (drives the user's browser). The plugin
# and the pipe both read this file; creating it at install time makes the
# first pipe boot deterministic. 0600: same user only.
TOKEN_FILE="$HOME/.dsh/augmentor-ws-token"
if [ ! -f "$TOKEN_FILE" ]; then
  mkdir -p "$HOME/.dsh"
  "$NODE_BIN" -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "created $TOKEN_FILE"
fi

mkdir -p "$CONFIG_DIR/NativeMessagingHosts"
OUT="$CONFIG_DIR/NativeMessagingHosts/$HOST_NAME.json"
cat > "$OUT" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Augmentor pipe (powered by DSH)",
  "path": "$BRIDGE_SH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "wrote $OUT"
echo "pipe: $BRIDGE_SH"
echo "note: relaunch Chromium (or reload the extension) so the host manifest is picked up."
