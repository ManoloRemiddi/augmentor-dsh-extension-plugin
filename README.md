# Augmentor powered by DSH

Augmentor is a proof-of-concept Chromium extension that drives a DSH harness **sidecar
agent** which controls the user's real browser.

```
┌─ Chromium (MV3 extension) ────────────────┐      ┌─ Sidecar (Node process) ─────────────────┐
│ sw.js: native port + browser executor     │      │ dsh runtime (jsonrpc composition)        │
│  ├─ connectNative('com.deepseek.dsh.augmentor')────> bridge.mjs (native messaging host)         │
│  ├─ popup: chat UI over session events    │      │  ├─ spawns dsh-jsonrpc-agent (stdio NDJSON)
│  └─ executes browser/execute requests     │      │  └─ HTTP relay ←── dsh-browser CLI       │
└───────────────────────────────────────────┘      │        (model calls it via the bash tool) │
                                                   └───────────────────────────────────────────┘
```

**Design decisions Augmentor makes deliberately (temporary name and scope, to be re-evaluated):**

- Browser actions reach the model through the **existing `bash` tool** + a
  `dsh-browser` CLI shim, not a new in-harness plugin. This keeps Augmentor at
  zero harness code changes. The production design will register real
  `browser_*` tools on `ctx.tools` and use the SDK transport's reserved
  server→client request channel instead of the HTTP relay.
- The model set mirrors the **DSH app's user plane**: the runtime mounts the
  same plugins the app mounts (`dsh-settings-file` reads
  `$DSH_HOME/settings.yaml`; `dsh-credentials-local` layers the process env
  over `~/.dsh/.credentials.yaml` over `.env`), so the sidecar offers exactly
  what the DSH app offers — the `llm-pi-ai:` routes in the user's settings
  (the local llama.cpp models) plus the built-in `deepseek-official` route
  (flash / flash-vision / pro, key resolved per request from the credential
  store). No route is hand-declared in the sidecar composition, which is what
  keeps the two from drifting. The composer strip's model chip is a **model
  picker** (the DSH GUI's picker mirrored in plain HTML/JS): the bridge serves
  the catalog from the settings document, the selection persists in
  `chrome.storage.local`, and a mid-conversation switch restarts the runtime
  process — the session keeps its id and resumes from its persisted log on the
  new model.
- The composer's **Stop** button aborts the live turn over the wire: a new
  `session/interrupt` SDK RPC calls `agent.cancel({ kind: 'user' })`, which
  aborts the active step and clears the pending inbox. The turn settles with a
  `turn/end` (`reason.kind === 'aborted'`) and the agent returns to idle — the
  **session and its context are preserved**, so the next prompt resumes the same
  conversation. (This required a small DSH change: `session/interrupt` in the
  SDK protocol + server, then a host-face rebuild — see *Dependencies*.) "New
  chat" still abandons the session entirely (fresh `sessionId`, the runtime
  lazily creates a new agent+session pair) and clears the panel; the old session
  simply goes idle server-side.

## Files

| File | Role |
|---|---|
| `bridge.mjs` | Native messaging host: Chrome port ⇄ runtime stdio re-framing + browser-action HTTP relay + the bridge-local model methods (`augmentor/models` serves the DSH app's catalog from `$DSH_HOME/settings.yaml`; `augmentor/switchModel` restarts the runtime process for the new selection). Logs every frame to `trace/`. |
| `dsh-browser.mjs`, `bin/dsh-browser` | CLI the model runs via bash; POSTs to the bridge relay. |
| `persona.md` | System prompt (browser-agent rules + dsh-browser usage). |
| `extension/` | MV3 extension: `sw.js` (port owner + action executor + session owner, full session log with `sinceSeq`-trimmed sync, per-turn active-tab targeting incl. new-tab pages, on-page AI-control overlay: a **frost veil** — WebGL domain-warped heightfield lit as thin ice (moving specular glints, fresnel rim, cavity shadow, self-shadow) with a parallax depth-banded snowfall in front; condenses in (edges first) and melts out, low-resolution canvas with automatic quality drop; falls back to the legacy 3-layer CSS fog (same keyframes) without WebGL, under reduced motion, or behind the `__dshAugForceFog` test hook — + bottom-center status pill + click/type pulse-and-ripple, plain-language status labels (element text, never selectors); the indicator lives for the whole turn and fades only after "done"; the veil's palette and the pulse/ripple colors follow the user's **accent** (hue + brightness) — synced from `chrome.storage.local` at boot and on change (the `storage` permission is mandatory: without it `chrome.storage` is undefined in the SW and an unguarded read throws), always passed to the injected `show(text, done, hue, bright)`), `veil.js` (the frost veil itself, self-contained: GLSL shaders + CSS-fog fallback + pill + condense/melt lifecycle + optional glyph variation (the same waves rendered as a field of falling numbers/symbols, `window.__dshAugVariation = 'glyphs'`, off by default), idempotent, **all 16 palette colors are derived from the accent** — each role is the accent hue plus a fixed offset/sat/light triple (lightness then shifted by the accent brightness: the + side headroom-scaled so the extremes can't merge, the − side fading to full black — at −15 every role is pure black), so the palette's internal spread is preserved for any accent (142/0 reproduces the original green exactly); `show(text, done, hue, bright)` re-tints live: pill/label, fog divs, and the GL uniforms (frost + snow, program re-bound before upload), hue/brightness omitted ⇒ 142/0 for lab parity; exposes `window.__dshAugVeil.{show,fade,pointer,debug}` and bridges live state incl. the active hue + brightness to the main world via `root.dataset.veil`), `sidepanel.html`/`sidepanel.js` (side-panel chat UI, DSH-GUI parity: Think blocks, compact tool rows, stats line, **hue icon + color popover** (Light/Dark theme switch at the top, then neutral-surface hue 0–360 + brightness −15..+15, accent hue with swatch + accent brightness −15..+15 — the − side fades to full black — all with live readouts, mini veil-pill preview, reset), jump-to-top), `chat-render.js` (renderer, stick-to-bottom scrolling), `theme-tokens.js` (shared color math — the single source of truth for the tunable palette: HSL→RGB, per-theme neutral surface tokens with headroom-scaled brightness (offset is scaled so the extremes can't clamp-collapse the layer spacing), per-theme accent triples (shipped brand exact in both themes) + accent brightness (`accentLight`: + side additive, − side fades to full black), the 16-role veil palette spec + headroom-scaled brightness; `panelTheme`/`applyPanelTheme`/`veilPalette`; loaded by theme-boot.js, sidepanel.js and — via `importScripts` — sw.js; the copy in veil.js must stay in sync), `theme-boot.js` (pre-paint restore of theme + all four color settings from localStorage; a file because MV3's extension-page CSP blocks inline scripts), `vendor/marked.min.js` (markdown, HTML-escaped before parse), `manifest.json` (permissions incl. `storage` — required for the SW's accent sync). |
| `install-native-host.sh` | Writes the native host manifest into the Chromium profile. |
| `cdp.mjs`, `lab-overlay-verify.py` | Lab tools (not shipped): CDP helper (`targets`/`newtab`/`eval`/`shot`/`bcmd`) and the overlay verification driver (DOM + pixel assertions; mode-branching snap stage: webgl asserts canvas + live frame counter, fallback asserts the 3-layer CSS fog). |
| `lab/veil-preview.html`, `lab/veil-metrics.py` | Lab tools (not shipped): A/B preview page for the veil (light/dark page, show/done/fade/dark + frost/glyphs/fog switcher, live debug readout; `?mode=fog` forces the CSS-fog fallback, `?mode=glyphs` the characters variation, **`?accent=<hue>` / `?accbright=<-15..15>` set the accent** — plus live accent hue + brightness sliders in the bar that re-tints the running veil) and the quantitative screenshot metrics (relief, texture, green dominance, see-through correlation, parallax/flow diffs — the stand-in for visual inspection). |
| `../deepseek-harness/examples/jsonrpc-agent/augmentor.cordis.yml` | Runtime composition (untracked file in the repo). |
| `trace/*.jsonl` | Per-run frame traces (bridge; every wire frame, both directions). |
| `sessions/*.jsonl` | Runtime session logs (uncompressed for inspection). |

## DSH runtime dependency

The sidecar runs a **local clone** of `deepseek-harness` (resolved by
`bridge.mjs` from `$DSH_AUGMENTOR_CLONE`, default `../deepseek-harness`). The
runtime loads the **built `lib/`** artifacts of that clone, not source, and the
`session/interrupt` method used by the Stop button lives in two files that are
not part of stock DSH:

- `packages/sdk/protocol/src/types.ts` — `SessionInterruptParams` /
  `SessionInterruptResult` + the `'session/interrupt'` request-map entry.
- `packages/sdk/server/src/server.ts` — the `session/interrupt` handler, which
  calls `agent.cancel({ kind: 'user' })` and reports `interrupted` from
  `agent.status === 'running'`.

If you re-clone or update `deepseek-harness`, re-apply those two edits and
rebuild the host face from the clone root:

```sh
cd deepseek-harness
npm run build:lib:host      # = tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host
```

Without the rebuild the runtime answers `session/interrupt` with
`unknown DeepSeek Harness SDK runtime method` and Stop fails open (the turn
keeps running).

## 1. Browser leg (real Chromium)

1. **Load the extension**
   `chrome://extensions` → Developer mode → *Load unpacked* → select `augmentor/extension/`
2. **Install the native host**
   Note the extension id, then:
   ```sh
   ./install-native-host.sh <extension-id>
   ```
   (launch Chromium from a terminal where `node` resolves, or `NODE=/abs/path ./install-native-host.sh …`)
3. **Use it**: click the extension icon (opens the **side panel**) → *Connect*
   → status dot turns green (that click also starts the sidecar: Chrome spawns
   the bridge, which spawns the runtime). Send a prompt, e.g.
   `Open https://example.com and tell me the page title.`
   *＋ New chat* in the header starts a fresh session (UI reset, stats restart,
   new `sessionId` on the wire). While a turn runs, the composer's **Send** button
    is replaced by a **■ Stop** button: clicking it aborts the live turn (the
    on-page overlay reads "Stopped" and the status returns to *connected*), and
    the session stays live — the composer remains usable, so a new prompt
    (Enter) resumes it with full context. *Stop* while idle is a no-op
    (`interrupted: false`). The strip under the composer mirrors the DSH
   web GUI: access mode (`Full access` — the Augmentor runtime mounts no
   fs-sandbox/approval gates, so that is the honest label), model, and the
   stats line (`N turns · N steps | LLM … · Tool call … | TTFT avg … · …
   tok/s | Cache hit …% | Input … tok · Output … tok`).
   Replies are written **live** as they are generated, not delivered in
   blocks: the service worker pushes every wire event to the panel the
   moment it arrives, and the renderer coalesces text deltas per animation
   frame (rAF, with a 250 ms fallback for throttled tabs) behind a blinking
   caret on the streaming tail — the same publication model as the DSH web
   GUI. Each user prompt and each finalized assistant answer carries a
   **Copy** action (GUI `MessageIconActions` style: 16 px icon row under the
   bubble / under the answer). One click copies the raw text — the prompt
   as typed, or the assistant message's joined text blocks (markdown
   source, not the rendered HTML) — and on an accepted write the icon swaps
   to a check for 1 s before reverting; re-clicks during the feedback
   window are no-ops and a refused clipboard write claims no success.
   Streaming answers show no copy button until their final message lands.
4. **Inspect**: `trace/bridge-*.jsonl` (every wire frame, both directions),
   `sessions/*.jsonl` (durable session log).

### Test tasks (collect data for each)

1. `Open https://example.com and tell me the exact page title.`
   → minimal happy path: navigate + snapshot + answer.
2. `What tabs do I have open? Then open https://www.wikipedia.org in the active tab and tell me what the search box's placeholder is.`
   → tabs_list + navigate + DOM read.
3. `Go to https://example.com and click the "More information..." link, then snapshot the new page.`
   → multi-step with click; check model's selector handling.
4. `Try to navigate to file:///etc/passwd and then to https://example.com. What happened with the first one?`
   → permission/UX edge (non-http refusal surfaces to the model).
5. Ask two things in one prompt requiring ~4+ browser calls → watch session length,
   token usage, and whether context compaction triggers.
6. Leave it idle 2+ minutes with the popup closed, then reopen → check SW
   resurrection and port state (data point on MV3 lifecycle).

### Data checklist (fill from traces)

| Question | Where to look |
|---|---|
| Native host spawn time (Chrome → bridge → runtime ready) | `bridge-*.jsonl`: `spawn-runtime` t vs popup `handshake` t |
| initialize round trip ms | bridge trace |
| prompt → first assistant chunk ms | bridge trace delta |
| per browser action latency (model→bash→HTTP→port→extension→reply) | bridge trace: `runtime->extension` vs `extension->runtime` |
| model's tool-call style (does it follow persona, one action per bash call?) | `sessions/*.jsonl` `tool/call` events |
| token usage per turn (27B local, no cache) | `assistant/message` usage in session log |
| total wall time per task | trace t deltas |
| failures/misbehaviors (bad selectors, timeouts, SW restarts) | trace + popup |

### Protocol observations so far (early runs)

- `initialize` → `{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}}`;
  round trip ~225 ms over the bridge (includes runtime boot of the whole
  plugin tree).
- Prompt queuing first emits `agent/inbox/spliced` (the user message is a log
  event in its own right — model-visible ⟺ logged) before `turn/start`.
- **Session ids are persistent**: reusing an id whose on-disk log does not
  match the live session fails the turn with `id collision`. The extension
  therefore mints a fresh id per SW instance.
- Provider/config failures surface as `turn/end` with
  `reason:{kind:'error',error:{message,code}}` + `session.status idle` —
  no separate error notification.
- pi-ai requires a non-empty API key even for unauthenticated local routes
  (`No API key for provider: …` / `PI_AI_ERROR`).
- **The bash tool's env is scrubbed, not inherited.** `dsh-subprocess`'s
  `scrubbedParentEnv()` strips every `DSH_*` name plus credential-shaped
  names (`KEY|PASSWORD|SECRET|TOKEN`) before spawning the model's shell; only
  the per-call managed `DSH_*` snapshot (from the `shell-env` registry) plus
  `PATH`/`HOME`/locale survive. Implications for the real design:
  - Augmentor carries bridge coordinates in `augmentor/.browser-endpoint` (a file
    the shim resolves relative to itself) instead of env vars;
  - a production bridge-env would be a `shell-env` registry contributor
    (`ctx.shellEnv.register({variables:{'DSH_BROWSER_BRIDGE':…}})`), which is
    the first-class extension point — or the coordinates ride the new
    `browser_*` tool registration itself (no env at all).
- Model behavior data: on the first run the model hit the missing-env failure
  and self-recovered by reading `/proc/<pid>/environ` — then completed the
  task. Persona robustness is decent; still, the first-call cost was one
  wasted LLM round trip (~2-4s, 30-100 tokens).

### Model picker (the DSH app's model set, selectable)

The composer strip's model chip is a picker — the DSH web GUI's model seat
mirrored in plain HTML/JS: a grouped menu (one section per provider route), a
check on the running model, a loading/error + retry strip, and a locked
state while a turn runs (a switch would restart the runtime under the live
turn, so switches land only when idle).

- **Catalog source**: the bridge answers `augmentor/models` by reading
  `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`) — the SAME
  document the DSH app loads — grouping its `llm-pi-ai:` provider routes as
  configured (display names, model names, order), then appending the built-in
  `deepseek-official` route (deepseek-v4-flash / deepseek-v4-pro /
  deepseek-v4-flash-vision-exp, the plugin's default catalog unless a
  `llm-deepseek.models` settings section overrides it). The file is re-read
  per request, so an edit to the DSH app's settings lands in the picker
  without a reload. The runtime side is the product's canonical wiring
  (`dsh-settings-file` + `dsh-credentials-local` + dormant `dsh-llm-pi-ai` +
  `dsh-llm-deepseek`): which routes exist is the user's settings document,
  never the sidecar composition.
- **Keys**: each route's `apiKeyEnv` reference resolves per request through
  the DSH credentials seam (process env > `~/.dsh/.credentials.yaml` >
  `augmentor/.env`) — the same store the DSH app's Models page writes. The
  local llama.cpp route ships a placeholder key in `augmentor/.env` (the
  server ignores auth); the gx10 gateway route needs the real key exported in
  the launching shell; DeepSeek needs nothing (its key is in the store).
- **Default**: the first model of the first route in the settings document
  (local first — no network needed), i.e. the DSH app's first-configured
  model. The last pick persists in `chrome.storage.local` and wins on
  reconnect while it is still in the catalog.
- **Switch semantics**: picking a row sends it to the bridge
  (`augmentor/switchModel`), which validates it against the catalog and
  restarts the runtime process (SIGTERM, SIGKILL after 5 s — the Chrome port
  and the browser relay stay up). The extension re-`initialize`s the fresh
  process with the new selection; the session id is unchanged, so the runtime
  **resumes the conversation from its persisted log** (`sessions/*.jsonl`) on
  the new model — context preserved, next reply from the new model. The
  bridge answers `switchModel` once the new process is spawned (the
  re-initialize frame is pipe-buffered until the runtime boots, ~200 ms). A
  failed switch rolls the selection back and surfaces the error; if the
  runtime is left unusable the panel drops to the error state and *Connect*
  reboots the pair.
- **Wire**: `augmentor/models` and `augmentor/switchModel` are bridge-local —
  answered by the bridge itself, never forwarded to the runtime (whose method
  map is the fixed SDK set: `initialize` / `session/prompt` /
  `session/interrupt` / `shutdown`).

## 2. Real-browser results (headless Chromium lab + local 27B)

All numbers below are from real Chromium runs (headless `--load-extension`,
CDP-driven), not synthetic in-memory tests. LLM: local
llama.cpp `Qwen3.8-27B-UD-Q6_K_XL`.

| Metric | Value |
|---|---|
| bridge spawn → `initialize` reply (runtime boot included) | **215 ms** |
| task: "open example.com, snapshot, tell me the exact title" — prompt → idle | **3.42 s** |
| — per session (2 runs) | 3.42 s / 3.75 s |
| — steps per task | 3 (navigate + snapshot + answer) |
| browser-action round trip (model → bash → HTTP → port → SW → back) | **navigate 183–205 ms, snapshot 3 ms** |
| per-task LLM wall time | 3.1–3.4 s |
| decode speed / TTFT avg | 86–91 tok/s / 0.2–0.3 s |
| prompt-cache hit (system+tools stable prefix) | **98 %** |
| tokens per task | ~7.2 K input · ~230 output |
| reply streaming (panel, visible tab) | **17 incremental renders, max gap 50 ms**, caret on live tail (see below) |

- **New chat verified end-to-end**: the header button mints a fresh
  `sessionId` (two distinct ids in one bridge trace: 199 + 210 events),
  resets the panel (0 blocks, stats cleared, title back to default) and the
  next prompt starts the stats line from zero — no bridge restart, no SW
  restart, same native port.
- Real-site runs from earlier lab sessions: `manoloremiddi.com` opened in
  788 ms and the agent correctly diagnosed the owner's down site as a
  "Database Error" page; `amazon.com` returned the exact title
  "Amazon.com. Spend less. Smile more."
- Side panel is at DSH-web-GUI parity: Think blocks (collapsible), compact
  tool rows (`[Bash] description`, click for args/output, red `Failed`
  badge), the GUI-exact stats line, and the composer strip
  (`Full access` · model · stats).
- **Live streaming verified (in-page MutationObserver, visible panel tab):**
  the final answer of the example.com task rendered **17 times while it was
  generated** (11 → 171 chars), with renders **≤ 50 ms apart** (≈2 frames at
  60 fps), a blinking caret on the live tail throughout, and the caret gone
  at settle. Text stream spanned 565 ms; Think blocks and stats line as
  usual. Mechanism, mirroring the DSH web GUI: the SW broadcasts each
  `session.event` *with its log entry* (previously it only logged, and the
  panel saw updates via its 2 s poll — the cause of blocky replies); the
  panel renders the pushed entry directly instead of re-fetching the log;
  the renderer coalesces deltas on `requestAnimationFrame` with a
  250 ms `setTimeout` race (a throttled/hidden tab never fires rAF — in the
  headless lab the panel tab is `hidden` unless kept the active tab, so the
  lab measurement keeps a work tab open ahead of it; in a real browser the
  side panel is always visible and runs at full rAF rate).
- **Copy actions verified (lab, one turn of the example.com task):** exactly
  one copy button per message kind (1 user, 1 assistant — the two tool-only
  steps get none, matching the GUI, which exposes the action on the
  finalized turn tail). User copy payload = the prompt string byte-for-byte;
  assistant copy payload = the final `assistant/message` text blocks
  byte-for-byte (checked against the SW session log), i.e. raw markdown
  (`**Example Domain**`), not rendered HTML. Click → icon/tooltip flips to
  "Copied" at +250 ms, a re-click inside that window is ignored (no second
  clipboard write), and at +1.25 s the control reverts to "Copy".
  Buttons render 28×28, fully round, `--text3` on transparent — the GUI's
  action metrics.
- **Light/dark theme verified (lab):** header toggle (sun/moon, left of
  *＋ New chat*) rebinds every token and flips `color-scheme`, so the native
  scrollbar follows the palette — the bug was the UA scrollbar, which ignores
  page CSS; the GUI's fix (its `scrollbar.css`) is mirrored here: 8 px
  track-less thumb, token-driven per mode (dark `rgb(60,60,61)` /
  `rgb(84,85,87)`, light `rgb(229,229,229)` / `rgb(212,212,212)`, the GUI's
  `scrollbar-{bg,hover}-l1` values). Light palette = the GUI's light theme
  (white bg, `neutral-bluish-1000/700/600` text, brand `rgb(65,118,230)`).
  Verified: dark default, toggle both ways (body bg, scrollbar thumb,
  icon, tooltip), preference persisted in localStorage and restored
  pre-paint on a fresh load (no flash). The restore must live in
  `theme-boot.js`: MV3's default extension-page CSP (`script-src 'self'`)
  silently refuses inline `<script>` in extension pages.
 - **Color customization verified (lab):** a hue icon (rainbow conic disc)
   in the header opens a color popover — a Light/Dark **theme switch**
   (segmented control, at the top, so the theme can be toggled while the
   colors are open) above four color controls — over the otherwise-gray
   surfaces, all persisted to localStorage (pre-paint restore) and mirrored
   to `chrome.storage.local` for the SW:
   - *Neutral hue* (0–360): tints `--bg`/`--layer1..3`/scrollbar thumbs;
     per-level saturation keeps a chosen hue readable in both themes while
     the default 222 reproduces the shipped near-neutral grays.
   - *Brightness* (−15..+15 lightness points, one control for BOTH themes):
     headroom-scaled — the raw offset is scaled down before application so
     the extremes can't push levels into the 2..100 clamp and collapse the
     layer spacing (the unscaled light +15 turned every surface white;
     unscaled dark −15 pinned the bottom levels). After scaling, every
     offset ±15 in both themes keeps all levels in range with the exact
     designed lightness deltas. Consequence: in light mode the top level is
     already at 100, so the + side gracefully no-ops (white cannot be
     brighter) while −15..0 works fully; dark gets the full ±15.
   - *Accent hue* (0–360, default 222 = DeepSeek blue, swatch preview):
     drives `--brand` in the panel — per-theme `[hueOffset, sat, light]`
     triples keep the shipped brand **exact** in both themes at the default
     (dark `rgb(86,134,254)`, light `rgb(65,118,230)`) — and the
     browser-control overlay: the veil's whole 16-color palette is derived
     from the accent (each role = accent + fixed offset/sat/light, so the
     original green's internal spread is preserved for any hue; at 142 the
     derived dot/done/label/pill colors match the shipped green with Δ0),
     and the click/type pulse + ripple use the same accent dot color.
   - *Accent brightness* (−15..+15, default 0): shifts the accent's
     lightness in both themes, for `--brand` **and** the overlay. The +
     side is additive (the brand is one mid-range color, so a plain clamp
     suffices: red hue 0 at +15 → `rgb(255,164,162)`); the veil's + side is
     headroom-scaled like the neutral brightness — its roles span
     lightness 3.1..93.9, so unscaled +15 would white-out the extremes;
     after scaling (×6.1/15) every role keeps its designed delta and +15
     lands the brightest role at exactly 100. The − side fades
     **multiplicatively to full black** (`accentLight`): at the slider
     minimum (−15) the accent — brand and all 16 veil roles — reaches
     lightness 0 (`rgb(0,0,0)`) in both themes, intermediate steps dim the
     whole palette uniformly (spacing preserved proportionally), and the
     curve is continuous at 0 (e.g. dark blue brand: −7 → `rgb(1,52,181)`,
     −15 → `rgb(0,0,0)`).
   Verified end-to-end (real Chromium, `--headless=new` + CDP): popover
   open/close (click, outside mousedown, Esc), the Light/Dark theme switch
   at the top (both directions, active-segment state, localStorage
   round-trip), all four sliders live (surface tint, brand + swatch, mini
   veil-pill preview, both brightness readouts) — accent brightness fading
   to pure black at −15 in both themes (brand, mini pill, and the injected
   overlay's dot/label/pill all `rgb(0,0,0)`) — reset, and the
   previously-broken light +15 whiteout.
   Persistence round-trips to both localStorage (pre-paint restore) and
   `chrome.storage.local`; the SW boots the accent hue + brightness from
   `chrome.storage.local` and follows
   `storage.onChanged` (area-filtered to `local`; invalid/out-of-range
   values ignored) — click-pulse and the injected
   `show(text, done, hue, bright)` args track the user's accent live. The
   veil re-tints live on `show()` — pill, label, fog divs, and the GL
   uniforms; the uniform upload re-binds each program first (a `uniform3f`
   for a non-bound program is a silent no-op, and `frame()` leaves the
   snow program bound — the first bug the hue check caught: the sheet
   stayed green while the pill turned blue).
   `root.dataset.veil` gains additive `a` (active hue) and `b` (active
   brightness) fields; the two palette implementations (theme-tokens.js
   and the compact copy in veil.js) were cross-checked sample-for-sample —
   714 identical role colors across 42 hue×brightness combos.
   `lab-overlay-verify.py` is accent-aware (expected dot/pulse colors
   computed in Python with the same HSL→RGB, hue-agnostic saturation pixel
   tests), and `lab/veil-preview.html` takes `?accent=<hue>` /
   `?accbright=<-15..15>` plus live sliders.
  - **Connect regression found & fixed (real Chromium):** adding the accent
    sync made the SW read `chrome.storage.local` at boot — but the manifest
    had no `"storage"` permission, where `chrome.storage` is *undefined*
    (not merely restricted) and the property read throws synchronously.
    Unguarded, that throw killed the SW before it registered
    `chrome.runtime.onMessage`, so the panel's `connect` message had no
    receiving end and the agent could never connect. Node stub tests can't
    catch this (they stub `chrome` wholesale) — reproduced and verified in
    real `chromium --headless=new` via CDP: pre-fix, `Uncaught TypeError:
    Cannot read properties of undefined (reading 'local')` in sw.js and no
    SW target; post-fix (`"storage"` added to manifest permissions + the
    `syncAccent()`/`onChanged` block wrapped in try/catch so the accent can
    never take the agent down), the SW boots clean, the full round-trip
    works (panel → SW → `connectNative` → bridge → daemon → status
    "connected"), and the accent persists to
    `chrome.storage.local` in the real SW context.
  - Fresh-profile bugs found while verifying: `Number(null) === 0` made
    *absent* settings mean "hue 0" (everything red on first launch) —
    fixed by guarding the raw string in theme-boot.js/sidepanel.js/the
    preview; and the light +15 whiteout above.
- **Stick-to-bottom scrolling verified (lab):** the old code force-scrolled on
  *every* log apply — including the 2 s poll — which yanked the reader back to
  the bottom mid-read. Now the log follows the live tail only while the user
  is within 80 px of the bottom: scrolled to the top, position held through
  full poll cycles (scrollTop unchanged after 3 s); scrolling back to the
  bottom re-pins; a long streamed reply (20-item list) held distance-to-bottom
  at 0 across the whole stream; sending a prompt always lands at the tail. A
  round *↑* jump-to-top button floats in while the reader is away from the
  bottom and hides again at the tail.
- **Full-chat history verified (lab, v0.1.1):** the old SW log was capped at
  800 entries *and* the panel sync returned only the last 300 — so a fresh
  panel load of a long session replayed just the tail (the reader could never
  scroll back to the first prompt). Now the SW keeps the full session log
  (20k entries; wire frames moved to a separate 500-entry debug tail, the
  bridge still traces the complete wire to `trace/`), and the panel's 2 s
  poll sends `sinceSeq` so the reply carries only genuinely new events — a
  fresh load replays everything, the steady poll stays tiny. Verified with a
  4-turn / 9 645-entry session: closing and reopening the panel replayed all
  prompts, the first DOM node was the first prompt, scrollTop=0 shows it;
  a `sinceSeq` at or above the last seq returned 0 entries.
- **Active-tab targeting verified (lab, v0.1.2):** the old `workTab()`
   cached the first tab it ever picked for the whole service-worker life —
   and when the active tab wasn't scriptable (new tab page, `chrome://`),
   it silently fell back to the *first usable tab* — so the agent kept
   working in the browser's first tab no matter which tab the user was
   looking at. Now the target is re-resolved at the start of every user
   turn to the active tab of the last-focused window (matched by
   `windowId` — some Chromium builds omit the tab's `lastFocusedWindow`
   flag, as the headless lab does); within a turn the tab stays sticky, so
   a navigate → snapshot → click sequence never hops tabs mid-task. If the
   active tab is not scriptable, the most recently visited usable tab
   (`lastAccessed`) wins instead of the first tab. `tabs_list` also reports
   `focusedWindow` per tab so the model can tell which tab the user is on.
   Verified with three content tabs (example.com, Wikipedia, iana.org):
   with Wikipedia active (the *second* tab) the agent's snapshot returned
   Wikipedia, not the first tab; switching the active tab to iana.org
   between messages, the next prompt's snapshot hit iana.org (the old code
   stayed stuck on the previous turn's tab); with the active tab on
   `about:blank` (unscriptable), the snapshot hit iana.org — the most
   recently visited usable tab, not the first.

 - **New-tab-page targeting verified (lab, v0.1.3):** v0.1.2's recency
   fallback had a hole: a *newly opened* tab is a new tab page
   (`chrome://newtab/`, `about:blank`) — not scriptable — so "the tab I just
   opened" was skipped and the most recently visited *usable* tab (often the
   previous tab, e.g. the third one) got acted on. Now a new tab page /
   blank tab counts as the user's tab: `navigate` opens the URL in exactly
   that tab (and it becomes the sticky work tab once loaded), while
   `snapshot`/`click`/`type`/`html` on a still-empty tab return an
   actionable error ("…new tab page — nothing to read there yet; use
   navigate first") that the persona turns into a navigate-first. Other
   non-workable active tabs (extension pages, `chrome://` internals) keep
   the most-recent-usable fallback. Verified: with three content tabs
   (example.com, Wikipedia, iana.org) plus a fourth — a fresh empty tab —
   active, the prompt "Go to https://example.net and tell me the page
   title" navigated the *empty* tab (it ended at example.net; all three
   content tabs untouched) and answered "Example Domain"; direct relay
   calls confirmed snapshot/click on the active empty tab return the
   actionable error, `navigate` on it succeeds and the same tab then
   snapshots the new page; with `chrome://history` active the fallback
   still picks the most recently visited usable tab (iana.org).

  - **AI-control overlay verified (lab, v0.1.6):** every tab the agent works
    in wears a visible "under AI control" indicator, in the spirit of
    Comet's Perplexity Assistant. Two layers, injected from the SW's isolated
    world into `document.body` (a fresh `<style>` + one fixed root node;
    `pointer-events:none`, `z-index:2147483647` — never blocks or shifts page
    content): (1) a **green fog** — a wrap of three full-viewport layers: a
    static vignette (clear middle, dense green `#22c55e` borders) plus two
    oversized layers of soft green blobs that wander on 24 s / 33 s
    `translate`/`rotate`/`scale` keyframes in opposite directions; the
    interference of the two drifting layers reads as smoke/fluid rather than
    a static gradient, and the wrap "breathes" via a 4 s `filter: brightness`
    keyframe; (2) a **status pill** centered at the **bottom** of the viewport
    (20 px up) — dark rounded badge with a pulsing green dot and a short
    *plain-language* label, no selectors in sight: `Thinking…` (turn start),
    `Checking open tabs…`, `Opening <host>…` / `Opened <host>`,
    `Analysing the page…`, `Clicking…` → `Clicked on <element text>`,
    `Typing…` → `Typed into <element text>`, `Inspecting…` → `Checked <element
    text>` (element text/aria-label/placeholder, fallback "the input box",
    "a link", …). On `turn/end`: `Augmentor — done ✓` (light-green dot, fog
    hidden), then the whole overlay fades after 2.5 s. **Lifetime = the whole
    turn**: the indicator appears the moment the agent takes control (the
    prompt) and is only removed right before the answer — mid-turn actions do
    not arm any idle fade (a `turnActive` flag suppresses the 4 s timer, which
    now only applies to standalone relay calls outside a turn). Click and type
    also flash *where they land*: the target scrolls into view, gets a 2×
    green box-shadow pulse (WAAPI, ~1.8 s) and a 14 px green ripple ring —
    visual-only, in try/catch, so a failed effect can never fail the action.
    Action errors show a `⚠ <plain words>` label (two common machine errors
    translated; the model still gets the full error). Verified (headless lab,
    DOM + pixel assertions, fresh profile per build, green signature =
    `g−r`/`g−b` relative difference — works over light and dark pages):
    fog = exactly 3 layers with `__dshAugFogA`/`__dshAugFogB` keyframes and a
    running `__dshAugFog` breathing; layer A's computed `transform` sampled
    1.5 s apart was different (the smoke actually moves); pill bottom-center
    within 12 px of (50 %, height−20 px) with 1 119 dark pixels; borders dense
    vs center see-through (716 green edge px vs 0 center px on example.com,
    716 on Wikipedia); `elementFromPoint` at the (bottom-center) pill returns
    page content (clicks pass through); the model-visible snapshot stays clean
    (overlay hidden for the innerText read — model-visible ⟺ logged); the
    overlay re-injects after navigation; the 4 s idle fade still removes a
    standalone relay indicator; and a full model turn (Wikipedia search)
    showed 8 clean transitions — `Thinking… → Checking open tabs… → Analysing
    the page… → Clicked on the input box → Typed into the input box → Checked
    the input box → Analysing the page… → done ✓` — with **zero mid-turn
    absences** (the indicator never faded between steps), fog opacity held at
    1 for every active phase, then fade-after-done and the correct answer.
    Design iterations in this span: v0.1.4 violet border+shadow glow →
    v0.1.5 static radial fog (centered pill, human labels; first pass used a
    `115%` gradient size that pushed the dense stops off-canvas — 0 tinted
    edge pixels — fixed with the `50% 50%` ellipse) → v0.1.6 layered drifting
    smoke + bottom-center pill + turn-scoped lifetime (user feedback: the
    single-gradient fog looked too basic, the effect flickered between action
    phases, and the pill belonged at the bottom).
   - **Frost veil replaces the green fog (v0.1.7):** user feedback after
     v0.1.6: the fog is "ugly / generic, it looks like an AI did it" — wants
     a *material* you can see through, with real 3D depth. The visual layer
     is now a **WebGL frost sheet** (`veil.js`): a slowly flowing,
     domain-warped heightfield (two-level iq-style warp over 4-octave Ashima
     `snoise` fbm) drawn on a reduced-resolution canvas (55 % of the viewport
     at the high tier, 38 % at the low tier; after ~3 consecutive slow
     seconds the tier drops and the directional self-shadow turns off) and
     lit like a thin sheet of ice seen slightly from above — central-
     difference normals with crystal micro-facet jitter, Lambert diffuse, a
     tight moving specular (the "glint"), a broader sheen, a fresnel rim,
     cavity darkening from the height, and a directional self-shadow. A
     parallax **snowfall** of 200 depth-banded point sprites (all motion is
     time-based inside the vertex shader — no CPU particle state) drifts in
     front. Pointer movement tilts both the view and the light source, so
     the surface reads as a 3D material: the page behind stays fully sharp
     and readable (deliberately **no** `backdrop-filter` — the see-through
     quality is low center alpha only) while an even band around the
     borders condenses denser and greener. Lifecycle: the frost **condenses** in over
     ~1.5 s (edges first, center last — a condensation-reveal mask),
     breathes for the whole turn (slow aurora sweep + field drift), and
     **melts** when the turn is done (alpha ×(1−melt²), field drift
     downward, darkening). The status pill is unchanged. Without WebGL,
     under `prefers-reduced-motion`, or with `window.__dshAugForceFog` set
     before load (test hook), it falls back to the v0.1.6 CSS fog verbatim
     (same keyframes, same gradients), so the old pixel signatures still
     hold. The lab was rewritten mode-branching: the webgl path asserts the
     canvas + a live frame counter (content-script→main-world bridge via
     `root.dataset.veil`, since CDP `eval` runs in the page's main world and
     cannot see the isolated-world API), the fallback path keeps the
     3-layers / animation-name / transform-drift assertions. Verified
     (headless, quantitative screenshot metrics via `lab/veil-metrics.py` —
     this session's model has no image input, so numbers stand in for
     eyeballs, against a bare-page capture of the same view): vs the v0.1.6
     fog the veil adds 8.5× luminance-modulation depth in the center
     (17.7 vs 2.1), 226× high-frequency texture (1764 vs 8), and 195 new
     bright glint/snow pixels (vs 0), while the center still tracks the bare
     page at 0.93 luminance correlation (see-through); a pointer swing moves
     the glint centroid ~17 px (parallax) and a 2.5 s frame pair shows a
     low-frequency-dominated diff (fluid, not flickering); the lab's own
     green-hit functions pass on the veil (154 left-edge green px > 20;
     center-green 33 < the 51 threshold) as does the pill dark-pixel check.
     Iterations: the first pass failed the green signature two ways —
     ice-blue speculars dragged `g−b` under 30 at the borders, and the
     center still read as green fog (center-green 67 > 58) → palette nudged
     greener (ice blue 0.94→0.90, mid/tint greens raised) and the center
     alpha cut (base 0.14→0.055, edge smoothstep 0.22/0.55→0.30/0.62) so the
     middle is genuinely see-through (center-green 33, edge hits 154).
    - **Four polish tweaks after the user approved the frost (v0.1.7, tuning
      only, no contract change):** user feedback was (1) "the website in the
      background is kind of blurry — the effect shouldn't add any blur",
      (2) "a little bit too pixelated, should look smoother", (3) "the center
      should have less effect while the border should have more — even more
      green", (4) "maybe too many highlights — more medium side color".
      Fixes: **`backdrop-filter: blur(2px)` removed entirely** (see-through
      now comes purely from the low center alpha; center luminance
      correlation with the bare page rose 0.93 → 0.993); canvas scale raised
      to 0.55/0.80, micro-facets softened (freq 15→11), and the tight 1–2 px
      `pow(110)` glint replaced by a **broad `pow(80)` sheen** (the blocky
      sparkle was that tight glint upscaling from the small canvas); the
      border re-derived as a **box-distance band** (`dBox = max(|uv−0.5|)·2`,
      smoothstep 0.70/0.97 — edge midpoints and corners alike) mixed 60 %
      toward a saturated green, with the center left a thin film (base alpha
      0.07); highlight intensities cut (spec ×0.55, sheen ×0.12, veins
      ×0.30, sweep ×0.35) over a mid-green base added under the lighting.
      New numbers (light page): left-edge green pixels 154 → 720, border
      ΔRGB (−101, −21, −71) — deep green; center ΔRGB (−0.5, +11, +4) — a
      faint frost tint; new bright center pixels 195 → 42 (0 on dark
      pages); see-through 0.993 light / 0.948 dark. All lab gates still
      pass on both themes (light 720/61 vs the 240 threshold; dark 720/9).
    - **Glyph variation — the waves made of numbers and symbols (opt-in,
      same version):** the user approved the frost and asked what the waves
      would look like "made by numbers and symbols" instead of pixels. A
      second look reuses the entire pipeline (DOM contract, condense/melt,
      pointer parallax, adaptive quality, snowfall, fog fallback) and
      replaces the surface's character: a **field of falling glyphs** — a
      32-character ASCII atlas (digits, hex letters, operators; ASCII-only
      so no missing-glyph boxes on any platform) baked to a texture at init
      and sampled per 20 px screen cell in the fragment shader. Each cell
      re-scrambles to a new glyph ~every 0.6 s, out of phase with its
      neighbours; brightness is modulated by the **same** ice heightfield
      (the surface's motion ripples through the digits) plus a per-column
      falling pulse (bright head, decaying tail, random speed) for the rain
      read. The center is a sparse, dim scatter (~45 % of cells lit); the
      border a dense wall of characters; the frost base recedes behind it
      (alpha ×0.45) so the material still reads. Off by default — the
      extension ships the approved frost; enable with
      `window.__dshAugVariation = 'glyphs'` set before load (lab preview:
      `?mode=glyphs`). Verified headless: clean shader compile, 60 fps, lab
      green gates pass light (720/8) and dark (720/19), see-through 0.994 /
      0.938, and ~24 % of pixels differ from the frost render (the glyph
      field's footprint, heaviest at the borders).

## 3. Teardown

```sh
# remove the native host manifest
rm ~/.config/chromium/NativeMessagingHosts/com.deepseek.dsh.augmentor.json
# remove repo-side Augmentor files
git -C ../deepseek-harness status --porcelain  # augmentor.cordis.yml is untracked; delete it
```
