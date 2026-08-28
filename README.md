<!-- Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
     Copyright © 2026 Manolo Remiddi
     SPDX-License-Identifier: MIT
     License: MIT — see LICENSE at the repository root. -->

# Augmentor, powered by DSH

**Augmentor** turns any DeepSeek Harness (DSH) web session into a browser
operator: a Chrome side panel chats with your DSH app, and the agent drives
your *real* browser — live accessibility snapshot, click, type, tab switching —
with the user watching every action pulse on the actual page. Chats are real
DSH sessions in a dedicated directory, and **Save** attaches the current chat
to a DSH workspace.

```
┌─ Chromium (MV3 extension) ─────────────────┐   ┌─ Your machine ─────────────────────────────────────────────┐
│ side panel: chat UI (real DSH sessions)    │   │ pipe.mjs — native messaging host (Node, loopback)          │
│ sw.js: native port + browser executor +    │   │  ├─[POST /api/<method>]──────────────▶ running DSH app      │
│  work-tab injection (page veil, overlays)  │   │  ├─[WS /api/events.mux|host]◀───────── downlink frames      │
└──────────────┬─────────────────────────────┘   │  └─[WS <wsPath, from handshake>]──────▶ dsh-augmentor plugin│
               │ native messaging (token-gated)  │        /api handshake + pipe channel + browser tools +     │
               └────────────────────────────────▶│        chat lifecycle (save-to-workspace)                 │
                                                 └────────────────────────────────────────────────────────────┘
```

No sidecar runtime, no second DSH process: the extension talks to the **running**
DSH app over its stock `/api` surface (the pipe is the browser's loopback
stand-in client, because the extension's Origin is refused by the DSH trust
fence — by design).

## Components

| path | what it is |
| --- | --- |
| `extension/` | MV3 Chrome extension: side panel chat, service worker (native port + browser executor), page veil, work-tab overlays, theme tokens |
| `pipe.mjs` | native messaging host: loopback bridge to the DSH app's `/api` surface, downlinks, plugin channel |
| `plugin/` | the `dsh-augmentor` DSH plugin (npm package + git bundle): `/api/augmentor` handshake, pipe WS channel, `browser_*` tools, chat lifecycle |
| `wire.mjs` | the shared wire primitives (frame codec + pending table) used by all three runtimes — one implementation, three consumers |
| `install-native-host.sh` | installs the Chromium native-messaging-host manifest + the per-machine channel token |
| `test/` | e2e suites (m3, sw, panel, chrome, m2, tools) + `install-proof.mjs` (deterministic fresh-user install proof) + `plugin/tests/boot/` |
| `PROPOSAL-plugin-architecture.md` | the architecture record: milestones M1–M4, audit findings S/D/F, decisions |

## Install

Prereqs: Node.js (v22.19+ or v24+), a running `dsh web` instance, a
Chromium-based browser (Chrome/Chromium/Edge; Firefox & Safari are "coming
soon" — the native-messaging + content-injection stack is Chromium-specific
today).

1. **Clone**

   ```sh
   git clone https://github.com/ManoloRemiddi/augmentor-dsh-extension-plugin.git
   ```

2. **Load the extension** — `chrome://extensions` → *Developer mode* →
   *Load unpacked* → pick the `extension/` directory. Note the extension ID.

3. **Install the native host**

   ```sh
   ./install-native-host.sh <extension-id>
   ```

   Writes the NMH manifest (points at `pipe.mjs`), creates the per-machine
   action-channel token (`~/.dsh/augmentor-ws-token`, 0600) if missing, and
   installs the repo's Node dependencies (root + `plugin/`) if missing.

4. **Mount the plugin into your DSH profile**

   ```sh
   dsh plugin --profile web add <repo-path>/plugin
   ```

   (or from npm: `dsh plugin --profile web add dsh-augmentor`.)
   Restart the `dsh web` session so the profile composes the plugin layer.

5. **Reload the extension** (it reconnects the native port; a brief SW
   reconnect blip is normal). Open a side panel session, type a prompt, and
   the agent can now see and drive the active work tab.

## Security posture

- **The DSH trust fence is why the pipe exists — it is not bypassed.** The
  DSH app's `/api` refuses requests from foreign browser origins (the
  extension's `chrome-extension://` origin included, by design). `pipe.mjs`
  is a loopback stand-in client: it runs locally as the user and talks to
  the app over `127.0.0.1`, which is exactly what the fence permits.
- **No new remote surface.** Every hop is loopback (extension ↔ pipe via
  native messaging, pipe ↔ app via `127.0.0.1`); nothing this stack adds is
  reachable from other hosts. The trust boundary is the local OS user:
  anything that can already read your home directory is not blocked by this
  stack (and could already do the same things directly against the app).
- **The action channel is secret-gated.** The `browser_*` commands flow over
  a WS channel the plugin authenticates with a per-machine token
  (`$DSH_HOME/augmentor-ws-token`, 0600, created by the installer or first
  boot; a configured `actionToken` wins). The pipe presents it in the WS
  handshake header and the plugin compares it in constant time; a local
  process without that file cannot drive your browser.
- **The in-panel "Trust-fence probe"** (≣ Sessions → *Probe*) is a diagnostic
  that shows the fence working as designed (extension-origin requests
  refused, loopback requests accepted). It probes; it does not bypass.

## Development

```sh
# full e2e battery (six suites) — run from the repo root:
cd test && node m3-e2e.mjs && node sw-e2e.mjs && node panel-e2e.mjs \
  && node chrome-e2e.mjs && node m2-e2e.mjs && node tools-e2e.mjs

# plugin boot test:
sh plugin/tests/boot/run.sh
```

The suites are hermetic: each creates its own marker session (and archives it
on cleanup), never touches user sessions, and the live-browser suites (m3,
chrome, m2) run against the real local DSH app + a real Chrome profile.

# deterministic install proof — the documented journey, end to end, on a fresh
# DSH home + fresh Chromium profile (never touches your real ~/.dsh):
node test/install-proof.mjs                 # clone → boot → plugin → ext → NMH → pipes:1
PROOF_LLM=1 node test/install-proof.mjs     # + a real agent drives the headless browser
PROOF_SOURCE=npm PROOF_LLM=1 node test/install-proof.mjs   # npm plugin path (once published)
# knobs: PROOF_REPO, CHROME_BIN, PROOF_PORT, PROOF_KEEP=1 — see the script header.

## License

MIT.
