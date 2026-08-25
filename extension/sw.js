/**
 * Augmentor (powered by DSH) — MV3 service worker.
 *
 * Owns the native messaging port to the Augmentor bridge (an open port keeps this
 * SW alive, so the popup may close while the agent works). Relays prompts and
 * session events between the popup and the runtime, and executes browser
 * actions the runtime requests via the bridge.
 */

// Shared color math (theme-tokens.js): the veil's accent palette and the
// click-pulse colors derive from the user's accent hue.
importScripts('theme-tokens.js')

const HOST = 'com.deepseek.dsh.augmentor'
// The model the sidecar runs on: a {provider, model} pair from the DSH app's
// catalog (the bridge serves it from $DSH_HOME/settings.yaml, so the picker
// offers exactly what the DSH app offers). The choice is remembered in
// chrome.storage.local so an SW restart (idle expiry, browser restart)
// resumes the last selection.
const MODEL_STORAGE_KEY = 'augmentor-model-selection'

// ResonantOS-style behavior: clicking the toolbar icon opens the side panel
// (the manifest no longer declares a default_popup, which would take
// precedence over the panel).
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  chrome.sidePanel.setOptions({ path: 'sidepanel.html' })
} catch (e) {
  console.warn('sidePanel setup failed', e)
}
// The SW's chat identity doubles as the DSH session id (M2): session.create
// accepts any non-empty id, so live downlink events (which carry the DSH
// session id) route straight into this chat's filter. The id is remembered in
// chrome.storage so an SW restart (idle expiry, browser restart) resumes the
// same conversation; "new chat" mints a fresh one.
const SESSION_STORAGE_KEY = 'augmentor-session-id'
let SESSION_ID = `augmentor-${crypto.randomUUID().slice(0, 8)}`
// Our DSH session exists on the server (verified on reconnect; set after
// session.create).
let sessionReady = false

const state = {
  phase: 'disconnected', // disconnected | connecting | ready | error
  error: null,
  running: false,
  port: null,
  reqSeq: 0,
  pending: new Map(), // id -> {method, resolve}
  // The DSH app's model catalog (the bridge's `augmentor/models` result) and
  // the selected {provider, model} the runtime runs on (null until the first
  // handshake). The panel's picker renders from both.
  catalog: null,
  selection: null,
  // The DSH app's home directory (host.describe) — the working directory for
  // the session we create on first prompt.
  homeDir: null,
  // M3 chat lifecycle (from the plugin's handshake, folded into initialize):
  // the dedicated chat directory every new session is created in (Save can
  // attach such a session to its workspace), the running DSH app's base URL
  // (Open-in-DSH button), and the sessions already saved there (badge).
  chatCwd: null,
  endpoint: null,
  saved: new Set(),
  // Session entries the panel renders (events + port/prompt/handshake/status).
  // Big on purpose: a fresh panel load replays this as the whole chat, so it
  // must hold a full working session (~2 entries per streamed chunk).
  log: [],
  // Wire frames are diagnostics only (the bridge traces the full wire to
  // trace/); keep a small tail for SW-side debugging.
  wirelog: [],
  lastResponseAt: null,
}

function log(kind, data) {
  const entry = { t: Date.now(), kind, ...data }
  if (kind === 'wire') {
    state.wirelog.push(entry)
    if (state.wirelog.length > 500) state.wirelog.splice(0, state.wirelog.length - 500)
  } else {
    state.log.push(entry)
    if (state.log.length > 20000) state.log.splice(0, state.log.length - 20000)
  }
  return entry
}

// Push the newest log entry with the state: the panel renders it directly
// instead of a full 'log' round-trip per event (the GUI's per-chunk
// publish path). Entry-less broadcasts ask the panel for a full resync.
function broadcast(entry = null) {
  chrome.runtime
    .sendMessage({ type: 'evt', running: state.running, phase: state.phase, error: state.error, entry })
    .catch(() => {})
}

// Remembered model selection: the SW restarts constantly (idle expiry,
// browser restart), and the last pick must survive them.
function loadStoredSelection() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(MODEL_STORAGE_KEY, (items) => {
        const sel = items?.[MODEL_STORAGE_KEY]
        resolve(sel && typeof sel.provider === 'string' && typeof sel.model === 'string' ? sel : null)
      })
    } catch {
      resolve(null)
    }
  })
}
function saveSelection(sel) {
  if (sel === null) return
  try {
    chrome.storage.local.set({ [MODEL_STORAGE_KEY]: sel }, () => void chrome.runtime.lastError)
  } catch {
    /* storage unavailable: the selection lives in this SW instance only */
  }
}
function loadStoredSessionId() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(SESSION_STORAGE_KEY, (items) => {
        const id = items?.[SESSION_STORAGE_KEY]
        resolve(typeof id === 'string' && id ? id : null)
      })
    } catch {
      resolve(null)
    }
  })
}
function saveSessionId(id) {
  try {
    chrome.storage.local.set({ [SESSION_STORAGE_KEY]: id }, () => void chrome.runtime.lastError)
  } catch {
    /* storage unavailable: the session id lives in this SW instance only */
  }
}
function clearStoredSessionId() {
  try {
    chrome.storage.local.remove(SESSION_STORAGE_KEY, () => void chrome.runtime.lastError)
  } catch {
    /* storage unavailable */
  }
}
// Does the DSH session exist on the server? session.history is the cheapest
// probe: an unknown session answers `session "<id>" not found`, a network
// failure rejects before any answer. true = exists, false = gone, null =
// could not tell (proceed and let the next call surface it).
async function sessionHistoryOk(sessionId) {
  try {
    const res = await request('session.history', { sessionId, maxMessages: 1 })
    return res !== undefined && Array.isArray(res.events)
  } catch (e) {
    return /not found/i.test(String(e?.message ?? e)) ? false : null
  }
}

function ensurePort() {
  if (state.port || state.phase === 'connecting') return
  state.phase = 'connecting'
  state.error = null
  broadcast(log('port', { event: 'connect', host: HOST }))
  let port
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch (e) {
    fail(String(e))
    return
  }
  state.port = port

  port.onMessage.addListener((msg) => {
    // Request/response for the client requests we sent (initialize, prompt).
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = state.pending.get(msg.id)
      state.pending.delete(msg.id)
      log('wire', { dir: 'ext<-bridge', msg: summarize(msg) })
      if (waiter) {
        if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
        else waiter.resolve(msg.result)
      }
      return
    }
    // Server->client request: a browser action from the runtime.
    if (msg.id !== undefined && msg.method === 'browser/execute') {
      log('wire', { dir: 'bridge->ext', msg: { id: msg.id, method: msg.method, params: msg.params } })
      handleBrowserAction(msg.id, msg.params).then(
        (result) => {
          log('wire', { dir: 'ext->bridge', msg: { id: msg.id, result } })
          post({ id: msg.id, result })
        },
        (e) => {
          log('wire', { dir: 'ext->bridge', msg: { id: msg.id, error: String(e) } })
          post({ id: msg.id, error: { message: String(e?.message ?? e) } })
        },
      )
      return
    }
    // Notifications: session.event / session.status / subagent.*
    if (msg.method === 'session.event') {
      onSessionEvent(msg.params)
      return
    }
    if (msg.method === 'session.status') {
      if (msg.params?.sessionId !== SESSION_ID) return
      state.running = msg.params?.status === 'running'
      broadcast(log('status', { sessionId: msg.params?.sessionId, status: msg.params?.status }))
      return
    }
    log('wire', { dir: 'ext<-bridge', msg: summarize(msg) })
    log('wire', { dir: 'ext<-bridge', msg: summarize(msg), note: 'unhandled' })
  })

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message
    log('port', { event: 'disconnect', error: err ?? null })
    fail(err ?? 'native host disconnected')
  })

  // Handshake: the bridge serves the model catalog before the runtime is
  // needed, so fetch it first, pick the model (the remembered selection when
  // it is still in the catalog, else the catalog's default — the DSH app's
  // first-configured model), and only then initialize the runtime with it.
  ;(async () => {
    const stored = await loadStoredSelection()
    try {
      const catalog = await request('augmentor/models')
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const inCatalog = (sel) =>
        sel !== null &&
        groups.some((g) => g.provider === sel.provider && g.models.some((m) => m.model === sel.model))
      const sel = inCatalog(stored) ? stored : catalog?.default
      if (!sel || !groups.length) {
        throw new Error(catalog?.error ?? 'no models available (check $DSH_HOME/settings.yaml)')
      }
      state.catalog = groups
      state.selection = sel
      saveSelection(sel)
      const result = await request('initialize', {
        cwd: 'chrome-extension://augmentor',
        provider: sel.provider,
        model: sel.model,
      })
      state.homeDir = result?.serverInfo?.home ?? null
      // M3: the plugin's chat-lifecycle state rides in serverInfo.augmentor;
      // the pipe's endpoint (serverInfo.endpoint) feeds Open-in-DSH.
      state.chatCwd = result?.serverInfo?.augmentor?.chatCwd ?? null
      state.endpoint = result?.serverInfo?.endpoint ?? null
      state.saved = new Set(result?.serverInfo?.augmentor?.saved ?? [])
      // M2: resume the conversation across the SW restart — if the DSH
      // session we stored still exists on the server, replay its events into
      // the log so a fresh panel re-renders the chat on load; if it is gone,
      // forget it (the next prompt creates a new session).
      const remembered = await loadStoredSessionId()
      if (remembered) {
        const exists = await sessionHistoryOk(remembered)
        if (exists === true) {
          SESSION_ID = remembered
          saveSessionId(remembered)
          sessionReady = true
          const full = await request('session.history', { sessionId: remembered, maxMessages: 500 })
          for (const h of full?.events ?? []) log('event', { sessionId: remembered, event: h.event })
          broadcast(log('handshake', { event: 'session-resumed', sessionId: remembered, events: full?.events?.length ?? 0 }))
        } else if (exists === false) {
          clearStoredSessionId()
        } else {
          // Unreachable at boot: keep the remembered id as the candidate —
          // the first prompt re-verifies it before creating anything.
          SESSION_ID = remembered
        }
      }
      state.phase = 'ready'
      broadcast(log('handshake', { serverInfo: result.serverInfo, provider: sel.provider, model: sel.model }))
    } catch (e) {
      fail(`initialize failed: ${e.message}`)
    }
  })()
}

// Drop to the error state: the panel shows the message + a Connect button
// whose press re-runs the whole handshake (fresh port, fresh selection check).
function fail(message) {
  state.phase = 'error'
  state.error = message
  state.port = null
  state.pending.forEach((w) => w.reject(new Error(message)))
  state.pending.clear()
  broadcast()
}

function post(msg) {
  try {
    state.port?.postMessage(msg)
  } catch (e) {
    log('port', { event: 'post-failed', error: String(e) })
  }
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    if (!state.port) return reject(new Error('not connected'))
    const id = `c${++state.reqSeq}`
    state.pending.set(id, { method, resolve, reject })
    log('wire', { dir: 'ext->bridge', msg: { id, method, params: summarizeParams(params) } })
    post({ id, method, params })
    setTimeout(() => {
      if (state.pending.has(id)) {
        state.pending.delete(id)
        reject(new Error(`${method} timed out (60s)`))
      }
    }, 60000)
  })
}

function summarize(obj) {
  try {
    const s = JSON.stringify(obj)
    return s.length > 400 ? s.slice(0, 400) + '…' : obj
  } catch {
    return String(obj)
  }
}
function summarizeParams(p) {
  if (!p) return p
  if (Array.isArray(p)) return `[${p.length} blocks]`
  return p
}

// The DSH session the panel is currently viewing (M1): its events stream to
// the panel as direct pushes and NEVER enter state.log, so the SW keeps its
// own transcript clean and the "new chat" filter stays authoritative.
let panelViewSession = null

// One session.event from the runtime. Only the current session is surfaced:
// after "new chat" the runtime may still stream tail events for the
// previous session.
function onSessionEvent(params) {
  if (panelViewSession && params?.sessionId === panelViewSession && panelViewSession !== SESSION_ID) {
    broadcast({ type: 'evt', entry: { kind: 'event', sessionId: params.sessionId, event: params.event } })
    return
  }
  if (params?.sessionId !== SESSION_ID) return
  const ev = params?.event
  // Turn ended: the agent gives back control — "Done", then fade. But only
  // if the veil is actually up: it follows real browser use, so a text-only
  // turn (no browser action) never showed it and must not get a phantom
  // "Done ✓" on the user's tab.
  if (ev?.type === 'turn/end') {
    turnActive = false
    if (overlayVisible) {
      // A user Stop aborts the turn — label it as such, not "Done".
      const reason = ev?.data?.reason
      const stopped = reason?.kind === 'aborted' && reason?.reason?.kind === 'user'
      overlayShow(overlayTabId, stopped ? 'Stopped' : 'Done ✓', true)
    }
  }
  // Full envelope: the panel renders from it and the seq is its dedupe key.
  broadcast(log('event', { sessionId: params?.sessionId, event: ev }))
}

// ------------------------------------------------------- browser actions
// The tab the agent acts on: re-resolved at the start of every user turn to
// the tab the user is actually looking at (the active tab of the last-focused
// window), then sticky within the turn so a navigate → snapshot → click
// sequence stays on one tab even if the user flips tabs mid-turn. A new tab
// page / blank tab counts as "the user's tab": there is no content to read
// there yet, but navigate can turn it into a real page. Never an extension
// page (the panel's tab, when opened in a window, is active there).
const SELF_ORIGIN = 'chrome-extension://' + chrome.runtime.id + '/'
function isWorkTab(t) {
  const u = t?.url ?? ''
  if (!t?.id || u === '') return false
  if (u.startsWith(SELF_ORIGIN)) return false // the extension's own pages
  return !/^chrome(-search)?:|^about:|^devtools:/i.test(u)
}
// A new tab page or blank tab: where the user just opened a tab. Not
// scriptable yet, but navigable — the work tab until something loads in it.
function isEmptyTab(t) {
  const u = t?.url ?? ''
  return u === 'about:blank' || /^chrome:\/\/newtab/i.test(u) || /^about:newtab/i.test(u)
}
// The window the user is looking at (last focused). From the service
// worker, a `currentWindow: true` tab query already resolves against the
// last-focused window; windows.getLastFocused is the backup (needs the
// "windows" permission). Returns null when neither works.
async function focusedWindowId() {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (t?.windowId != null) return t.windowId
  } catch { /* no active tab in the focused window */ }
  try {
    return (await chrome.windows.getLastFocused()).id
  } catch {
    return null
  }
}
// Real activation recency: chrome.tabs.Tab has no lastAccessed property,
// so the SW tracks tab activations itself. Used only when the active tab
// is not workable — never for the primary "tab the user is looking at"
// resolution.
const recentActive = new Map() // tabId -> Date.now() of last activation
chrome.tabs.onActivated.addListener(({ tabId }) => {
  recentActive.set(tabId, Date.now())
  if (recentActive.size > 100) {
    let oldestId = null
    let oldestT = Infinity
    for (const [id, t] of recentActive) {
      if (t < oldestT) {
        oldestId = id
        oldestT = t
      }
    }
    if (oldestId != null) recentActive.delete(oldestId)
  }
})
chrome.tabs.onRemoved.addListener((tabId) => {
  recentActive.delete(tabId)
})
let workTabId = null
async function workTab() {
  if (workTabId != null) {
    try {
      const t = await chrome.tabs.get(workTabId)
      if (isWorkTab(t) || isEmptyTab(t)) return t
    } catch { /* tab closed */ }
    workTabId = null
  }
  // 1) The tab the user is looking at right now: the active tab of the
  //    last-focused window — including a new tab page (workable via
  //    navigate, no content to read until then). Never rely on
  //    Tab.lastFocusedWindow (absent in some Chromium builds).
  let active = null
  try {
    ;[active] = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch { /* fall through to the window-derived lookup */ }
  if (!active) {
    const wid = await focusedWindowId()
    const tabs = await chrome.tabs.query({})
    active =
      (wid != null ? tabs.find((t) => t.active && t.windowId === wid) : undefined) ??
      tabs.find((t) => t.active) ??
      null
  }
  if (active && (isWorkTab(active) || isEmptyTab(active))) {
    workTabId = active.id
    return active
  }
  // 2) The active tab is a non-workable page (chrome://internal,
  //    extension page, …): fall back to the most recently activated
  //    usable tab (tracked via onActivated) — never the first tab in the
  //    list, which is where the old session-long stickiness landed.
  const tabs = await chrome.tabs.query({})
  const usable = tabs.filter(isWorkTab)
  if (!usable.length) throw new Error('no usable browser tab')
  const byRecency = [...usable].sort((a, b) => (recentActive.get(b.id) ?? 0) - (recentActive.get(a.id) ?? 0))
  const pick = byRecency[0]
  workTabId = pick.id
  return pick
}
// Read/click/type actions need a real page: fail with an actionable error
// when the work tab is still a new tab page / blank tab.
async function readableWorkTab() {
  const tab = await workTab()
  if (!isWorkTab(tab)) {
    throw new Error(
      'the tab you are on is a new tab page — nothing to read there yet; use navigate to open a URL in it first',
    )
  }
  return tab
}

function inject(tabId, func, args = []) {
  return chrome.scripting
    .executeScript({ target: { tabId }, func, args })
    .then((results) => results[0]?.result)
}

// ------------------------------------------------------- visual overlay
// The "this page is under AI control" indicator: the FROST VEIL — a
// WebGL frost sheet (a domain-warped heightfield lit like thin ice:
// diffuse + moving specular + fresnel rim + cavity/self shadow + crystal
// micro-facets) with a 3D parallax snowfall in front and a plain-language
// status pill at the bottom-center — plus per-action feedback (the
// clicked/typed element pulses and ripples). veil.js is re-injected on
// every action (idempotent; only the first run builds anything) and
// exposes window.__dshAugVeil in the page's isolated world; the small
// func below just calls its show()/fade() API. All of it is
// content-script DOM (page CSP does not apply) and pointer-events:none,
// so it can never block the agent's own clicks or the user's.
// Non-injectable pages (new tab page, chrome://) simply show nothing —
// every call is best-effort and silent.
const OVERLAY_ID = '__dshAugOverlay'
const OVERLAY_FADE_MS = 4000 // after an action OUTSIDE a turn (direct relay)
const OVERLAY_DONE_MS = 2500 // after "Done" at turn end

// Accent hue (0..360) chosen in the side panel's color popover: it themes
// the veil (passed to show()) and the click/type pulse. The panel mirrors
// its localStorage settings into chrome.storage.local because the SW is a
// separate context that cannot read the page's localStorage.
let accentHue = globalThis.__dshAugTheme.DEFAULTS.accentHue
let accentBright = globalThis.__dshAugTheme.DEFAULTS.accentBright
function syncAccent() {
  chrome.storage.local
    .get(['augmentor-accent-hue', 'augmentor-accent-bright'])
    .then((s) => {
      s = s || {}
      const h = Number(s['augmentor-accent-hue'])
      if (Number.isFinite(h) && h >= 0 && h < 360) accentHue = h
      const b = Number(s['augmentor-accent-bright'])
      if (Number.isFinite(b) && b >= -15 && b <= 15) accentBright = b
    })
    .catch(() => {})
}
// Guarded at every call site: without the "storage" permission
// (or in a context where the API is absent) chrome.storage is UNDEFINED
// and the property read throws synchronously — an unguarded top-level
// throw here would kill the SW before it registers its message listener,
// and the panel could never connect. Accent color must never take the
// agent down with it.
try {
  syncAccent()
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes['augmentor-accent-hue'] || changes['augmentor-accent-bright']))
      syncAccent()
  })
} catch { /* storage API unavailable: keep the default accent */ }

// "rgba(r, g, b" prefix of the accent pulse color (the veil's dot color),
// computed from the live accent hue at each action.
function pulseRgba() {
  const c = globalThis.__dshAugTheme.veilPalette(accentHue, accentBright).dot
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}`
}

let overlayTimer = null
let overlayTabId = null
// True while the veil is (expected to be) on screen. Gates the turn-end
// "Done ✓": a text-only turn never raised the veil, so there is nothing to
// report at its end.
let overlayVisible = false
// The status line the veil was last told to show (the early re-show after a
// navigation needs it so the fresh document gets the right label).
let overlayText = ''
// True from prompt to turn/end. While a turn runs, browser actions must NOT
// arm the idle fade — or the veil would flicker off between steps.
let turnActive = false

function injectFiles(tabId, files) {
  return chrome.scripting
    .executeScript({ target: { tabId }, files })
    .then(() => true)
}

function overlayShow(tabId, text, done = false) {
  if (tabId == null) return
  clearTimeout(overlayTimer)
  overlayTabId = tabId
  overlayVisible = true
  overlayText = String(text)
  injectFiles(tabId, ['veil.js'])
    .then(() =>
      inject(
        tabId,
        (text, done, hue, bright) =>
          window.__dshAugVeil ? window.__dshAugVeil.show(text, done, hue, bright) : 'no-veil',
        [String(text), done, accentHue, accentBright],
      ),
    )
    .catch(() => {})
  if (done || !turnActive) {
    overlayTimer = setTimeout(() => overlayFade(tabId), done ? OVERLAY_DONE_MS : OVERLAY_FADE_MS)
  } else {
    clearTimeout(overlayTimer)
  }
}

function overlayFade(tabId) {
  if (tabId == null) return
  overlayVisible = false
  inject(
    tabId,
    (id) => {
      if (window.__dshAugVeil) return window.__dshAugVeil.fade()
      // veil.js never got in (older page state) — plain CSS fade.
      const root = document.getElementById(id)
      if (!root) return 'absent'
      root.style.transition = 'opacity 0.6s'
      root.style.opacity = '0'
      setTimeout(() => root.remove(), 700)
      return 'fading'
    },
    [OVERLAY_ID],
  ).catch(() => {})
}

// A navigation of the work tab destroys the document — and the veil with
// it. Re-raise the veil as soon as the NEW document is loading, instead of
// waiting for full page load: while a turn runs, the effect must hold
// across page changes. At 'loading' the document may not be committed yet
// (script injection fails), so retry briefly; the navigate handler's own
// show-after-load stays as the backstop.
let earlyShowTries = 0
function earlyShowRetry(tabId) {
  if (!turnActive || !overlayVisible || tabId !== overlayTabId) return
  if (earlyShowTries > 10) return
  earlyShowTries++
  injectFiles(tabId, ['veil.js'])
    .then(() =>
      inject(
        tabId,
        (text, hue, bright) =>
          window.__dshAugVeil ? window.__dshAugVeil.show(text, false, hue, bright) : 'no-veil',
        [overlayText, accentHue, accentBright],
      ),
    )
    .catch(() => setTimeout(() => earlyShowRetry(tabId), 200))
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && tabId === overlayTabId && turnActive && overlayVisible) {
    earlyShowTries = 0
    earlyShowRetry(tabId)
  }
})

// Human status line for the badge, per browser action. Deliberately plain
// language — no selectors, no CSS — the badge is for the human, the model
// gets the real result. `phase`/`result` let the label flip from present
// ("Clicking…") to past tense with the element's human name ("Clicked on
// Sign in") once the action completes.
function overlayTextFor(action, params, phase, result) {
  const host = (u) => {
    try {
      return new URL(u).host
    } catch {
      return String(u ?? '').slice(0, 40)
    }
  }
  const name = (r) => {
    const t = String(r?.name ?? '').replace(/\s+/g, ' ').trim()
    if (!t) return 'the element'
    return t.length > 32 ? t.slice(0, 32) + '…' : t
  }
  switch (action) {
    case 'tabs_list':
      return 'Checking open tabs…'
    case 'navigate':
      return phase === 'after' ? `Opened ${host(params?.url)}` : `Opening ${host(params?.url)}…`
    case 'snapshot':
      return 'Analysing the page…'
    case 'click':
      return phase === 'after' ? `Clicked on ${name(result)}` : 'Clicking…'
    case 'type':
      return phase === 'after' ? `Typed into ${name(result)}` : 'Typing…'
    case 'html':
      return phase === 'after' ? `Checked ${name(result)}` : 'Inspecting…'
    default:
      return 'Thinking…'
  }
}

async function handleBrowserAction(id, params) {
  const t0 = Date.now()
  try {
    let out
    switch (params?.action) {
      case 'tabs_list': {
        const tabs = await chrome.tabs.query({})
        // focusedWindow marks the tab the user is currently looking at:
        // the active tab of the last-focused window.
        const wid = await focusedWindowId()
        out = {
          tabs: tabs.map((t) => ({
            id: t.id,
            url: t.url ?? null,
            title: t.title ?? null,
            active: !!t.active,
            focusedWindow: wid != null && !!t.active && t.windowId === wid,
          })),
        }
        try {
          overlayShow((await workTab()).id, overlayTextFor('tabs_list', params))
        } catch { /* no workable tab — nothing to mark */ }
        break
      }
      case 'navigate': {
        const url = String(params.url ?? '')
        if (!/^https?:\/\//i.test(url)) throw new Error(`refusing non-http(s) url: ${url}`)
        let tab
        try {
          tab = await workTab()
        } catch {
          tab = await chrome.tabs.create({ url, active: true })
          workTabId = tab.id
          // Claim the new tab as the overlay tab NOW: its first document
          // fires 'loading' while it loads, and the early re-show above
          // will raise the veil there as soon as it can.
          overlayShow(tab.id, overlayTextFor('navigate', params))
          const created = await waitForLoad(tab.id, url)
          overlayShow(tab.id, overlayTextFor('navigate', params, 'after'))
          out = { tabId: tab.id, url: created.url ?? url, title: created.title ?? null, newTab: true }
          break
        }
        overlayShow(tab.id, overlayTextFor('navigate', params))
        await chrome.tabs.update(tab.id, { url })
        const loaded = await waitForLoad(tab.id, url)
        // The old document is gone; re-inject on the fresh page.
        overlayShow(tab.id, overlayTextFor('navigate', params, 'after'))
        out = { tabId: tab.id, url: loaded.url ?? url, title: loaded.title ?? null }
        break
      }
      case 'snapshot': {
        const tab = await readableWorkTab()
        overlayShow(tab.id, overlayTextFor('snapshot', params))
        out = await inject(
          tab.id,
          () => {
            // The badge is injected into body, so hide it for the read —
            // its status text is not part of the page the model should see.
            const ov = document.getElementById('__dshAugOverlay')
            if (ov) ov.style.display = 'none'
            const out = {
              title: document.title,
              url: location.href,
              text: (document.body?.innerText ?? '').slice(0, 6000),
              links: [...document.querySelectorAll('a[href]')]
                .slice(0, 40)
                .map((a) => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href })),
            }
            if (ov) ov.style.display = ''
            return out
          },
        )
        break
      }
      case 'click': {
        const tab = await readableWorkTab()
        overlayShow(tab.id, overlayTextFor('click', params))
        out = await inject(
          tab.id,
          (selector, pulse) => {
            const el = document.querySelector(selector)
            if (!el) return { ok: false, error: `no element matches selector: ${selector}` }
            const humanName = (e) => {
              const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim()
              if (t) return t
              const al = (e.getAttribute('aria-label') || '').trim()
              if (al) return al
              const ph = (e.getAttribute('placeholder') || '').trim()
              if (ph) return 'the ' + ph
              const tag = e.tagName.toLowerCase()
              return tag === 'input' || tag === 'textarea' ? 'the input box' : 'the ' + tag
            }
            // Visual: scroll the target into view, pulse it, ripple ring —
            // in the user's accent color (the "rgba(r, g, b" prefix).
            try {
              el.scrollIntoView({ block: 'center', behavior: 'instant' })
              el.animate(
                [
                  { boxShadow: `0 0 0 0 ${pulse}, 0)` },
                  { boxShadow: `0 0 0 6px ${pulse}, 0.65)` },
                  { boxShadow: `0 0 0 0 ${pulse}, 0)` },
                ],
                { duration: 900, iterations: 2 },
              )
              const b = el.getBoundingClientRect()
              const r = document.createElement('div')
              r.style.cssText =
                `position:fixed;left:${b.left + b.width / 2}px;top:${b.top + b.height / 2}px;` +
                'width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
                `border:2px solid ${pulse}, 0.9);pointer-events:none;z-index:2147483647;`
              ;(document.body ?? document.documentElement).append(r)
              r.animate(
                [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(7)', opacity: 0 }],
                { duration: 750, easing: 'ease-out' },
              ).onfinish = () => r.remove()
            } catch { /* visual only — never fail the action for it */ }
            el.click()
            return {
              ok: true,
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || '').trim().slice(0, 120),
              name: humanName(el),
            }
          },
          [String(params.selector ?? ''), pulseRgba()],
        )
        if (out?.ok) overlayShow(tab.id, overlayTextFor('click', params, 'after', out))
        break
      }
      case 'type': {
        const tab = await readableWorkTab()
        overlayShow(tab.id, overlayTextFor('type', params))
        out = await inject(
          tab.id,
          (selector, text, pulse) => {
            const el = document.querySelector(selector)
            if (!el) return { ok: false, error: `no element matches selector: ${selector}` }
            const humanName = (e) => {
              const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim()
              if (t) return t
              const al = (e.getAttribute('aria-label') || '').trim()
              if (al) return al
              const ph = (e.getAttribute('placeholder') || '').trim()
              if (ph) return 'the ' + ph
              const tag = e.tagName.toLowerCase()
              return tag === 'input' || tag === 'textarea' ? 'the input box' : 'the ' + tag
            }
            // Visual: same pulse+ripple as click (accent-colored), so the
            // user sees where the text lands.
            try {
              el.scrollIntoView({ block: 'center', behavior: 'instant' })
              el.animate(
                [
                  { boxShadow: `0 0 0 0 ${pulse}, 0)` },
                  { boxShadow: `0 0 0 6px ${pulse}, 0.65)` },
                  { boxShadow: `0 0 0 0 ${pulse}, 0)` },
                ],
                { duration: 900, iterations: 2 },
              )
              const b = el.getBoundingClientRect()
              const r = document.createElement('div')
              r.style.cssText =
                `position:fixed;left:${b.left + b.width / 2}px;top:${b.top + b.height / 2}px;` +
                'width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
                `border:2px solid ${pulse}, 0.9);pointer-events:none;z-index:2147483647;`
              ;(document.body ?? document.documentElement).append(r)
              r.animate(
                [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(7)', opacity: 0 }],
                { duration: 750, easing: 'ease-out' },
              ).onfinish = () => r.remove()
            } catch { /* visual only */ }
            el.focus()
            if ('value' in el) el.value = text
            else el.textContent = text
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return { ok: true, tag: el.tagName.toLowerCase(), name: humanName(el) }
          },
          [String(params.selector ?? ''), String(params.text ?? ''), pulseRgba()],
        )
        if (out?.ok) overlayShow(tab.id, overlayTextFor('type', params, 'after', out))
        break
      }
      case 'html': {
        const tab = await readableWorkTab()
        overlayShow(tab.id, overlayTextFor('html', params))
        out = await inject(
          tab.id,
          (selector) => {
            const el = document.querySelector(selector)
            if (!el) return { ok: false, error: `no element matches selector: ${selector}` }
            const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
            const al = (el.getAttribute('aria-label') || '').trim()
            const ph = (el.getAttribute('placeholder') || '').trim()
            const tag = el.tagName.toLowerCase()
            const fallback = tag === 'input' || tag === 'textarea' ? 'the input box' : 'the ' + tag
            return { ok: true, html: (el.outerHTML ?? '').slice(0, 20000), name: t || al || (ph ? 'the ' + ph : null) || fallback }
          },
          [String(params.selector ?? '')],
        )
        if (out?.ok) overlayShow(tab.id, overlayTextFor('html', params, 'after', out))
        break
      }
      default:
        throw new Error(`unknown action: ${params?.action}`)
    }
    log('browser', { id, action: params?.action, ms: Date.now() - t0, out: summarize(out) })
    return { ...(out ?? { ok: true }), ms: Date.now() - t0 }
  } catch (e) {
    log('browser', { id, action: params?.action, ms: Date.now() - t0, error: String(e?.message ?? e) })
    // Surface the failure on the page too, so the user sees nothing
    // happened (and why) — on the last known work tab if one exists.
    // Translate the two most common machine errors into plain words; the
    // model gets the full message in the response either way.
    try {
      let msg = String(e?.message ?? e)
      if (/no element matches selector/i.test(msg)) msg = "couldn't find that element on the page"
      else if (/new tab page/i.test(msg)) msg = 'this tab is empty — ask me to open a page first'
      overlayShow(workTabId ?? overlayTabId, `⚠ ${msg.slice(0, 70)}`)
    } catch {}
    return { ok: false, error: String(e?.message ?? e), ms: Date.now() - t0 }
  }
}

let loadListeners = new Map()
function waitForLoad(tabId, expectedUrl, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ url: expectedUrl, title: null }), timeoutMs)
    const listener = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return
      finish(info)
    }
    function finish(info) {
      clearTimeout(timer)
      loadListeners.delete(tabId)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve({ url: info?.url ?? expectedUrl, title: info?.title ?? null })
    }
    loadListeners.set(tabId, listener)
    chrome.tabs.onUpdated.addListener(listener)
    // Already complete?
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') finish({ url: t.url, title: t.title })
    }).catch(() => {})
  })
}

// ------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'connect') {
    ensurePort()
    sendResponse({
      phase: state.phase,
      error: state.error,
      running: state.running,
      sessionId: SESSION_ID,
      model: state.selection,
      models: state.catalog,
      // M3: chat-lifecycle state for the panel (Open-in-DSH + Save badge).
      endpoint: state.endpoint,
      chatCwd: state.chatCwd,
      saved: [...state.saved],
    })
    return
  }
  if (msg?.type === 'save' || msg?.type === 'unsave') {
    // M3: one-tap Save / Unsave. The pipe forwards to the plugin, which
    // attaches (or detaches) THIS chat's DSH session to the workspace over
    // the dedicated chat dir. The saved set is refreshed from the plugin
    // (authoritative) so the badge never lies.
    const saving = msg.type === 'save'
    if (state.phase !== 'ready' || !sessionReady) {
      sendResponse({ ok: false, error: saving ? 'this chat is not on the server yet — send a message first' : 'not connected' })
      return
    }
    ;(async () => {
      try {
        const res = await request(saving ? 'augmentor/save' : 'augmentor/unsave', { sessionId: SESSION_ID })
        if (!res?.ok) throw new Error(res?.error ?? (saving ? 'save failed' : 'unsave failed'))
        try {
          const st = await request('augmentor/state', {})
          state.saved = new Set(st?.saved ?? [])
        } catch {
          // state refresh failed: fall back to the optimistic view
          if (saving) state.saved.add(SESSION_ID)
          else state.saved.delete(SESSION_ID)
        }
        sendResponse({ ok: true, saved: state.saved.has(SESSION_ID), sessionId: SESSION_ID, savedSet: [...state.saved] })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true // async
  }
  if (msg?.type === 'prompt') {
    // M2: the DSH app IS the runtime — our chat is a real DSH session,
    // created lazily on the first prompt (id = SESSION_ID, so live downlink
    // events route into this chat) and remembered in storage. The agent acts
    // on the tab the user is looking at NOW; mid-turn the work tab stays
    // sticky so a navigate → snapshot → click sequence never hops tabs under
    // the model's feet. The veil is NOT shown here: it appears when the
    // agent's FIRST browser action lands and is removed at turn end, so a
    // text-only turn never marks the user's tab "under AI control".
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    if (state.running) {
      sendResponse({ ok: false, error: 'finish the current turn before sending' })
      return
    }
    const text = String(msg.text ?? '').trim()
    if (!text) {
      sendResponse({ ok: false, error: 'empty prompt' })
      return
    }
    ;(async () => {
      try {
        if (!sessionReady) {
          // Verify the remembered session once per SW instance; on the first
          // prompt (or after a "new chat") create the real DSH session.
          const exists = await sessionHistoryOk(SESSION_ID)
          if (exists !== true) {
            if (exists === false) clearStoredSessionId()
            SESSION_ID = `augmentor-${crypto.randomUUID().slice(0, 8)}`
            saveSessionId(SESSION_ID)
            // M3: create the session IN the plugin's dedicated chat dir —
            // workspace attachSession validates the header cwd against the
            // workspace path, so a chat is saveable only if it was created
            // here. Fall back to the app home when the plugin is not up.
            const cwd = state.chatCwd ?? state.homeDir
            await request('session.create', {
              sessionId: SESSION_ID,
              ...(cwd ? { cwd } : {}),
            })
            broadcast(log('handshake', { event: 'session-created', sessionId: SESSION_ID }))
          }
          sessionReady = true
          if (state.selection) {
            // A fresh session starts on the app's default model; point it at
            // the remembered selection before the first turn.
            try {
              await request('session.selectModel', {
                sessionId: SESSION_ID,
                provider: state.selection.provider,
                model: state.selection.model,
              })
            } catch {
              /* the turn below surfaces a model error if it matters */
            }
          }
        }
        const res = await request('session.prompt', {
          sessionId: SESSION_ID,
          mode: 'queue',
          content: [{ type: 'text', text }],
        })
        sendResponse({ ok: true, accepted: res?.accepted === true, sessionId: SESSION_ID })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
      }
    })()
    return true // async
  }
  if (msg?.type === 'stop') {
    // M2: abort the live turn (session.cancel). The turn settles with
    // turn/end (aborted) and the agent goes idle, so the panel's Stop swaps
    // back to Send and a new prompt resumes the same session.
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    if (!sessionReady) {
      sendResponse({ ok: true, accepted: false })
      return
    }
    request('session.cancel', { sessionId: SESSION_ID })
      .then((res) => sendResponse({ ok: true, accepted: res?.accepted === true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // async
  }
  if (msg?.type === 'log') {
    // Full history by default (fresh panel load replays the whole chat); a
    // sinceSeq from a panel that already rendered up to that seq trims the
    // payload to genuinely new events, so the 2 s poll stays tiny.
    const since = Number.isFinite(msg.sinceSeq) ? msg.sinceSeq : -1
    const entries =
      since < 0 ? state.log : state.log.filter((e) => e.kind === 'event' && e.event?.seq > since)
    sendResponse({
      log: entries,
      phase: state.phase,
      error: state.error,
      running: state.running,
      model: state.selection,
      models: state.catalog,
      // M3: the 2 s poll keeps the panel's Save badge + Open-in-DSH button
      // current without any dedicated round trip.
      sessionId: SESSION_ID,
      endpoint: state.endpoint,
      chatCwd: state.chatCwd,
      saved: [...state.saved],
    })
    return
  }
  if (msg?.type === 'models') {
    // The picker's catalog + selection. Answered from memory when the
    // handshake already fetched it; otherwise a fresh bridge call (the panel
    // may open before the handshake lands, and the bridge serves the catalog
    // before the runtime is up, so the call is safe in 'connecting' too).
    const respond = (groups, error) =>
      sendResponse({ ok: groups !== null, groups, selection: state.selection, error: error ?? null })
    if (state.catalog) return respond(state.catalog, null)
    if (!state.port) {
      sendResponse({ ok: false, groups: null, selection: state.selection, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    request('augmentor/models')
      .then((catalog) => {
        state.catalog = Array.isArray(catalog?.groups) ? catalog.groups : []
        respond(state.catalog, catalog?.error ?? null)
      })
      .catch((e) => sendResponse({ ok: false, groups: null, selection: state.selection, error: e.message }))
    return true // async
  }
  if (msg?.type === 'model') {
    // Model switch (the panel's picker). M2: the DSH app IS the runtime, so
    // the switch lands on our live session (session.selectModel); while no
    // session exists yet it is remembered and applied at create (first
    // prompt). Switches only land while the turn is idle.
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    if (state.running) {
      sendResponse({ ok: false, error: 'finish the current turn before switching models' })
      return
    }
    const provider = msg.provider
    const model = msg.model
    const known =
      state.catalog?.some((g) => g.provider === provider && g.models.some((m) => m.model === model)) ?? false
    if (!known) {
      sendResponse({ ok: false, error: `unknown model: ${provider}/${model}` })
      return
    }
    if (state.selection && state.selection.provider === provider && state.selection.model === model) {
      sendResponse({ ok: true, changed: false, model: state.selection })
      return
    }
    const previous = state.selection
    state.selection = { provider, model }
    saveSelection(state.selection)
    const apply = sessionReady
      ? request('session.selectModel', { sessionId: SESSION_ID, provider, model })
      : Promise.resolve({ selected: { provider, model } })
    apply
      .then(() => {
        broadcast(log('handshake', { event: 'model-switch', provider, model }))
        sendResponse({ ok: true, changed: true, model: state.selection })
      })
      .catch(async (e) => {
        // Best effort: point the runtime back at the previous selection so
        // the old conversation keeps working (a failed selectModel does not
        // kill the DSH app — no error state needed, just report it).
        if (previous && sessionReady) {
          try {
            await request('session.selectModel', {
              sessionId: SESSION_ID,
              provider: previous.provider,
              model: previous.model,
            })
          } catch {
            /* the rollback failed too: the next turn surfaces it */
          }
        }
        state.selection = previous
        saveSelection(previous)
        broadcast(log('handshake', { event: 'model-switch-rolled-back', provider: previous?.provider, model: previous?.model }))
        sendResponse({ ok: false, error: e.message })
      })
    return true // async
  }
  if (msg?.type === 'newchat') {
    SESSION_ID = `augmentor-${crypto.randomUUID().slice(0, 8)}`
    saveSessionId(SESSION_ID)
    sessionReady = false // the stored id was never a DSH session (yet)
    panelViewSession = null
    state.running = false
    state.log = []
    state.wirelog = []
    // The old session's turn/end is now filtered out (new SESSION_ID), so a
    // veil left up by it would linger — take it down now.
    turnActive = false
    if (overlayVisible) overlayFade(overlayTabId)
    broadcast(log('newchat', { sessionId: SESSION_ID }))
    sendResponse({ ok: true, sessionId: SESSION_ID })
    return
  }
  if (msg?.type === 'shutdown') {
    request('shutdown', undefined)
      .then(() => {
        log('handshake', { event: 'shutdown-sent' })
      })
      .catch((e) => log('handshake', { event: 'shutdown-failed', error: e.message }))
    sendResponse({ ok: true })
    return
  }
  if (msg?.type === 'session/list') {
    // M1: the DSH app's own sessions, straight from the live app through the
    // pipe (POST /api/session.list). Rows carry no title in the base payload;
    // projections.values.title is present when the app named the session.
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    request('session.list', {})
      .then((res) => sendResponse({ ok: true, items: res?.items ?? [] }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // async
  }
  if (msg?.type === 'session/history') {
    // M1: one DSH session's event history for the panel's live-event
    // renderer (the vocabularies match: user/message, assistant/message,
    // tool/call, …). The panel resets its seq baseline before applying.
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    const sessionId = String(msg.sessionId ?? '')
    if (!sessionId) {
      sendResponse({ ok: false, error: 'missing sessionId' })
      return
    }
    request('session.history', { sessionId, maxMessages: 500 })
      .then((res) => sendResponse({ ok: true, events: res?.events ?? [], hasMore: res?.hasMore ?? false }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // async
  }
  if (msg?.type === 'session/view') {
    // M1: arm/disarm the panel-view live tail (see onSessionEvent).
    panelViewSession = msg.sessionId ? String(msg.sessionId) : null
    sendResponse({ ok: true })
    return
  }
  if (msg?.type === 'fence/probe') {
    // M1 evidence (C1): fetch from THIS origin (chrome-extension://…) — the
    // trust fence judges the request by Origin + sec-fetch-site metadata, so
    // a service-worker fetch is exactly what the fence sees. Three paths:
    // /api/augmentor (plugin exact route — expected 200, fence is
    // api-proxy-scoped and exact routes dispatch before the prefix table),
    // / (static control — network path), and a POST to a stock method route
    // (/api/session.list — expected 403 forbidden: the fence refusal this
    // probe exists to document). Results are persisted by the pipe to
    // trace/fence-probe.json.
    const probePath = async (method, p, body) => {
      try {
        const t0 = Date.now()
        const res = await fetch('http://127.0.0.1:3080' + p, { method, body })
        const text = await res.text()
        return { status: res.status, ok: res.ok, ms: Date.now() - t0, body: text.slice(0, 400) }
      } catch (e) {
        return { error: String(e?.message ?? e) }
      }
    }
    Promise.all([
      probePath('GET', '/api/augmentor'),
      probePath('GET', '/'),
      probePath('POST', '/api/session.list', JSON.stringify({ client: 'augmentor-fence-probe' })),
    ])
      .then(async ([api, root, fenced]) => {
        const out = { at: new Date().toISOString(), origin: self.location.origin, api, root, fenced }
        try {
          await request('trace/fence-probe', out)
        } catch {
          /* persistence is best-effort; the panel still shows the result */
        }
        sendResponse({ ok: true, probe: out })
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // async
  }
})
