# Augmentor architecture shift: DSH plugin + extension

Proposal under analysis: Augmentor becomes **(1) a plugin for a running DeepSeek Harness
installation** and **(2) the Chromium extension**. A user who already runs DSH installs the
extension, enables the plugin, and the two are connected and in sync — the extension
recognizes the DSH installation: its models, its chat history, and anything else useful.

Status: **feasibility analysis** (2026-08-24). All claims below were verified against the
local `deepseek-harness` checkout (the same clone the sidecar runs from).

---

## 1. Verdict

**Feasible — and the codebase makes it easier than the current architecture, not harder.**

The pivot: the extension stops talking to a sidecar that owns its *own* DSH runtime, and
becomes a **second client of the user's running DSH app** — speaking the exact same
`/api` + WebSocket protocol the DSH GUI speaks. The trust fence (§2.4) keeps the browser
off that protocol, so the client role is carried by the **protocol pipe**: today's native
messaging host repurposed from "owns a runtime" to "re-frames frames" (a ~150-line diff
away, §3). The DSH plugin then shrinks to two jobs:

1. register the `browser_*` tools on the agent, and
2. bridge each tool call to the connected extension (and back).

Everything else — model catalog, chat history, session lifecycle, Stop, model switching —
already exists as stock DSH API methods callable by any loopback client.

Consequences for today's Augmentor:

| Today (sidecar) | New (plugin + extension) |
|---|---|
| `bridge.mjs` spawns and owns a second DSH runtime (`dsh-jsonrpc-agent` + `augmentor.cordis.yml`) | Repurposed: no second runtime — the user's DSH *is* the runtime. `bridge.mjs` shrinks to a **dumb protocol pipe** between the native port and `/api` (§2.4, §3) |
| Model picker re-reads `settings.yaml` and restarts the runtime on switch | `llm.models` / `settings.describe` over `/api`; `session.selectModel` switches **without any restart** |
| Stop button needs the local DSH patch (`session/interrupt` in 2 files + host-face rebuild) | **No patch needed**: stock `session.cancel` has exactly the Stop semantics ("stops the active turn, preserving pending inbox work") |
| Browser actions: model → `bash` → `dsh-browser` CLI → HTTP relay → bridge → extension | Model → `browser_*` tool (in-process) → plugin WS → extension. No bash round-trip, no CLI, no relay server |
| Chat lives in the sidecar's own `./.sessions` JSONL, invisible to the app | Chat is a **real DSH session**: created via `session.create`, persisted in the app's own store, visible in the app's sidebar and history — **disposable (Ungrouped) by default, one-tap promotion to an "Augmentor Chat" workspace** (§5) |
| `install-native-host.sh` + native messaging host + bridge env scrubbing | **Kept as-is** — the trust fence (§2.4) makes the native host the extension's only viable DSH transport; it now installs the protocol pipe instead of the runtime bridge |

## 2. What was verified (evidence)

### 2.1 A plugin can be added to a running installation without forking DSH

- A deployment's composition is the dsh base (78 plugin entries, `packages/bundle/base/cordis.patch.yml`)
  patched by the deployment overlay, by **`~/.dsh/cordis.patch.yml`** (machine-level —
  "applied over every profile's own layer", `apps/cli/src/profile-boot.ts:117-127`), which
  supports config overrides **and** `- insert:` of new plugin entries. This machine already
  ships a third-party plugin exactly this way (`dsh-web-search-free`, inserted into the user's
  patch file, package under `~/.dsh/profiles/node_modules/`) — the distribution path is
  proven. The CLI route is `dsh plugin --profile <name> add <npm|git|tarball|path>`
  (installs into the profile's `node_modules`; a package declaring `dsh.bundle.patch`
  auto-joins the layer stack) — but for a local path install the machine-level `insert:` row
  is the one-line option, and it survives profile switches.
- **Toggling**: the user patch layers (profile + machine) are **live-watched**
  (`watchUserPatches`, `packages/boot/app-boot/src/index.ts:213-263`): flipping
  `disabled: true` in the patch file disposes/remounts the plugin in a running app, no
  restart. The app UI itself has **no on/off switch** — the Plugins settings tab is a
  read-only inventory (`pluginInventory/list`, "No provenance or mutation") plus per-plugin
  settings *value* cards. So enable/disable is a patch-file edit (or `dsh plugin remove`);
  the Augmentor card reports status, it does not toggle.
- The Plugins settings tab has an extension point (`settings.plugins.tab` /
  `settings.plugin.item`) where a **plugin distributed outside the repo registers its own
  configuration card** ("a plugin distributed outside this repository appear here — it
  registers the namespace on the Host and the card in the browser"). The Augmentor plugin
  ships such a card: live connection status, endpoint URL, dedicated-directory path,
  retention, token (read-only).
- Plugin authoring conventions (function plugin: named exports `name` / `inject` / `Config` /
  `apply`, no default export; registrations are effects; product-visible plugins require a
  real-composition boot test) are documented and mechanical.

### 2.2 A plugin can register model-facing tools — stock, first-class

`ctx.tools.register(defineTool({ name, description, parameters, ... }))` is how `tool-bash`,
`tool-pwsh`, `tool-lsp` etc. work (`packages/shell/tool-bash/src/index.ts:242`; worked
example `docs/cordis-tutorial/07-into-the-harness.md`). The `browser_*` tools are exactly
this shape: a small set of JSON-parameterized tools whose handler is async and returns a
tool result. No DSH change.

Observation hooks the plugin gets for free (all stock cordis/DSH events):
`tools/pre-execute` / `tools/result` waterfalls (see each `browser_*` call fire, to drive
the veil status pill on the extension side), `agent/status` (idle⇄running, per session),
`session/created` / `session/disposed` / `session/event` (every appended session-log event —
the housekeeping sweep and the status card feed off these), and `agent/request` (waterfall
that could later inject per-session context — not needed for MVP).

### 2.3 A plugin can host an HTTP/WebSocket surface — stock, first-class

`@deepseek-ai/dsh-host-webserver` is itself a cordis plugin exposing a `webServer` service:
a node:http server on loopback with an **HTTP route registry and an upgrade (WebSocket)
route registry**; handlers may "own the full response lifecycle (may hold the response
open, e.g. SSE)". Any plugin in the same composition can register routes on the shared
server. The Augmentor plugin mounts one route (a WS at e.g. `/api/augmentor`) for the
tool-call ⇄ extension channel. No DSH change. (The alternative — forwarding custom host
events to app clients — is gated by the hardcoded `API_REMOTE_FORWARDED_EVENTS` allowlist in
`packages/api/remotes/src/remote-events.ts`, so the own-route approach is the zero-upstream one.)

### 2.4 The wire protocol — and the trust fence that settles the transport

Carrier (`@deepseek-ai/dsh-client-connection`): **HTTP POST `/api/<method>`** with body
envelope `{"type":"client-request","rpcId","method","payload"}` (method must match the
path); responses are always HTTP 200 wrapped in
`{"type":"server-response","rpcId","result":{"ok":true,"value"}|{"ok":false,"error"}}`
(`packages/host/apiproxy/src/api/rpc.schema.ts:98-110`). Server→client answers go to
`POST /api/respond` with the rpcId. Plus **two downlink-only WebSockets**
(`GET /api/events.mux`, `/api/events.host` — same paths as SSE) carrying frames incl.
answerable server-requests. Readiness = both sockets open + `host.describe` succeeds. Also
stock: `GET /api/session.export?sessionId=` (full session download — a ready-made
"export/open" hook).

The trust fence is a **hardcoded defense, not config**
(`packages/client/connection/src/api-request-trust.ts:96-123`) with three checks:

1. **Host fence**: `Host` must be loopback (`localhost`, `127/8`, `::1`) or a declared
   `trustedHosts` authority — applied to *every* request, browser-looking or not.
2. **Cross-site fence**: `sec-fetch-site: cross-site` → refused. Browsers attach fetch
   metadata to cross-site requests; a Node process never does.
3. **Origin fence**: if an `Origin` header is present, its `host:port` must equal the
   Host's (`new URL(origin).host === hostUrl.host`). An extension request carries
   `Origin: chrome-extension://<id>` — never equal to `127.0.0.1:3080` → refused.

**Consequence:** a *browser-based* client — the MV3 service worker or a content-script
fetch — fails checks 2 and 3 on the **stock `/api` method routes** (POST bodies carry
Origin; WS handshakes always do). The fence is exactly as designed: it admits **non-browser
loopback clients** (header comment: "Non-browser and remote clients pass the same fence via
loopback"). So the extension cannot dial the DSH API directly. It talks through a **small
Node process on loopback — the native-messaging host we already ship**: the existing
`bridge.mjs` is repurposed into a dumb protocol pipe,
`SW ⇄ chrome.runtime.connectNative ⇄ Node helper ⇄ /api + downlinks + plugin action WS`.
Same topology as today, minus the second DSH runtime.

**Empirical scope refinement (M1, 2026-08-25 — server-side, curl replaying the
extension's exact headers).** The fence lives in the api-proxy's method routing, not in the
web server's route table: routes a plugin registers itself are *not* fenced.

| Request (all with `Origin: chrome-extension://dgfpmlnbofacjafljfohgmfacobgfjbh`, `sec-fetch-site: cross-site`, `Host: 127.0.0.1:3080`) | Result |
|---|---|
| `GET /api/augmentor` — plugin exact route | **200** (handshake JSON) |
| `GET /` — static control | 200 (ungated) |
| `POST /api/session.list` — stock method route | **403**, body `forbidden` |

Consequences: (1) the SW-direct probe now *documents a split verdict* — the plugin
handshake is cross-site-reachable, the stock methods are refused; (2) the pipe remains the
primary transport for the API either way (the plugin route serves a public handshake only,
no session data, no credentials); (3) the unfenced exact route is an accepted reachability
posture of our own route — the only sensitive surface on it, the action WS upgrade, is
token-gated (§7 R4). The client-side half (a real SW fetch of both URLs) is built into the
panel's fence strip and lands in `trace/fence-probe.json` when the user clicks Probe.

The server→client direction **exists and is typed**: `MuxFrame` includes answerable
server-requests `approval/requested` and `question/requested` (answered over HTTP,
correlated by rpcId) — the extension can render approvals/questions with GUI parity, and the
same mechanism is the pattern the plugin follows for browser actions on its own route.
Transport mechanics the pipe must respect:

- **Downlinks are strictly downlink**: a client message on `events.mux`/`events.host` is a
  protocol violation — the socket closes with 1008 ("upstream traffic remains on HTTP",
  `packages/client/connection/src/websocket-downlink.ts:45-47`). A plain-HTTP GET on those
  paths is **426 Upgrade Required** (WS-only on the network; the SSE variant is in-process
  only). So the pipe: HTTP for everything it initiates, WS for frames it receives.
- **Multiple concurrent clients are first-class**: each downlink open gets its own
  `FrameQueue` (broadcast to all), unary calls are stateless, and the pending
  approval/question registries are **process-wide** — any connected client can answer,
  first response wins, and still-pending frames replay with their **stable rpcId** on every
  (re)open ("refresh-recovery baseline", api-proxy.ts:3331-3367). The pipe can therefore
  answer approvals even while the GUI tab is closed, and a GUI + pipe attached to the same
  session both see each other's turns live (§6C check 3).
- **No per-connection token**: the only gate is the per-request trust fence — a loopback
  client gets the *complete* API, including the loopback-pinned privileged methods
  (`settings.*`, `credentials.*`, `agentPreset.*` — `packages/client/connection/src/index.ts:89-119`).
  The pipe is effectively a full-power client (inherited posture, R4); the plugin's action
  WS is the only channel that adds its own token.

### 2.5 Every "recognize the installation" need is a stock `/api` method

From `packages/host/apiproxy/src/api/rpc-map.ts` (the full method registry):

- **Models**: `llm.models`, `llm.providers`, `llm.discoverModels`, `settings.describe`
  (the whole `settings.yaml` document incl. the `llm-pi-ai` routes with display names),
  `credentials.describe` (key provenance, values never ride a response).
- **Sessions / chat history**: `session.list`, `session.history`, `session.search`,
  `session.fork`, `session.rename`, `session.create`, `session.prompt`,
  `session.attachment`, `session.updateQueue` (the queued/steering inbox).
  `session.create` is **retry-safe**: the client may preallocate the `sessionId`; a retry
  with the same id + cwd returns the same session, a different cwd fails with
  `session-conflict` — so the pipe's "New chat" can re-issue on transient network failure
  without minting duplicates (the id-collision quirk of the old sidecar goes away with it).
  A cold session's live events resume on first `session.prompt`/`session.create` adoption;
  `session.history` reads it cold without ever starting an agent.
- **Model switching**: `session.models`, **`session.selectModel`** — per-session, no
  restart, takes effect on the session's next step. Note the stock side effect: the handler
  also persists the choice as the deployment default under `agent-default-model:` in
  `settings.yaml` (api-proxy.ts:2194-2231) — same behavior as the GUI's own picker, so
  Augmentor's picker gets it for free (and we inherit its semantics: a model choice in an
  ephemeral chat retunes the whole installation's default).
- **Stop**: **`session.cancel`** — "stops an ordinary session's active turn, preserving
  pending inbox work that resumes in FIFO order" (`packages/host/apiproxy/src/api/sessions.ts:375`).
- **Host**: `host.describe` (the discovery handshake: server name/version/capabilities),
  `agentPreset.list`/`select` (which agent composition a session runs on),
  `host/session-added|removed|status` frames on the host downlink (live session roster).
- **Events**: `session/event` frames on the mux downlink with per-session seq
  (`session/subscribed` carries `lastSeq` as the reconnect baseline) — the app's own
  reconnection story is "reopen the stream + refetch history", which is exactly the
  sinceSeq-resync discipline Augmentor's SW already implements.
- **Multiple clients**: designed for it — the mux docstring's convergence language is about
  "a start, a kill, a reconnect, and **a second tab**". Sessions/agents are host-side;
  clients attach. One in-flight prompt per session + FIFO inbox gives a clean shared-session
  model (the GUI and the extension queue, they don't interleave keystrokes — §4).

Underneath, `session-persistence-jsonl` + `session-query-sqlite` are in the base
composition: history is durable and queryable, and `session.history` serves it.

### 2.6 What is NOT stock (and what we stop needing)

- `session/interrupt` (SDK stdio surface) — the local 2-file DSH patch. **Retired**: the app
  surface's `session.cancel` is stock and sufficient. The patch stays out of the new
  architecture entirely.
- Custom host→client event forwarding (`API_REMOTE_FORWARDED_EVENTS`) — not needed: the
  plugin's own WS route is its channel.
- ACP (`packages/acp`) — the wrong transport here: stdio-owned, fresh-sessions-only,
  automation-only, no history/list. Noted for completeness.

## 3. Target architecture

```
┌─ Chromium (MV3 extension) ──────────────────────────────┐
│ side panel (chat UI, session picker, model picker, veil controls)
│ service worker = chat UI + browser executor (tab-level actions, as today)
│ page overlay: frost veil + status pill (injected per tab)
└──────────────────────────────┬───────────────────────────┘
                               │ chrome.runtime.connectNative (stdio, len-prefixed JSON — unchanged)
┌──────────────────────────────┴───────────────────────────┐
│ Node helper (repurposed bridge.mjs — the only process we own)
│ dumb protocol pipe: re-frames the native port traffic as
│   ├─ POST /api/<method>              unary calls (all upstream traffic, incl. /api/respond)
│   ├─ WS /api/events.mux / events.host  downlink-only frames (never sent on; 1008 if we did)
│   └─ WS /api/augmentor               plugin action channel (browser actions ⇄ executor)
└──────────────────────────────┬───────────────────────────┘
                               │ loopback, no browser markers → passes the trust fence (§2.4)
┌──────────────────────────────┴───────────────────────────┐
│ DSH app: the user's running installation
│ @deepseek-ai/dsh-augmentor plugin (inserted via ~/.dsh/cordis.patch.yml)
│   ├─ ctx.tools.register: browser_tabs_list / navigate / snapshot / click / type
│   │    handler: push {callId, tool, args} → helper WS, await result
│   ├─ webServer route: WS /api/augmentor (token-authenticated)
│   ├─ session-lifecycle service: Save/Unsave (Augmentor Chat workspace) + sweep
│   └─ settings namespace + GUI Plugins-tab card: status, endpoint, connection
│ stock: agent loop · session store (JSONL + SQLite) · model catalog ·
│        approval/interaction · /api + downlinks (host-webserver, api-remotes)
└───────────────────────────────────────────────────────────┘
```

Nothing here requires a DSH change for the MVP.

## 4. "In sync" — the semantics, tiered

- **T1 · Single source of truth.** The extension's conversations are real DSH sessions
  (`session.create` on the app surface, same store the app uses). They appear in the app's
  sidebar/history; the extension's model picker *is* the app's catalog (`llm.models` +
  `settings.describe`); switching models is `session.selectModel` (no restart, no second
  runtime to drift).
- **T2 · Both directions, live.** The extension can open any existing session
  (`session.list`/`session.search` → `session.history` → mux subscription) and continue it;
  turns made through the extension are live in the app (shared session, shared downlinks —
  the "second tab" convergence). While both surfaces are attached, concurrency is mediated by
  the stock session queue: one in-flight prompt, FIFO inbox (`session.updateQueue`) — a
  shared to-do list, not interleaved typing. That is the honest sync model.
- **T3 · The tool channel.** Model calls a `browser_*` tool → plugin pushes the action on
  the extension's WS → the real tab executes (existing executor) → result returns as the
  tool result; the veil reflects activity on the acted-upon tab, as today.

## 5. Session lifecycle: ephemeral by default, saved on demand

Product requirement: most Augmentor conversations are disposable (research, sentence
corrections, one-off questions) and must not accumulate as saved sessions. Occasionally a
conversation is worth keeping — the user promotes it with one tap, and it becomes a saved DSH
session in a dedicated workspace ("Augmentor Chat"). The panel also gets an **Open in DSH**
button that jumps to the running DSH app (`http://127.0.0.1:3080/`) with the relevant chat open.

### 5.1 What stock DSH actually provides (all verified in this checkout)

- **Every session is persisted, unconditionally.** There is no ephemeral persistence mode:
  `session-persistence-jsonl` (the backend in the base composition) writes each session log to
  `<root>/<normalized-cwd>/<encoded-id>/session.jsonl.zstd` (root configured per deployment;
  `~/.dsh/sessions` on this install — the live store already shows one directory per cwd).
  The first logical line is an immutable header (`id`, `cwd`, `createdAt`, …). There is also
  **no session-deletion API** — the workspace README names it "a separate, absent capability".
- **A Workspace is a registry record over an existing directory** (`@deepseek-ai/dsh-workspace`).
  A session is accounted under a workspace **iff its `cwd` equals the workspace's canonical
  path AND it is attached**. `session.create {workspaceId}` = create with `cwd = workspace.path`
  + auto-attach (`packages/host/apiproxy/src/api-proxy.ts:2092,2130`). `session.create {cwd}`
  without a workspace leaves the session **Ungrouped** — the registry is explicit: "Later
  cwd-only sessions remain Ungrouped".
- **The app sidebar renders an "Ungrouped" trailing bucket**
  (`packages/client/ui-workspace/src/client/tree.ts`: "Unassigned Sessions trail under
  Ungrouped"). So an Ungrouped session is not invisible in the GUI — it just belongs to no
  project. `workspace.archiveSession` (stock, on `/api`) makes a session "disappear from every
  grouping surface" while keeping its log and accounting slot.
- **The `/api` workspace methods** are `list/create/rename/delete/insertBefore/
  insertSessionBefore/archiveSession`. There is **no attach on the wire** — but the registry is
  a host-side service (the workspace plugin registers itself as `workspaceRegistry`, and
  consumers declare it in their injection list — `packages/host/apiproxy/src/index.ts:72`), and
  `Workspace.attachSession(id)` / `detachSession(id)` are documented consumer methods. The
  Augmentor plugin declares the same injection and attaches host-side: no wire method, no DSH
  change. Attach validates the session's `cwd` against the workspace path and rejects
  mismatches — which is exactly why the design below pins `cwd`.
- **The GUI has no session deep link.** Verified: no URL-parameter plumbing anywhere in
  `apps/web`, the `@deepseek-ai/dsh-client-web` boot, or the client runtime — the selected
  session is pure client state, and the only server→client control surface is the fixed
  forwarded-event allowlist. So "open *this* chat in DSH" stock = "open the app, user clicks
  the chat"; deep-linking the exact chat is a small client change (§5.2).

### 5.2 The design (maps 1:1 to the requirement)

**One dedicated directory, two roles.** `~/Augmentor` — **confirmed as the default by the
user** (name and path still configurable in the plugin's settings card; the plugin
`mkdir -p`s it at first boot). It is (1) the `cwd` of every session the extension creates,
and (2) the path of the "Augmentor Chat" workspace. Pinning `cwd` to the workspace path is
what makes promotion possible at all: attach validates `cwd`, so a session created elsewhere
could never join the workspace.

- **Default = disposable.** "New chat" = `session.create { cwd: ~/Augmentor }` — no
  `workspaceId`. The log is written (unavoidable in DSH) but the session is **Ungrouped**: it
  sits in no project in the app sidebar, only in the Ungrouped bucket, which housekeeping
  (§5.4) keeps from growing. The panel lists/reopens these as the working set (the session
  picker of the new UI), but they are not "saved sessions" in the product sense.
- **Save button — next to "+ New chat".** One tap, one plugin call:
  1. `workspaceRegistry.create(~/Augmentor, 'Augmentor Chat')` — idempotent (repeated calls
     resolve to the existing workspace);
  2. `workspaceRegistry.get(id).attachSession(sessionId)` — the chat moves into the
     **Augmentor Chat** workspace in the app sidebar (attach prepends → newest first).
  The panel marks the session "Saved to DSH". Unsave (optional, cheap) is `detachSession` →
  back to Ungrouped.
- **Open in DSH button.** `window.open('<endpoint>')` — the endpoint is already known to the
  extension from handshake/options (default `http://127.0.0.1:3080/`). **Option A, confirmed
  by the user for M3:** the button opens the app itself; the chat is one click away in the
  sidebar — saved chats at the top of the Augmentor Chat group, unsaved in Ungrouped. The
  deep link (open the exact chat via `?session=<id>`/`#session=<id>` at client boot — a small,
  isolated DSH *client* change, §6D) is **parked as an optional follow-up**, not part of the
  MVP.

### 5.3 Why not the obvious alternatives

- **`session.create {workspaceId}` from the start** would auto-attach *every* extension session
  at creation — the inverse of the requirement (everything saved by default). There is no
  per-session "don't persist" flag and no "detach on create", so attach-on-demand is the only
  stock mechanism that yields "off by default + one-tap promotion".
- **Per-chat scratch cwd** (a unique directory per session) would make promotion impossible
  (a workspace covers one path) and litter the Ungrouped bucket with per-session labels. One
  shared directory keeps the workspace semantics clean — and gives research chats a real
  working directory: files the model saves during a research task land in `~/Augmentor` and
  stay findable after the chat itself is archived.

### 5.4 Housekeeping: making "forgettable" actually forgotten

Stock DSH does not auto-delete Ungrouped sessions. The plugin (host-side, has fs) runs a
low-frequency sweep (boot + hourly):

- extension sessions (header `cwd == ~/Augmentor`) that are attached to **no** workspace and
  older than a retention window (config, default 14 days) → `archiveSession(id)` — they
  disappear from the Ungrouped bucket; the log stays on disk;
- optional, config-flagged, default **off**: delete the log directory of archived extension
  sessions older than a second window. Sessions accounted in any workspace are never touched.

### 5.5 Effect on the rest of this proposal

- Plugin A gains a **session lifecycle service**: directory bootstrap, workspace
  ensure/attach/detach (host-side registry calls), the save/unsave handlers on the client WS
  protocol, the housekeeping sweep (~2 files).
- Extension B gains: Save/Unsave + saved-state badge next to "+ New chat"; Open-in-DSH button
  (pure client-side `window.open`); "New chat" sends `session.create {cwd}` instead of the
  sidecar's local session mint.
- Milestones: `session.create {cwd}` enters **M2** with the prompt loop; Save button,
  Open-in-DSH and housekeeping enter **M3** with the awareness work.

## 6. Work breakdown

**A. The plugin — `@deepseek-ai/dsh-augmentor`** (new, ~6–8 source files)

1. Function plugin per repo conventions (`name`/`inject`/`Config`/`apply`, no default
   export; registrations as effects; `./invariant` companion; README with Model Experience
   and Known Limitations sections).
2. Tool registration: the five `browser_*` tools (mirroring today's `dsh-browser` action
   set) via `ctx.tools.register(defineTool(...))`.
3. `augmentor-client` service: owns the WS route on `ctx.webServer`
   (upgrade at `/api/augmentor`), token from config or generated-on-first-boot (persisted;
   surfaced read-only in the settings card), connection registry with single-active-client
   + reconnect semantics, request/response correlation with a timeout.
4. Tool handler → client service: pending-request map keyed by callId; clean, model-readable
   failure when no client is connected ("browser client not connected — ask the user to open
   the Augmentor panel").
5. **Session lifecycle service** (§5): `mkdir -p` the dedicated directory at first boot;
   ensure/attach/detach the "Augmentor Chat" workspace via the injected `workspaceRegistry`
   (host-side, no wire method); save/unsave handlers on the client WS protocol; housekeeping
   sweep (archive — and optionally delete — stale unattached extension sessions).
6. Settings namespace + GUI card (Plugins tab extension point): enable state, live
   connection status, endpoint URL, dedicated-directory path + retention config.
7. Tests per repo policy: real-composition boot test (test-only `cordis.yml` through the
   Loader), HMR-dispose test for the registry contributions, keyless snapshot if anything is
   model-visible.

**B. The extension + Node helper** (transport swapped; UI largely reused)

1. **Protocol pipe** (repurposed `bridge.mjs`, ~one module per carrier): `host.describe`
   handshake; HTTP POST `/api/<method>` with the `client-request` envelope + `/api/respond`;
   two downlink WS with generation/rebuild on close; reconnect = reopen + refetch baseline
   (`session/subscribed.lastSeq`, `session.history`) — the same discipline the current SW
   already has. The SW keeps today's native-port plumbing (connect, heartbeat, re-launch)
   and the pipe re-frames native↔app in both directions; the SW never touches `/api` (§2.4).
2. **Method-surface swap**: `initialize`/`prompt` (SDK stdio surface) →
   `session.create {cwd}` / `session.prompt` / `session.cancel` / `session.selectModel`
   (the `cwd` is the dedicated directory — §5); model picker data from `llm.models` +
   `settings.describe` (replaces the bridge's YAML reader); delete the `switchModel`-restart
   logic.
3. **Session awareness UI** (new): session list + search (`session.list`/`session.search`),
   open existing session (history render — reuses the existing log renderer), "New chat" =
   `session.create {cwd}` on the user's default preset — ephemeral by default.
4. **Save / Open-in-DSH** (§5): Save button next to "+ New chat" (plugin call → workspace
   attach) with saved-state badge; Unsave (detach); "Open in DSH" button
   (`window.open(endpoint + (saved ? '#session=' + id : ''))` — deep link only if the
   §6D client change is present, plain app open otherwise).
5. **Browser executor**: today's per-tab executor + veil, driven from the plugin WS instead
   of the local HTTP relay.
6. **Server-request UI**: `approval/requested` / `question/requested` frames → the panel's
   accept/answer affordances (GUI parity; can start minimal).
7. **SW lifecycle**: keep-alive ping while a turn is active (MV3 30s idle); full resync on
   SW restart (already the design); veil state survives SW death (it lives in page DOM +
   `root.dataset`, already the case).
8. **Deletions**: runtime spawn/restart, model-catalog YAML read, `dsh-browser` CLI +
   HTTP relay (the pipe dials `/api` instead of a local relay server), the per-PID
   `bridge-endpoints` concept (no local server anymore), `agent-workdir`. The
   `install-native-host.sh` infrastructure **stays** — it now installs the protocol pipe.

**C. Empirical checks (small, decisive — do these in milestone M1)**

1. **R1 fence — documented empirically (done, server side).** The code-reading verdict
   (§2.4) holds for the stock method routes: replaying the extension's exact headers
   (`Origin: chrome-extension://…`, `sec-fetch-site: cross-site`) against a live method
   route yields **403 `forbidden`**, while the plugin's exact route returns 200 (fence is
   api-proxy-scoped, §2.4 table). The client-side half — a real SW fetch of
   `/api/augmentor` + `/` — ships as the panel's fence strip (Probe button) and records
   `trace/fence-probe.json` on click; expected to match the curl simulation. The protocol
   pipe (item B1) is the primary transport regardless — no fallback branch.
2. **SW keep-alive**: measure Chrome's SW idle-kill with an open WS + ping cadence; pick
   the ping interval (25s) and verify no kill mid-turn.
3. **Concurrent attach**: GUI + extension on the same session — confirm queue/FIFO
   behavior and that both see each other's turns live.
4. **Approval/question respond** from a non-GUI client: confirm the respond path works for
   our client (it should — it's just HTTP with the rpcId).

**D. DSH client/upstream (MVP: none; optional later)**

- **Session deep link** (§5.2) — **out of M3 scope, parked as optional follow-up**
  (user confirmed Option A: "Open in DSH" ships as plain app-open in M3). When wanted:
  `?session=<id>` / `#session=<id>` support in client boot.
  Verified absent today: no URL-param plumbing in `apps/web/src/main.ts`,
  `packages/client/web/src` (boot/seed/platform) or the client runtime. Placement when
  built: the URL is read at shell boot and the selection lands in the **data object layer**
  (`ConnectionController`/`SessionManager` in `@deepseek-ai/dsh-client-runtime` select the
  session after load) — not a presentation plugin, per the client layering rules. Small,
  isolated change; makes "Open in DSH" land on the exact chat. Without it the button opens
  the app and the chat is one click in the sidebar (saved chats in Augmentor Chat, others in
  Ungrouped). Candidate upstream PR; otherwise a local patch in the style of the existing
  `~/.dsh` patches.
- Nothing else required. If we later want plugin events on the app downlinks instead of the
  plugin's own route: add the event names to `API_REMOTE_FORWARDED_EVENTS`
  (one line + shape gate) — a small, conventional upstream PR.
- If the plugin is to be published rather than locally installed: the repo's publishing
  pipeline (publint, invariants, 100% coverage gate) applies — budget for that separately.

## 7. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | ~~Extension-Origin requests rejected by the `/api` trust fence~~ — **resolved by code reading** (§2.4): the fence refuses browser-originated requests (`sec-fetch-site: cross-site`; Origin `chrome-extension://…` ≠ Host). Not a risk anymore: the native-host **protocol pipe is the primary transport**, and the SW-direct probe in M1 only documents the verdict | — | Pipe reuses the shipped native-messaging host + the existing bridge code; no new process, no fence exposure |
| R2 | MV3 SW idle-kill mid-turn | Medium | WS keep-alive ping; resync-on-restart already designed; worst case = panel reconnect |
| R3 | DSH is pre-release: protocol may break between versions (AGENTS.md: "foundation over blast radius", backends reject old formats) | Medium | Extension reads `host.describe` version at handshake and surfaces incompatibility clearly; document required DSH version per extension version |
| R4 | Security posture: `/api` is loopback-reachable, "a reachability policy, not authentication" | Low–Med | Inherited from the app's own documented posture (local-only by design). The action WS is token-gated (`?token=…` checked at upgrade): the secret is a per-machine file `~/.dsh/augmentor-ws-token` (0600, created at install / first boot — plugin and pipe resolve the same file, so they converge), overridable by `config.wsToken` or `DSH_AUGMENTOR_WS_TOKEN`. *Activation note (M1):* a running process only sees new plugin **source** after a restart (Node ESM module cache, §10), so the M1 instance's action channel stays open-loopback until the next restart — acceptable because M1 is read-only (no prompts, no browser-driving tool traffic); the gate is in force from M2's restart (M4's `dsh plugin add` needs one anyway) |
| R5 | `browser_*` tools are globally registered: a model in *any* session of that installation can call them; with the extension disconnected they must fail cleanly | Low | Tool handler returns a readable "no browser client connected" result; never blocks the turn |
| R6 | Two DSH installs/profiles on one machine (this box has several) — which one does the extension attach to? Also: an app bound non-loopback (`--host 0.0.0.0`) refuses the pipe's loopback authority | Low | One running app per port; extension options field for the endpoint (default 3080); plugin card shows the live endpoint; `host.describe` at handshake tells the pipe which deployment it reached |

## 8. Milestones

- **M1 — prove the connection** (the empirical checks of §6C, plus): plugin skeleton (bundle
  package shape per §10) with the token-gated action WS route + one tool (`browser_tabs_list`);
  **repurposed protocol pipe** (B1) dials a
  running DSH, and the extension handshakes *through it*, lists sessions, renders one opened
  session's history. The fence probe (C1) is recorded the same day as evidence for
  the §2.4 verdict. *Exit: an existing DSH conversation is visible in the Augmentor panel.*
- **M2 — the prompt loop**: `session.create {cwd}` (ephemeral by default, §5) +
  `session.prompt` + live turn rendering + Stop (`session.cancel`); all five browser tools
  round-tripping with the veil. *Exit: a full browser-agent conversation through the
  extension, driven by the user's own DSH model — disposable (Ungrouped) unless promoted.*
- **M3 — awareness, sessions & parity**: model picker (`llm.models`, `session.selectModel`),
  session picker/search, **Save button + Augmentor Chat workspace + housekeeping sweep**
  (§5), **Open-in-DSH button**, approval/question UI, keep-alive tuning, settings
  (host-side namespace + panel-owned UI — in-page GUI card deferred, §10; incl. dedicated
  directory + retention), endpoint options.
- **M4 — hardening & packaging**: reconnect/resync audit, error surfaces, version gate,
  install scripts (plugin insert helper + extension zip), README rewrite, decision on
  publishing the plugin upstream vs locally installed.

## 9. What "done" looks like (your acceptance story)

User already runs DSH → installs the Augmentor extension (unpacked or store) → runs the
one-line install helper (installs the plugin package, inserts its row into
`~/.dsh/cordis.patch.yml`; the app live-watches that file and mounts the plugin — a restart
also works) → opens the side panel → sees DSH's session history and model list →
picks a model, starts or continues a conversation → the model drives the user's real
browser through the frost veil → the conversation is **disposable by default** (a real DSH
session under `~/Augmentor`, Ungrouped — it does not clutter the app's workspaces) → when it
is worth keeping, one tap on **Save** files it under the **Augmentor Chat** workspace in
DSH, and **Open in DSH** jumps to the running app with that chat. The Stop button works. No
sidecar, no second runtime, no local DSH patches.

## 10. Plugin-building best practice (verified against the official docs, 2026-08-24)

Source set read in full: `docs/user/develop/basic/{index,tool,config,publish}.md`,
`docs/user/develop/framework/{index,service,events}.md`, `docs/user/develop/practice/index.md`,
`docs/cookbook/{adding-a-tool,adding-a-settings-card,adding-a-package}.md`,
`docs/cordis-tutorial/07-into-the-harness.md`, `docs/subsystems/web-server.md` (generated
cordis surface, fresh at rc.2). These are the official third-party plugin-development docs —
there is no separate SDK beyond `@deepseek-ai/cordis` itself (published: 4.0.1).

**Canonical plugin form.** A TypeScript module exporting `name`, `inject`, `apply(ctx, config)`
(function form is the default), plus an exported `Config` interface with a same-named
Schemastery schema (defaults live on the schema; nothing deployment-variable is hardcoded).
Every registration goes through `ctx` (effect-based, auto-cleaned on unload/HMR). Tools come
from `defineTool` in `@deepseek-ai/dsh-tools`: typed args, one canonical JSON value,
`output.render` for model-facing content, UI cards are pure presenters. Services use
`Service` + declaration merging; typed events via declaration merging.

**Canonical packaging/install (publish.md).** A **bundle** is an npm package carrying
`dsh.bundle.patch` in `package.json` + its own `cordis.patch.yml` (insert rows reference the
package by bare name) + the plugin module. Install: `dsh plugin --profile <name> add
<path|github:<repo>#<sha>|<tarball>|<npm-spec>>` — the CLI maintains the profile manifest
(`dsh.profile.bundles`), pnpm manages dependencies. Layer order: bundle patches → profile
patch → home patch (`~/.dsh/cordis.patch.yml`) → `--patch` overlays; later layers win per row.
Git installs run the author's `prepare` build (user must `allowBuilds` the package);
tarballs/npm ship prebuilt. The docs' git-install example (turtle-ui) is gone (404) — the doc
prose remains the spec; M4 verifies the git route empirically (tarball is the fallback).

**This machine (verified).** The running server at `127.0.0.1:3080` is the **published npm
CLI** `dsh 0.1.1-rc.2` on Node 24.19.0 (`dsh web --profile web`), not the source checkout —
but the checkout is exactly tag `dsh-v0.1.1-rc.2`, so every code-reading in this proposal
applies 1:1. The `web` profile already carries four third-party bundles installed exactly this
way (`dsh-web-ui-all`, `dsh-context`, `dsh-plugin-wiki-skills/tools`), and the home patch
already carries a machine-local plugin (`dsh-web-search-free`) via an insert row — the
live-watch mount path (§9) is proven on this box. All dependencies a plugin needs are
**published at exactly 0.1.1-rc.2** (host-internal versions): `@deepseek-ai/cordis` 4.0.1,
`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/schemastery` — the bundle
pins those exact versions, so the plugin's contracts match the running host byte for byte.
Node 24.19 strips TS types natively, so `.ts` plugin files load without a build; the bundle
still ships a built `lib/` entry for distribution robustness.

**Extension points used (generated cordis surface, rc.2).** `ctx.webServer.register({kind:
'exact'|'prefix', path, handler})` for the HTTP route and `ctx.webServer.registerUpgrade(route)`
— an exact-path upgrade route whose handler owns WS negotiation and the socket — for the
server-initiated action channel. The fallback seat belongs to the SPA dist server; we never
touch it. Duplicate `(kind, path)` throws, so the plugin's path (`/api/augmentor`,
configurable) is a composition-level contract.

**Settings card — M3 decision changed by the docs.** The in-page GUI card (cookbook
`adding-a-settings-card`) has two halves: the Host half
(`installSettingsSection` + `settingsNamespace` from `dsh-settings` — the namespace is the
join key, live `onChange` rebuild supported) and a browser half that must be packaged as
`dsh.client` + `./client` export, built as the loader's **lazy-CJS factory artifact** — "a
package outside this repository has to reproduce the same output format itself" — under a
bundle-purity gate that forbids importing the section's card chrome (the card renders its
own). That is real packaging risk for zero product benefit: the panel is the real UI and can
read/write the same settings namespace through the pipe. **Decision: M3 ships the Host half
only** (persisted namespace, schema validation, live onChange) with the settings UI owned by
the panel; the in-page GUI card is deferred (the plugin still shows in the GUI's Plugins
inventory).

**Live-mount verification (M1, executed on this box against the running server, 2026-08-25).**
- The published 0.1.1-rc.2 loader accepts the canonical function-plugin form exactly as
  documented (named exports `name`/`inject`/`Config`/`apply`, no default): hot-mounted from
  the home-patch insert row **while the server ran** — no restart, no DSH checkout change.
- The entry was mounted as **source `.ts`, not built**: Node 24's native type stripping loads
  it directly, and bare imports (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, `ws`)
  resolve from the plugin's own `node_modules` (standalone `pnpm install` in `plugin/`).
- `ctx.get('webServer')` (optional service) + `register({kind:'exact'})` + `registerUpgrade`
  all work live: `curl http://127.0.0.1:3080/api/augmentor` → 200 handshake JSON
  (`{"name":"dsh-augmentor","protocol":"augmentor-pipe/v1","version":"0.1.0","wsPath":"/api/augmentor/ws","pipes":0,…}`);
  WS upgrade → `{"type":"welcome",…}` frame; non-GET → 405. **Exact-route coexistence
  proven**: unknown `/api/*` paths still 404 — the api-proxy prefix is not shadowed.
- **Fresh-boot service ordering (empirical, root-caused 2026-08-25; this is why the live
  mount "just worked" and a cold boot did not).** At initial boot, a patch-layer plugin's
  `apply` runs **before** the webserver fiber provides its service, so
  `ctx.get('webServer')` is `undefined` at apply time and an `if (webServer)` guard
  silently skips the route registration forever → `/api/augmentor` 404 on every cold boot,
  while the same plugin works when hot-mounted (service already present). Source chain:
  the `Service` base registers its service in the constructor
  (`packages/host/webserver/src/index.ts` → `super(ctx,'webServer')` →
  `ctx.reflect.provide`, immediate per `vendor/cordis/src/service.ts:42-59`), and
  `vendor/cordis/src/reflect.ts:117-146` emits the built-in
  `'internal/service'(name, value)` event on provide — the house pattern for web plugins
  is hard `inject = ['webServer']` (the web-app bundle does this and throws if missing),
  which is **not usable here**: the home-patch row mounts this plugin into *every* profile
  of the home, including headless compositions with no web server, where a hard inject
  would PEND/break the user's plain `dsh` runs. **Fix (in `apply`):** try
  `ctx.get('webServer')` first (hot-mount path, service already present); if absent,
  subscribe to `ctx.on('internal/service', …)` and register when the service lands —
  verified empirically to fire <1 s after a cold-boot apply. Registration itself is
  effect-wrapped (`ctx.effect(() => [disposeRoute, disposeUpgrade], …)`): both route
  disposers run when the plugin fiber unloads (HMR instance replace, profile teardown),
  which also fixes a latent duplicate-route bug — the pre-fix bare `register` calls were
  never disposed, so a config-edit re-apply of the same row would have thrown
  `webserver: duplicate exact route` and silently failed the instance swap (this
  retro-explains the earlier "hot-replace didn't pick up new code" observation). Headless
  profiles: the event never fires, the channel stays off, nothing PENDs.
- **Real-composition boot test green (`plugin/tests/boot/run.sh`).** Boots a *fresh* `dsh
  web` under an isolated `DSH_HOME` (symlinked profiles/settings/storages, empty
  `sessions/`, **no** `cordis.patch.yml` — a second insert row with the same id as the
  home patch's fails boot with `duplicate loader entry id`, so isolation is required, not
  just hygiene; `--dump-config` does not honor `DSH_HOME`, only the boot does) with an
  overlay row carrying an explicit `wsToken` (deterministic gate; asserts no token file
  is created in the isolated home and the user's `~/.dsh/augmentor-ws-token` is
  untouched). Asserts: 200 handshake, `wsTokenRequired: true`,
  `wsTokenSource: "config"`, 405 on POST, wrong-token upgrade refused, right-token
  upgrade welcomed. **ALL PASS.** The suite also caught a real bug in committed code the
  running server's ESM-cached module was hiding: the `browser_tabs_list`
  `output.schema` was written as raw JSON Schema (`required: [...]` arrays) and the
  dsh-tools authoring DSL rejects it (`schema.required is not supported by the value
  schema DSL`) — the tool is now written in the DSL (per-property `required: true`,
  explicit `additionalProperties`, `oneOf` for the nullable `id`/`url`/`title`), and the
  defineTool crash killed the whole test app on import, proving the tool code path
  executes at apply.
- **Reload semantics (source-verified on the rc.2 checkout; this decides dev iteration
  speed):** the patch watcher (`hmr.registerConfig` → `entry.update`,
  `packages/boot/app-boot/src/index.ts:232-265`) re-applies the user layer on every patch-file
  change. **Adding** an insert row imports the module for the first time — fresh code, which
  is why the live mount worked. **Editing the row's `config`** hot-replaces the plugin
  instance (config.md: "A configuration edit hot-replaces the plugin"), but the module
  namespace is Node's ESM cache: the Loader imports entries through `import(fileURL)` with no
  cache-busting (`vendor/loader/src/config/entry.ts:280` → tree import), so **source changes
  do not reach a running process without a restart**. Empirically confirmed: the token-gate
  code was added to the source and a `config:` block to the insert row; the running instance
  kept serving the old handshake shape (no new fields) while the same file loads the new code
  cleanly under standalone Node. Consequence: the M1 instance runs the pre-token action
  channel until the next restart (acceptable — M1 is read-only; §7 R4), and M4's
  `dsh plugin add` restart activates the current code.
- Pipe standalone run (native-frame harness, no Chrome): `initialize` →
  `{serverInfo:{name:'dsh-augmentor-pipe', version:'0.1.0', dshVersion:'0.0.1', home, cwd, attachedSessions:6, transport:'dsh-api-pipe'}}`;
  `augmentor/models` → legacy catalog shape (3 groups; default `mx-qwen`/
  `Qwen3.8-27B-UD-Q6_K_XL`); `session.list` → all 30 sessions with `projections.values.title`;
  unknown method → clean error envelope; both downlinks open and the `session/subscribed`
  recovery baseline arrives; the action WS connects carrying the token (the pre-token
  instance ignores the query param — a safe version skew: new-plugin/old-pipe refuses
  loudly, old-plugin/new-pipe connects).
- **Dev pitfall (this box, Node 24.19.0), for the record while debugging the ordering
  bug above:** temporary diagnostic scaffolding combining a `setInterval` poll with a
  `globalThis` property write (and diagnostic arrow fns calling `ctx.get(name, false)`)
  triggered *misleading* engine errors in the stripped module — e.g. `TypeError:
  setInterval(...) is not a function` reported on an innocent following line, while
  `typeof setInterval` read `function` two lines earlier; the same statements in a small
  module, or the identical statements with any one piece removed, ran clean, and the
  amaro-stripped output (Node 24.19.0 ships amaro 1.1.10; byte-identical to npm
  amaro 1.1.11 for this file) is verified clean as plain JS. It behaved like
  a source-text-sensitive V8 anomaly, not a logic bug. The production code contains none
  of those constructs (no timers, no global writes) and is verified green under the real
  loader; if plugin code on this box ever throws a `…(...) is not a function` error at a
  line that doesn't make sense, suspect this first before re-reading the logic.

**Install route decision (supersedes §9's helper sketch).**
- **M1 (dev, this box):** insert row in `~/.dsh/cordis.patch.yml` with an **absolute path**
  to the **source `.ts` entry** (no build step in dev — type stripping, verified above) → the
  app's patch live-watcher mounts it **without restarting** the running server. Dependencies
  (dsh-tools etc. at 0.1.1-rc.2) install into the plugin's own `node_modules` so Node
  resolution from the plugin file finds them. Caveat: *source edits* need a restart to
  reach the running process (reload semantics above); the row's `config` is the documented
  hot-replace lever for config-only changes.
- **M4 (distribution):** the bundle manifest + `dsh plugin --profile web add
  github:ManoloRemiddi/augmentor#<sha>` (prepare + allowBuilds) or a tarball; the home-patch
  row is then optional. `dsh plugin add` re-composes the profile and needs a one-time app
  restart — fine for install, not for dev iteration.
- The plugin `inject`s only `tools` (present in every composition); `webServer` and
  `settings` are consumed via optional `ctx.get()` so the plugin never PENDs in a
  non-web profile.
