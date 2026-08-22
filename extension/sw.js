/**
 * Augmentor (powered by DSH) — MV3 service worker.
 *
 * Owns the native messaging port to the Augmentor bridge (an open port keeps this
 * SW alive, so the popup may close while the agent works). Relays prompts and
 * session events between the popup and the runtime, and executes browser
 * actions the runtime requests via the bridge.
 */

const HOST = 'com.deepseek.dsh.augmentor'
const PROVIDER = 'local-qwen'
const MODEL = 'Qwen3.8-27B-UD-Q6_K_XL'

// ResonantOS-style behavior: clicking the toolbar icon opens the side panel
// (the manifest no longer declares a default_popup, which would take
// precedence over the panel).
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  chrome.sidePanel.setOptions({ path: 'sidepanel.html' })
} catch (e) {
  console.warn('sidePanel setup failed', e)
}
// Fresh id per SW instance (and per "new chat"): the runtime persists
// session logs by id and lazily creates an agent+session pair for any
// unknown id (session/prompt), so a fresh random id is always safe.
let SESSION_ID = `augmentor-${crypto.randomUUID().slice(0, 8)}`

const state = {
  phase: 'disconnected', // disconnected | connecting | ready | error
  error: null,
  running: false,
  port: null,
  reqSeq: 0,
  pending: new Map(), // id -> {method, resolve}
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
    // Only the current session is surfaced: after "new chat" the runtime may
    // still stream tail events for the previous session.
    if (msg.method === 'session.event') {
      if (msg.params?.sessionId !== SESSION_ID) return
      // Turn ended: the agent gives back control — "Done", then fade.
      if (msg.params?.event?.type === 'turn/end') {
        turnActive = false
        overlayShow(overlayTabId, 'Done ✓', true)
      }
      // Full envelope: the panel renders from it and the seq is its dedupe key.
      broadcast(log('event', { sessionId: msg.params?.sessionId, event: msg.params?.event }))
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

  function fail(message) {
    state.phase = 'error'
    state.error = message
    state.port = null
    state.pending.forEach((w) => w.reject(new Error(message)))
    state.pending.clear()
    broadcast()
  }

  // Handshake: the runtime serves no other client, so initialize now.
  request('initialize', {
    cwd: 'chrome-extension://augmentor',
    provider: PROVIDER,
    model: MODEL,
  })
    .then((result) => {
      state.phase = 'ready'
      broadcast(log('handshake', { serverInfo: result.serverInfo }))
    })
    .catch((e) => fail(`initialize failed: ${e.message}`))
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
let overlayTimer = null
let overlayTabId = null
// The indicator lives for the WHOLE turn: it appears when the agent takes
// control (prompt) and is only removed right before the answer (done fade).
// Mid-turn actions must NOT arm the idle fade — or the veil would flicker
// off between steps.
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
  injectFiles(tabId, ['veil.js'])
    .then(() =>
      inject(
        tabId,
        (text, done) => (window.__dshAugVeil ? window.__dshAugVeil.show(text, done) : 'no-veil'),
        [String(text), done],
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
          (selector) => {
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
            // Visual: scroll the target into view, pulse it, ripple ring.
            try {
              el.scrollIntoView({ block: 'center', behavior: 'instant' })
              el.animate(
                [
                  { boxShadow: '0 0 0 0 rgba(34,197,94,0)' },
                  { boxShadow: '0 0 0 6px rgba(34,197,94,0.65)' },
                  { boxShadow: '0 0 0 0 rgba(34,197,94,0)' },
                ],
                { duration: 900, iterations: 2 },
              )
              const b = el.getBoundingClientRect()
              const r = document.createElement('div')
              r.style.cssText =
                `position:fixed;left:${b.left + b.width / 2}px;top:${b.top + b.height / 2}px;` +
                'width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
                'border:2px solid rgba(34,197,94,0.9);pointer-events:none;z-index:2147483647;'
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
          [String(params.selector ?? '')],
        )
        if (out?.ok) overlayShow(tab.id, overlayTextFor('click', params, 'after', out))
        break
      }
      case 'type': {
        const tab = await readableWorkTab()
        overlayShow(tab.id, overlayTextFor('type', params))
        out = await inject(
          tab.id,
          (selector, text) => {
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
            // Visual: same pulse+ripple as click, so the user sees where
            // the text lands.
            try {
              el.scrollIntoView({ block: 'center', behavior: 'instant' })
              el.animate(
                [
                  { boxShadow: '0 0 0 0 rgba(34,197,94,0)' },
                  { boxShadow: '0 0 0 6px rgba(34,197,94,0.65)' },
                  { boxShadow: '0 0 0 0 rgba(34,197,94,0)' },
                ],
                { duration: 900, iterations: 2 },
              )
              const b = el.getBoundingClientRect()
              const r = document.createElement('div')
              r.style.cssText =
                `position:fixed;left:${b.left + b.width / 2}px;top:${b.top + b.height / 2}px;` +
                'width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
                'border:2px solid rgba(34,197,94,0.9);pointer-events:none;z-index:2147483647;'
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
          [String(params.selector ?? ''), String(params.text ?? '')],
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
    sendResponse({ phase: state.phase, error: state.error, running: state.running, sessionId: SESSION_ID, model: MODEL })
    return
  }
  if (msg?.type === 'prompt') {
    // New user turn: the agent acts on the tab the user is looking at NOW.
    // Mid-turn, the work tab stays sticky so a multi-step sequence
    // (navigate → snapshot → click) never hops tabs under the model's feet.
    workTabId = null
    if (state.phase !== 'ready') {
      sendResponse({ ok: false, error: state.error ?? `not ready (phase: ${state.phase})` })
      return
    }
    // Show the "AI at work" indicator immediately — the agent has taken
    // control, and it stays up for the whole turn (turnActive). Best-effort:
    // no workable tab yet (fresh new-tab page) just means the first action
    // places it instead.
    turnActive = true
    workTab().then((t) => overlayShow(t.id, 'Thinking…')).catch(() => {})
    request('session/prompt', {
      sessionId: SESSION_ID,
      contentBlocks: [{ type: 'text', text: String(msg.text ?? '') }],
    })
      .then((receipt) => {
        broadcast(log('prompt', { messageId: receipt.messageId, text: String(msg.text).slice(0, 200) }))
        sendResponse({ ok: true, messageId: receipt.messageId })
      })
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
    sendResponse({ log: entries, phase: state.phase, error: state.error, running: state.running })
    return
  }
  if (msg?.type === 'newchat') {
    SESSION_ID = `augmentor-${crypto.randomUUID().slice(0, 8)}`
    state.running = false
    state.log = []
    state.wirelog = []
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
})
