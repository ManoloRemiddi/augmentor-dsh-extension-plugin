#!/bin/sh
# Installs the Chromium native messaging host manifest for the Augmentor pipe.
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
# The host is the /api pipe (pipe.mjs) — the browser talks to DSH over a
# loopback /api relay, no sidecar bridge.
HOST_SH="$AUGMENTOR_DIR/bin/pipe-host.sh"
cat > "$HOST_SH" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$AUGMENTOR_DIR/pipe.mjs"
EOF
chmod +x "$HOST_SH"

# Per-machine action-channel secret (drives the user's browser). The plugin
# and the pipe both read this file; creating it at install time makes the
# first pipe boot deterministic. 0600: same user only.
# S15 (audit): atomic O_EXCL creation (same trick as the plugin and the
# pipe) — if a concurrent first boot already won, that is not an error.
TOKEN_FILE="$HOME/.dsh/augmentor-ws-token"
mkdir -p "$HOME/.dsh"
"$NODE_BIN" -e '
  const fs = require("node:fs"), c = require("node:crypto")
  try {
    const fd = fs.openSync(process.argv[1], "wx", 0o600)
    fs.writeSync(fd, c.randomBytes(16).toString("hex") + "\n")
    fs.closeSync(fd)
    process.stdout.write("created " + process.argv[1] + "\n")
  } catch (e) {
    if (e.code !== "EEXIST") { console.error("token file: " + e.message); process.exit(1) }
  }
' "$TOKEN_FILE"

mkdir -p "$CONFIG_DIR/NativeMessagingHosts"
OUT="$CONFIG_DIR/NativeMessagingHosts/$HOST_NAME.json"
cat > "$OUT" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Augmentor pipe (powered by DSH)",
  "path": "$HOST_SH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "wrote $OUT"
echo "pipe: $HOST_SH"
echo "note: relaunch Chromium (or reload the extension) so the host manifest is picked up."
