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

**Empirical scope refinement (M1, 2026-08-25 — server-side, replaying the extension's
exact headers).** The fence lives in the api-proxy's method routing, not in the web
server's route table: the web server consults its **exact table before the prefix table**
(`packages/host/webserver/src/index.ts:256-266` — "Longest-prefix-wins over the prefix
table *after an exact-table miss*"), so routes a plugin registers itself are dispatched
before the fenced `/api` prefix route is ever consulted. Re-running the probe headlessly
(node fetch carrying `Origin: chrome-extension://dgfpmlnbofacjafljfohgmfacobgfjbh`,
`sec-fetch-site: cross-site`, `sec-fetch-mode: cors`, `sec-fetch-dest: empty` — the fence
reads only `Host` + `sec-fetch-site` + `origin`, so this is byte-equivalent on the
decision axes) gives a split verdict, persisted in
`trace/fence-probe-headless.json`:

| Request (all with `Origin: chrome-extension://…`, `sec-fetch-site: cross-site`, `Host: 127.0.0.1:3080` unless noted) | Result |
|---|---|
| `GET /api/augmentor` — plugin exact route | **200** (handshake JSON — fence bypassed by exact-table precedence) |
| `GET /` — static control | 200 (ungated) |
| `POST /api/session.list` — stock method route | **403**, body `forbidden` |
| `POST /api/session.list` — same path, **no** browser markers (node UA, no Origin) | **200** — reaches the RPC bridge (structured `bad-request` on the non-envelope body: fence passed, validation next) |

The fourth row is the control that attributes the 403: same method, same path, only the
browser markers removed → the request sails through the fence to the RPC layer.

Consequences: (1) the SW-direct probe documents a split verdict — the plugin handshake is
cross-site-reachable, the stock methods are refused; (2) the pipe remains the primary
transport for the API either way (the plugin route serves a public handshake only, no
session data, no credentials); (3) the unfenced exact route is an accepted reachability
posture of our own route — the only sensitive surface on it, the action WS upgrade
(`/api/augmentor/ws`, also an exact-table entry outside the fence's two downlink
wrappers), is token-gated (§7 R4). The client-side half (a real SW fetch of all three
paths) is built into the panel's fence strip and lands in `trace/fence-probe.json` when
the user clicks Probe; expected to match the headless run row for row.

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
- **Native-messaging frames are capped at 1 MiB host→extension** (current official docs:
  "The maximum size of a single message from the native messaging host is 1 MB"; the
  extension→host direction is 64 MiB). This is the one wire limit that bites us: a full
  DSH session history is chunk-heavy — one event per streamed token — so it measured
  **10.8 MB** for a 99-message session and **92 MB** for a 500-message tail on the live
  app (2026-08-25, M1 verification). The API pages backwards natively
  (`beforeSeq`/`maxMessages`, `packages/host/apiproxy/src/api/sessions.schema.ts:141`),
  but a 500-message page still overshoots the cap, so `shapeHistory` in the pipe shapes
  every `session.history` response: (1) strips `assistant/chunk` events — the panel
  renderer renders whole turns from `assistant/message` (its text is authoritative,
  "covers providers without chunks"), chunks only matter for *live* streaming, where they
  arrive as tiny individual downlink frames; (2) keeps the **newest** events and drops
  from the oldest side until the frame is under an 850 KiB budget, reporting
  `truncatedEarlier`. Verified on three live sessions: 846/848/847 KiB on the wire, all
  under the cap, newest context intact (turn-end / tool-call tails).

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
   (§2.4) holds: replaying the extension's exact headers (`Origin: chrome-extension://…`,
   `sec-fetch-site: cross-site`) against a live method route yields **403 `forbidden`**,
   while the plugin's exact route returns 200 (exact-table precedence, §2.4 table), and
   the no-marker control on the same method route returns 200 (fence passed, RPC
   validation next) — the 403 is attributed, not just observed. Persisted in
   `trace/fence-probe-headless.json`. The client-side half — a real SW fetch of
   `/api/augmentor` + `/` + a POST to `/api/session.list` — ships as the panel's fence
   strip (Probe button) and records `trace/fence-probe.json` on click. **Done in real
   Chrome** (151.0.7922.169, headless=new + CDP via `test/chrome-e2e.mjs`, fresh
   profile, user's browser untouched): the persisted artifact matches the headless run
   row for row — plugin exact route **200** (body carries the `dsh-augmentor`
   handshake), `/` **200**, fenced `/api` request **403 `forbidden`**. The protocol
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
  **Prompt loop done (2026-08-25).** The SW's chat identity doubles as the DSH session id
  (`session.create {sessionId: <id>, cwd}` — the wire accepts any non-empty id, so live
  downlink events, which carry the DSH session id, route straight into the chat filter;
  the id is stored in `chrome.storage` and resumed on reconnect with its history replayed).
  `send → session.prompt {mode: 'queue', content: [{type: 'text'}]}`, `Stop →
  session.cancel`, the model picker switched early from M3 onto `session.selectModel`.
  The pipe's `augmentor/models` now carries `provider` on every model entry (the legacy
  panel contract reads it per row — omitting it made picker clicks send
  `{provider: undefined}`, the user's first send error). Accepted in real Chrome
  (`test/m2-e2e.mjs`, CDP): prompt → assistant reply rendered in the panel (default model
  deepseek-official/deepseek-v4-flash), picker round-trip (DeepSeek-V4-Flash →
  Qwen3.8-27B local), created session visible in `session.list`, M1 regressions intact
  (403 fence row, target session renders 262 KB). **Browser tools + veil round-trip
  done (2026-08-25) — M2 complete.** The plugin registers the full M2 set
  (`browser_tabs_list / navigate / snapshot / click / type`; schemas in the
  value-schema DSL, `commandTimeoutMs` 30 s for navigate). Two footnotes from
  acceptance: **(1) zombie live instance.** A JSON-Schema `required` array throws
  `JsonSchemaError` at `defineTool` under dsh-tools, which aborts the plugin's
  `apply()` *after* the webServer routes are already registered (they are set up
  imperatively, no disposer in that vintage) — a running server that first imported
  the pre-fix source therefore keeps a zombie instance: handshake alive, pipe
  channel up, **zero tools registered, no token gate**. ESM never re-imports plugin
  source in a live process (the web bundle mounts watch-only HMR with an empty
  module root), so **a restart is the only fix** — no code change needed; the next
  boot loads the fixed source (all five tools + token gate). **(2) acceptance
  evidence** (`test/tools-e2e.mjs`): isolated `dsh web` boot (throwaway DSH_HOME
  symlinking profiles/settings/`.credentials.yaml`/… + token overlay →
  `wsTokenSource=config`), real headless Chromium + the real extension + the pipe
  pointed at the isolated server, local test page. The agent turn (app-default
  deepseek-official/deepseek-v4-flash) called the five tools in the exact
  instructed order — `session.history` `tool/call` sequence
  `[tabs_list, navigate, click, type, snapshot]` — and reported `TABS=2
  STATUS=CLICKED ECHO=hi M2`; the real page DOM was asserted independently
  (`#status`='CLICKED', `#box`/`#echo`='hi M2') and the **frost veil was observed
  on the worked tab** (250 ms CDP sampling, `veilSeen=true`). The harness retries a
  turn that dies on the known-flaky CloudFront route to api.deepseek.com before any
  tool ran (measured 2-in-3 requests timing out for minutes at a time from this
  network) and judges tool order on `tool/call` events, not name occurrences (tool
  names also appear in the request/context schema block). *M2 exit — a full
  browser-agent conversation through the extension, driven by the user's own DSH
  model — is met on a fresh boot; the user's running server gains everything (five
  tools, token gate) on its next restart.*
- **M3 — awareness, sessions & parity**: session picker/search, **Save button + Augmentor Chat workspace + housekeeping sweep**
  (§5) (model picker done early with M2 — `session.selectModel` on the live session), **Open-in-DSH button**, approval/question UI, keep-alive tuning, settings
  (host-side namespace + panel-owned UI — in-page GUI card deferred, §10; incl. dedicated
  directory + retention), endpoint options.
  **Slice 1 done (2026-08-25): Save/Unsave + Augmentor Chat workspace + housekeeping +
  Open-in-DSH (Option A) + cwd pinning.** Wire: panel → SW `save`/`unsave` → pipe
  (`PLUGIN_METHODS` forwarded over the token-gated plugin WS, 30 s waiter) → plugin
  `augmentor/save|unsave|state` → workspace `attachSession`/`detachSession` on the
  idempotent `registry.create(chatDir, 'Augmentor Chat')`; handshake carries `chatCwd` +
  `saved` so the SW creates sessions **with `cwd = chatDir`** (mandatory: the entity
  validates `realpath(cwd) === workspace path` — mismatched sessions get a friendly
  "start a new chat" error instead of a raw throw). Sweep (boot + interval, config
  `retentionDays` 14 / `deleteAfterDays` 0 = archive-only default / `sweepEveryMs` /
  `sweepFirstDelayMs`) archives stale unattached chat-dir sessions and optionally
  `rmSync`s their located artifacts; timer disposers ride the plugin fiber. Boot test
  extended to the full lifecycle (`session.create` → rename to materialize the artifact →
  save → `workspace.list {items}` shows the attach → unsave → state → sweep archives) —
  **ALL PASS** on a fresh isolated boot. Footnotes from acceptance: **(1) `ctx.effect`
  semantics** — `ctx.effect(setup)` runs `setup` *immediately* and disposes what it
  *returns*; the first sweep-timer version put the `clearTimeout` inside the setup body,
  so the boot timer cleared itself at apply and the sweep never ran (zero log lines —
  found by instrumentation, not by test assertion, because a silent sweep is not a test
  failure). **(2) `workspaceRegistry.resolveByPath` is async** — a sync call site makes
  the "workspace" a Promise and `detachSession` is `undefined`. **(3) boot-test
  isolation**: `storages` must be **copied**, never symlinked — the workspace table is
  written on attach/sweep, and a symlinked test leaked two `Augmentor Chat` workspaces
  (same session id accounted twice) into the user's real `~/.dsh/storages/workspace.json`;
  `validateStoredState` then refuses boot on double-accounting (cleaned with backup;
  `workspace.json.bak-m3-cleanup`). **(4) zero-event sessions have no persistence
  artifact** — the sweep lists artifacts, so a `session.create`d chat is invisible until
  its first event (true for real chats before the user's first message; the test
  materializes via `session.rename`, which appends a `session/title` event with no LLM).
  **Deploy = config hot-replace, no restart** — with a correction to the docs: a
  config-ONLY edit re-applies the *ESM-cached* module (the loader's update diff
  re-imports only when `name`/`inject`/`group` change — same ESM-cache wall as the
  M2 zombie), so the live row's `name` pins the vintage with a query string
  (`index.ts?src=<commit>`); bumping it makes the running server re-import the
  specifier, dispose the old fiber, and apply the fresh source in place. The
  pipe's plugin-WS reconnect picks the channel back up (verified on the live
  server: `chat dir ready` + handshake `chatCwd` within ~1 s of the edit, no
  restart). **Panel E2E done (`test/m3-e2e.mjs`, real headless Chrome, real SW +
  NMH pipe, LIVE server + real registry, local Qwen turn): connect → M3 buttons
  present → prompt → the SW created the session in `~/Augmentor` (cwd pinning) →
  #save tap flips the badge AND `workspace.list` shows the attach → tap again
  clears the badge + detach → #openindsh opens a new tab at the app endpoint →
  probe session archived (the sweep's end state). The whole slice-1 chain is
  verified against the user's actual deployment; what remains is the user's own
  browser reload (their SW is still the M2 code in memory) + a confirming tap.
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
- **Browser-half wiring state (verified 2026-08-25).** The native host manifest is
  installed at `~/.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json`
  → `bin/pipe-host.sh` → `node pipe.mjs`, with `allowed_origins` naming the extension's
  **key-derived** id `dgfpmlnbofacjafljfohgmfacobgfjbh` (deterministic — the manifest's
  `key` pins the id regardless of install). Per the current official docs the extension
  side needs only the `nativeMessaging` permission (present; there is no
  `native_host_permissions` manifest key in Chrome). The extension **is loaded** in the
  user's Chromium (`extensions.settings` entry for the id, path `augmentor/extension/`).
  Remaining step: side panel → Connect → Sessions → open a conversation → Probe.
  **M1 browser-half acceptance — done in real Chrome (2026-08-25).**
  `test/chrome-e2e.mjs` drives the real flow in the user's own browser binary
  (Chromium 151.0.7922.169, headless=new + CDP, fresh user-data-dir, user's browser
  untouched): `#connect` → **connected** (real SW `connectNative` → host-manifest
  pipe → live server), `#sessions` → **32 rows**, **Probe** → `trace/fence-probe.json`
  with the **403 `forbidden`** fence row (real Chrome fetch metadata), target session
  row → **262 KB of the DSH conversation rendered** (4 user + 58 assistant bubbles,
  session title correct, newest user message text in the DOM). The pipe trace carries
  the real-SW fingerprint: first frame **`c1` / `augmentor/models`**, max frame
  846 KiB < 1 MiB. Every M1 component is thus verified in the production stack; the
  user's own click (extension already loaded in their profile) reproduces the same
  panel. Pre-flight for it had been proven headlessly, two levels deep. `test/sw-e2e.mjs`
  runs the **real `sw.js`** (vm) against the **real pipe** (spawned via the host
  manifest, origin argv) against the live server — handshake reaches `ready`,
  `session.list` returns 32 sessions, `session.history` returns a shaped frame (414
  events for the 99-message DSH-plugin session, 846 KiB on the wire, zero
  `assistant/chunk`, final + user messages present), and `fence/probe` persists
  through the pipe. `test/panel-e2e.mjs` goes one level further: the **unmodified
  `sidepanel.js` + `chat-render.js` module graph in jsdom** on top of the same real
  SW + pipe — clicking `#connect` reaches `connected`, `#sessions` lists 32 rows,
  the Probe strip persists through the pipe, and clicking the DSH-plugin session row
  renders **262 KB of conversation into `#log`** (4 user + 58 assistant bubbles,
  session title shown, the newest user message's text present in the DOM). What the
  harnesses cannot prove is Chrome executing the same JS — the click remains the
  acceptance step. Caveat: the harness probe uses Node fetch (no Origin marker →
  the fenced row reaches the RPC bridge instead of 403-ing); the 403 verdict itself
  stands on the header-exact headless probe and on Chrome's real SW.

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

## 11. Addendum — the persona: `augmentor` agent preset (2026-08-25)

**Symptom.** After the M1–M3 plugin migration the panel agent no longer
behaved as Augmentor: on "no browser client connected" it dropped the
contract and improvised (headless Playwright, hunting debug ports, "let me
inspect the Augmentor browser bridge"). The old bridge never showed this.

**Root cause.** The old bridge injected the persona as
`DSH_SYSTEM_PROMPT` (bridge.mjs `initialize` cwd + `persona.md` → the
agent-spine `persona:` config). The plugin migration dropped it: panel
sessions were created with no `agentPreset` meta, so they ran the
deployment default — the `standard` preset, a generic coding persona.
The browser_* tools themselves were always visible (root-realm plugin
registration reaches every session); only the identity was missing.

**Fix (commit ec3ceb9) — the old solution, ported to the preset
mechanism.**
- `presets/augmentor/` (source; installed at
  `~/.dsh/.agent-presets/augmentor/`, the user preset root the roster
  always scans) — an AGENT-PLANE composition:
  - **persona**: the old `persona.md` adapted to the five browser_* tools
    (sticky work tab, frost veil, pulse-on-click), plus the failure rule
    that killed the observed drift: *no browser client connected = the
    extension is not attached → tell the user, never launch/improvise a
    browser*;
  - **surface**: bash, fs, fs-search, todo, subagent (spawn/fork), and the
    standard preset's plan-mode/compaction blocks verbatim. No background
    jobs, no skills, no goals, no ask-user (the panel has no answer path
    for questions — an unanswered ask would stall the turn).
- **plugin**: `config.agentPreset` (default `augmentor`), exposed in the
  GET handshake body (folded into the pipe `initialize`).
- **sw.js**: stores the handshake value and passes
  `session.create {agentPreset}` when present — degrades to the app
  default when the roster lacks the preset instead of failing creation.
- **tests**: boot test asserts the handshake carries the preset and that
  `session.create` under it succeeds with the preset in the artifact
  header; m3-e2e asserts the SW-created session header carries it.

**Note.** Existing panel sessions keep their creation-time preset — the
persona applies from the next new chat (the panel "New chat" button).

## 12. Addendum — Playwright-MCP drift, veil hold (2026-08-26)

**Symptom.** The persona worked for the first ~8 steps of a real task, then
the agent drifted: after two failed `browser_click` selectors it switched to
`mcp__playwright__*` tools and got lost between two browser interfaces. The
frost veil flickered on/off between steps instead of holding for the turn.
In-app (DSH web app) sessions named for browser work were equally confused:
the user said "I'm already logged in", but the agent acted on a browser the
user could not see.

**Root cause (three independent faults).**
1. **Playwright MCP on every session.** The user's web-profile patch
   (`~/.dsh/profiles/web/cordis.patch.yml`) mounts `@deepseek-ai/dsh-mcp-client`
   (`serverName: playwright` → `mcp__playwright__*`) in the profile ROOT
   realm, driving its own headless Chromium (`--headless`, private
   `--user-data-dir`). Root-realm tools reach every session — including
   `augmentor`-preset ones — and `dsh-mcp-client` has no per-agent scoping.
   The model, mid-failure, found a second, richer browser toolset and took
   it. Its headless profile has none of the user's logins, which is exactly
   why the "I'm already logged in" mismatch appeared in-app: the standard
   preset gives no guidance, so the model picks Playwright (20 tools) over
   `browser_*` (5) and works in the invisible, logged-out browser.
2. **Veil hold was dead code.** `sw.js` declared `turnActive` as
   "true from prompt to turn/end" and the `turn/end` handler cleared it, but
   no code ever SET it — so `overlayShow` always armed the 4 s per-action
   idle fade and the veil dropped between steps (each one re-raised it).
3. **In-app sessions carry no preset picker.** The web app creates sessions
   on the deployment default (`standard`); a session's preset is
   creation-time meta, so the pre-persona in-app session cannot be converted
   in place.

**Fix.**
- **Persona v2** (`presets/augmentor/agent.cordis.yml`): a new section,
  *Other browser tools are forbidden* — named prohibition of
  `mcp__playwright__*` (and any non-`browser_*` browser tool) with the
  reason the model can weigh on its own: they drive a DIFFERENT, headless
  browser without the user's logins — plus the recovery rule for the exact
  observed drift trigger: selector matched nothing → snapshot, pick a
  selector from the real content, never switch browser tools.
- **sw.js**: `turnActive = true` when the `session.prompt` accept lands
   (only on a real accept — a rejected prompt must not hold a veil). The
   veil now holds for the whole turn (first action raises, `turn/end`
   shows "Done ✓" and fades — the existing path), which is the intended
   "on while the AI controls the browser" semantics.

**Deployment notes.**
- Preset discovery is UNMEMOIZED (`agent-presets` re-reads the roots on
  every `resolve()`), so the new persona reaches new sessions on the running
  server with no restart and no plugin change — no `?src=` bump needed.
- The SW change requires a one-time extension reload; then a NEW panel chat
  exercises both fixes (the five `browser_*` tools stay the only browser
  surface, the veil holds across the task).
- The Playwright MCP stays mounted: it is the user's own headless
  automation for DSH sessions. The product boundary is now explicit — the
  PANEL is Augmentor (real browser, persona); in-app sessions are ordinary
  DSH (Playwright = a separate, invisible browser).

## 13. Addendum — header iconification + extension identity (2026-08-26)

**Change.** The side-panel header carried six text labels (＋ New chat,
☆ Save, DSH ↗, Connect, ≣ Sessions, plus the hue disc) — crowded at
side-panel widths. All actions are now 26px icon squares (16px stroke
icons, `currentColor`, tooltips + aria-labels keep the words): new chat
(bubble+plus), save (star — FILLS in the accent when saved, replacing the
old "✓ Saved" text), open-in-DSH (external link), connect (link, brand
fill, auto-hidden by `updateChrome` when ready/connecting as before),
sessions (list). The word "Augmentor" now sits next to the site's frost
mark (`website/favicon.svg`, copied into the extension as `favicon.svg`),
which also becomes the tab favicon.

**Extension identity.** `manifest.json` gains `icons` + `action.default_icon`
(16/32/48/128 PNGs rendered from the same favicon SVG) — the extension
finally has a face in chrome://extensions and the toolbar (it had none).
Version 0.1.11 → 0.1.12.

**Verified.** Headless-Chromium geometry probe of the real `sidepanel.html`:
no header overflow at 300/340/400px, both connected and disconnected
states; status text fits at the 400px default width.

## 14. Addendum — auto-connect: the Connect button is gone (2026-08-26)

**Problem.** The panel's Connect button was the *only* thing that ever called
`ensurePort()`: after an SW idle-kill, a pipe death, or a DSH restart the
panel sat "disconnected" until a human pressed it. One more thing for the
user to learn, and an icon that mostly just sat there.

**Design.** Always-connected, two drivers, no button:
1. **Boot connect** — `sw.js` now calls `ensurePort()` at the top level of
   every SW boot (cold start, idle-kill revival, browser restart, extension
   reload). `ensurePort`'s existing guard (port open / phase `connecting`)
   makes concurrent triggers a no-op. The panel's first message wakes a cold
   SW, so opening the side panel *is* the connect.
2. **Backoff retry** — `fail()` arms `scheduleReconnect()`: 1s → 2s → 4s →
   8s → 16s → 30s steady (capped so a dead DSH never spins the native
   host; fast enough that a recovered DSH is picked up within seconds with
   zero user action). `retryCount` resets on `ready`.

**UX.** Header loses the Connect icon (the other five stay). The status
line's error state is now `reconnecting… (last error)` instead of
`error: …`, and the dot pulses red while failing — the state is transient
by design, so the UI says what is happening, not what to click. The
`'connect'` SW message type survives for the `?task=` test hook
(`send('connect')` replaces the removed button click).

**Tests.** `panel-e2e.mjs` and `m3-e2e.mjs` no longer click anything: they
wait for `connected` to arrive unaided. Both pass — panel-e2e (real sw.js
in a vm, real pipe, live server) and m3-e2e (real Chromium + real SW + NMH
pipe + live DSH), which also got its badge assertions rewritten for the
icon-only Save star from §13 (it still read the old `☆ Save` text and
would have failed on the 0.1.12 build).

## 15. Addendum — brand link, auto-contrast Send, user bubble (2026-08-26)

**Brand.** The header title is now a link: **Augmentor** (bold 12.5px) +
*powered by DSH* (italic 9.5px, `--text3`) pointing at
`https://augmentoragent.com/` (`target="_blank"`). The `#title` span stays
dynamic — a session's name still lands there (chat-render's title event);
the italic suffix is the constant brand tail. Hover tints the word in the
accent. Status font 11 → 10.5px so "connected" still fits at the 400px
default width with the wider brand (geometry-probed at 340/400/480).

**Auto-contrast Send.** `theme-tokens.js` gains `contrastOn(rgb)`: WCAG
relative luminance; white stays while it holds ≥ 3:1 against the accent
(the shipped look — white on brand blue is 3.37:1 and is kept), then the
label flips to `#000` once the accent is brightened past pastel (below
3:1 black is always strictly better, so no second comparison). `panelTheme`
emits `--on-brand` alongside `--brand`; `#send` and the theme-settings
segment control use `var(--on-brand, #fff)`. Verified: default blue → #fff;
blue/green/yellow/pink at +15 → #000; black at −15 → #fff.

**User bubble.** `user/message` already built `.msg.user` (You + userbody);
it now sits in a faint accent wash — `--brand-soft` (brand at 16% alpha,
emitted by `panelTheme`, so it follows hue + brightness + theme) with
10px radius. Noticeable without shouting, per the ask.

### 15.1 — The top strip is Chromium's, not the panel's (0.1.15)

User feedback (screenshot, 2026-08-25): the "Augmentor powered by DSH" text
at the very top of the panel was the intended edit target, and the new brand
element in the header read as an unwanted duplicate. Source-traced through
Chromium (`side_panel_header_controller.cc` / `side_panel_util.cc`): the
olive strip above the panel is the browser's **native side-panel header** —
a `views::Label` on the toolbar colour plus the panel's pin + close
controls, titled from the extension's own identity (manifest name / action
text) and badged with the extension icon. An extension cannot make that
label a link or apply bold/italic to it — the only controllable aspect is
the plain text.

Resolution: the strip's text was shortened to just **Augmentor** (manifest
`name` and the page `<title>` — whichever the build sources it from now
say the same thing), so the strip reads as a plain app title, and the full
*Augmentor powered by DSH* bold+italic brand — the only place it can be
styled and linked — lives in the header row directly below it. No
duplicated text; the requested design is intact where the platform allows.

### 15.2 — Final agreed form: strip text, title row, double-click rename (0.1.16)

Agreed with the user after the 15.1 exchange (which is superseded):

- **Top strip** (Chromium-drawn, plain text only): reads
  **"Augmentor Agent powered by DSH"** — the website's name rides in the
  strip text, since the strip itself can never be a link. Manifest `name`
  and page `<title>` both say this.
- **Header row** is dedicated to the **chat title** again: the 15.0 brand
  anchor + "powered by DSH" suffix are gone; `#title` is a plain bold span
  (the live session name, "Augmentor" until DSH titles it). The connection
  `#dot` was removed — state lives in the `#status` text.
- **Header order** (left → right): **Expand** (`#openindsh`, first —
  tooltip reframed "Expand into the full DSH session"), favicon, chat
  title, (status text, right-aligned), new chat, save, theme+colour. The
  sessions browse button was not in the agreed order and stays last, to be
  removed on request.
- **Double-click rename:** double-clicking the title swaps in an inline
  input (pre-filled, selected). Enter/blur commits, Esc cancels. Commits go
  panel → SW (`session/rename` handler) → pipe `session.rename
  {sessionId, title}` — the same unary the GUI uses; DSH normalises, pins
  the user title (auto-titling never overwrites) and pushes the
  `session/title` event back, which chat-render re-asserts. Renaming is
  live-chat only: the M1 browse view is read-only and the handler no-ops
  there or when no session id is known yet.
