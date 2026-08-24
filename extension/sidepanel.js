/**
 * Augmentor (powered by DSH) — side panel UI.
 *
 * ResonantOS-style sidebar: click the toolbar icon to open this panel. Same
 * protocol as the popup (the SW owns the native port); renders the session
 * event stream with GUI-parity styling (markdown, Think blocks, compact tool
 * rows, stats line).
 */

import { createChatUI } from './chat-render.js'

const ui = createChatUI({
  log: document.getElementById('log'),
  title: document.getElementById('title'),
  model: document.getElementById('model-label'), // inner span: the chip is now a button
  stats: document.getElementById('stats'),
  dot: document.getElementById('dot'),
  status: document.getElementById('status'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  connect: document.getElementById('connect'),
  top: document.getElementById('top'),
})

// The model chip is a button wrapping a label span. The event stream
// (chat-render) writes the running model into the span; the model picker
// (below) re-asserts the catalog's display name. Keep the trigger hidden
// until a label exists so a fresh/disconnected panel shows no dead chip.
function showModel() {
  const m = document.getElementById('model')
  m.hidden = !document.getElementById('model-label').textContent
}
const modelObs = new MutationObserver(showModel)
modelObs.observe(document.getElementById('model-label'), { childList: true, characterData: true })

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload })
}

// ── Model picker (the DSH composer's model seat) ────────────────────────────
// The catalog + selection ride along on every log/connect reply (the SW owns
// both, fetched from the bridge, which reads $DSH_HOME/settings.yaml — the
// DSH app's own model set). Picking a row switches the sidecar's model: the
// bridge restarts the runtime, and the conversation resumes from its
// persisted log. Switches land only while the turn is idle.
const modelBtn = document.getElementById('model')
const modelLabel = document.getElementById('model-label')
const modelPop = document.getElementById('modelpop')
const modelPopBody = document.getElementById('modelpop-body')
let pickerCatalog = null // groups: [{provider, name, models: [{provider, model, name}]}]
let pickerSelection = null // {provider, model}

const CHECK_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>'

// Fold the model info out of a log/connect reply into picker state.
function applyModelInfo(res) {
  if (Array.isArray(res.models)) pickerCatalog = res.models
  if (res.model && typeof res.model === 'object' && res.model.provider && res.model.model) {
    pickerSelection = res.model
  }
  renderPicker()
}

// Trigger label = the selected model's catalog name (the event stream writes
// its own derivation into the span; this re-asserts the catalog's, which
// matches it by convention).
function renderPicker() {
  if (pickerSelection) {
    const g = (pickerCatalog ?? []).find((x) => x.provider === pickerSelection.provider)
    const m = g?.models.find((x) => x.model === pickerSelection.model)
    modelLabel.textContent = m?.name ?? pickerSelection.model
  }
  // Popover content (re-rendered on open and on every catalog/selection
  // change; the open popover keeps its scroll position on unrelated events
  // only when nothing relevant changed — cheap to just rebuild, it is tiny).
  if (modelPop.hidden) return
  modelPopBody.replaceChildren()
  if (!pickerCatalog || !pickerCatalog.length) {
    const strip = document.createElement('div')
    strip.className = 'mp-strip'
    const label = document.createElement('span')
    const ready = ui.state.phase === 'ready'
    label.textContent = ready
      ? ui.state.error ?? 'Model list unavailable'
      : ui.state.phase === 'connecting'
        ? 'Loading models…'
        : 'Not connected'
    strip.appendChild(label)
    if (ready) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.textContent = 'Retry'
      retry.addEventListener('click', fetchModels)
      strip.appendChild(retry)
    }
    modelPopBody.appendChild(strip)
    return
  }
  for (const g of pickerCatalog) {
    const h = document.createElement('div')
    h.className = 'mp-group'
    h.textContent = g.name
    modelPopBody.appendChild(h)
    for (const m of g.models) {
      const sel = pickerSelection && pickerSelection.provider === m.provider && pickerSelection.model === m.model
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'mp-row'
      if (sel) row.classList.add('selected')
      row.title = `${g.provider} / ${m.model}`
      // Static check SVG markup (no user data) via innerHTML; the name is
      // textContent-only.
      row.innerHTML = '<span class="mp-name"></span><span class="mp-check">' + CHECK_SVG + '</span>'
      row.querySelector('.mp-name').textContent = m.name
      row.addEventListener('click', () => chooseModel(m))
      modelPopBody.appendChild(row)
    }
  }
}

// Fresh catalog fetch (the picker's Retry path; the SW answers from memory
// or the bridge).
async function fetchModels() {
  try {
    const res = await send('models')
    if (res?.ok) {
      pickerCatalog = res.groups
      if (res.selection) pickerSelection = res.selection
    } else if (res?.error) {
      modelPopBody.replaceChildren()
      const strip = document.createElement('div')
      strip.className = 'mp-strip err'
      strip.textContent = res.error
      modelPopBody.appendChild(strip)
      return
    }
  } catch {
    /* SW not ready */
  }
  renderPicker()
}

// Picked a row: ask the SW to switch (bridge restarts the runtime, the SW
// re-initializes it with the new selection, the session resumes from its
// persisted log).
async function chooseModel(sel) {
  closeModelPop()
  modelLabel.textContent = sel.name
  pickerSelection = { provider: sel.provider, model: sel.model }
  const res = await send('model', { provider: sel.provider, model: sel.model })
  if (res?.ok) {
    if (res.model) pickerSelection = res.model
    renderPicker()
  } else {
    ui.sendFail(res?.error ?? 'model switch failed')
  }
}

function openModelPop() {
  if (ui.state.running) return
  renderPicker()
  modelPop.hidden = false
  modelBtn.classList.add('open')
  // The chip sits at the panel bottom: the menu opens above it.
  const r = modelBtn.getBoundingClientRect()
  const margin = 8
  modelPop.style.top = `${Math.max(margin, r.top - modelPop.offsetHeight - 6)}px`
  modelPop.style.left = `${Math.max(
    margin,
    Math.min(r.right - modelPop.offsetWidth, window.innerWidth - modelPop.offsetWidth - margin),
  )}px`
}
function closeModelPop() {
  modelPop.hidden = true
  modelBtn.classList.remove('open')
}
modelBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  if (modelPop.hidden) openModelPop()
  else closeModelPop()
})
document.addEventListener('mousedown', (e) => {
  if (!modelPop.hidden && !modelPop.contains(e.target) && !modelBtn.contains(e.target)) closeModelPop()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modelPop.hidden) closeModelPop()
})

async function refresh() {
  try {
    // sinceSeq: the panel already rendered up to this event seq, so the SW
    // trims the reply to genuinely new events. -1 (nothing rendered yet)
    // requests the full history — a fresh panel load replays the whole chat.
    const res = await send('log', { sinceSeq: ui.lastSeq })
    if (!res) return
    ui.setState({ phase: res.phase, error: res.error, running: res.running })
    applyModelInfo(res)
    ui.applyLog(res.log)
  } catch {
    /* SW not ready yet */
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'evt') return
    ui.setState({ phase: msg.phase, error: msg.error, running: msg.running })
    // The SW pushes each new log entry with the event: render it directly.
    // The old per-event 'log' round-trip plus the 2 s poll is what made
    // streaming arrive in blocks.
    if (msg.entry) ui.applyLog([msg.entry])
    else refresh()
  })
}

// Keep the footer's Send/Stop pair in lock-step with the run state: Stop shows
// only while a turn is active; Send returns the moment the agent goes idle.
// The SW (via session.status) and the 2 s poll both funnel through setState.
// The model picker is locked for the duration of a turn (DSH parity): a
// switch restarts the runtime, which would cut the live turn.
const _setState = ui.setState
ui.setState = (s) => {
  _setState(s)
  const running = ui.state.running
  document.getElementById('send').hidden = running
  document.getElementById('stop').hidden = !running
  modelBtn.disabled = running
  modelBtn.title = running ? 'Finish the current turn to switch models' : 'Switch model'
  if (running && !modelPop.hidden) closeModelPop()
}

// ── Theme + color settings ────────────────────────────────────────────────
// Dark is the default (the GUI's dark palette); light rebinds every token on
// :root[data-theme="light"] and flips color-scheme so the native scrollbar
// follows. On top of that, three tunable colors (all restored pre-paint by
// theme-boot.js, which reads them from localStorage):
//   augmentor-neut-hue       tint of the neutral surfaces (0..360)
//   augmentor-neut-bright    lightness offset, applies in BOTH themes (-15..15)
//   augmentor-accent-hue     accent: panel brand + browser-control overlay
//   augmentor-accent-bright  accent lightness offset (-15..15)
// The hue icon (#hue) opens the popover; a copy of the values also lands in
// chrome.storage.local because the SW (a separate context) needs the accent
// hue to theme the veil and the click pulse (sw.js).
const T = globalThis.__dshAugTheme

const settings = (() => {
  const num = (k, d) => {
    let raw
    try { raw = localStorage.getItem(k) } catch { raw = null }
    // guard raw first: Number(null) is 0, which would mean red
    if (raw == null) return d
    const v = Number(raw)
    return Number.isFinite(v) ? v : d
  }
  return {
    neutHue: num('augmentor-neut-hue', T.DEFAULTS.neutHue),
    neutBright: num('augmentor-neut-bright', T.DEFAULTS.neutBright),
    accentHue: num('augmentor-accent-hue', T.DEFAULTS.accentHue),
    accentBright: num('augmentor-accent-bright', T.DEFAULTS.accentBright),
  }
})()

let storageTimer = 0
function persistSettings() {
  try {
    localStorage.setItem('augmentor-neut-hue', String(settings.neutHue))
    localStorage.setItem('augmentor-neut-bright', String(settings.neutBright))
    localStorage.setItem('augmentor-accent-hue', String(settings.accentHue))
    localStorage.setItem('augmentor-accent-bright', String(settings.accentBright))
  } catch { /* storage unavailable */ }
  clearTimeout(storageTimer)
  storageTimer = setTimeout(() => {
    try {
      chrome.storage.local.set({
        'augmentor-neut-hue': settings.neutHue,
        'augmentor-neut-bright': settings.neutBright,
        'augmentor-accent-hue': settings.accentHue,
        'augmentor-accent-bright': settings.accentBright,
      }).catch(() => {})
    } catch { /* SW context not available */ }
  }, 250)
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

const hueBtn = document.getElementById('hue')
const pop = document.getElementById('huepop')
const neutHueEl = document.getElementById('neut-hue')
const neutBrightEl = document.getElementById('neut-bright')
const accentHueEl = document.getElementById('accent-hue')
const accentBrightEl = document.getElementById('accent-bright')
const accentSwatch = document.getElementById('accent-swatch')
const brightVal = document.getElementById('neut-bright-val')
const accentBrightVal = document.getElementById('accent-bright-val')
const veilPreview = document.getElementById('veil-preview')
const veilDot = veilPreview.querySelector('.vp-dot')

const signed = (n) => (n > 0 ? `+${n}` : String(n))

// Rebind every tunable token for the active theme and refresh the popover's
// live previews (accent swatch, brightness readout, mini veil pill).
function applyColorSettings() {
  T.applyPanelTheme(
    document.documentElement,
    currentTheme(),
    settings.neutHue,
    settings.neutBright,
    settings.accentHue,
    settings.accentBright,
  )
  accentSwatch.style.background = T.panelTheme(
    currentTheme(), settings.neutHue, settings.neutBright, settings.accentHue, settings.accentBright,
  )['--brand']
  // Mini veil pill: the overlay palette is theme-independent (it always
  // floats over page content, so it keeps the dark-pill look).
  const p = T.veilPalette(settings.accentHue, settings.accentBright)
  veilPreview.style.background =
    `linear-gradient(180deg, ${T.rgbaStr(p.pillBg1, 0.94)}, ${T.rgbaStr(p.pillBg2, 0.94)})`
  veilPreview.style.borderColor = T.rgbaStr(p.dotDone, 0.28)
  veilPreview.style.boxShadow =
    `0 2px 10px rgba(0, 0, 0, 0.35), 0 0 0 1px ${T.rgbaStr(p.dot, 0.18)}`
  veilPreview.style.color = T.rgbStr(p.label)
  veilDot.style.background = T.rgbStr(p.dot)
  brightVal.textContent = signed(settings.neutBright)
  accentBrightVal.textContent = signed(settings.accentBright)
}

function syncPopInputs() {
  neutHueEl.value = settings.neutHue
  neutBrightEl.value = settings.neutBright
  accentHueEl.value = settings.accentHue
  accentBrightEl.value = settings.accentBright
}

function openPop() {
  syncPopInputs()
  applyColorSettings()
  const r = hueBtn.getBoundingClientRect()
  pop.hidden = false
  const margin = 8
  const left = Math.max(margin, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - margin))
  pop.style.top = `${r.bottom + 6}px`
  pop.style.left = `${left}px`
}
function closePop() {
  pop.hidden = true
}

hueBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  if (pop.hidden) openPop()
  else closePop()
})
document.addEventListener('mousedown', (e) => {
  if (!pop.hidden && !pop.contains(e.target) && e.target !== hueBtn) closePop()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pop.hidden) closePop()
})

for (const [el, key] of [
  [neutHueEl, 'neutHue'],
  [neutBrightEl, 'neutBright'],
  [accentHueEl, 'accentHue'],
  [accentBrightEl, 'accentBright'],
]) {
  el.addEventListener('input', () => {
    settings[key] = Number(el.value)
    applyColorSettings()
    persistSettings()
  })
}

document.getElementById('hue-reset').addEventListener('click', () => {
  settings.neutHue = T.DEFAULTS.neutHue
  settings.neutBright = T.DEFAULTS.neutBright
  settings.accentHue = T.DEFAULTS.accentHue
  settings.accentBright = T.DEFAULTS.accentBright
  syncPopInputs()
  applyColorSettings()
  persistSettings()
})

// Tokens are already applied pre-paint by theme-boot.js; this just refreshes
// the popover previews (and slider positions) on load.
syncPopInputs()
applyColorSettings()

// Light/dark switch — top of the Colors popover (moved out of the header so
// theme can be toggled while the colors are open).
const themeSeg = document.getElementById('theme-seg')
function setTheme(theme) {
  const root = document.documentElement
  if (theme === 'light') root.dataset.theme = 'light'
  else delete root.dataset.theme
  try {
    if (theme === 'light') localStorage.setItem('augmentor-theme', 'light')
    else localStorage.removeItem('augmentor-theme')
  } catch { /* storage unavailable: theme still toggles for this open */ }
  syncThemeSeg()
  applyColorSettings()
}
function syncThemeSeg() {
  const active = currentTheme()
  for (const b of themeSeg.querySelectorAll('button')) {
    const on = b.dataset.themeOpt === active
    b.classList.toggle('active', on)
    b.setAttribute('aria-pressed', String(on))
  }
}
for (const b of themeSeg.querySelectorAll('button'))
  b.addEventListener('click', () => setTheme(b.dataset.themeOpt))
syncThemeSeg()

document.getElementById('connect').addEventListener('click', async () => {
  await send('connect')
  refresh()
})

// "＋ New chat": the SW mints a fresh sessionId (the runtime lazily creates
// the agent+session pair on the next prompt) and clears its log.
document.getElementById('newchat').addEventListener('click', async () => {
  const res = await send('newchat')
  if (res?.ok) ui.clear()
  refresh()
})

async function doSend() {
  const input = document.getElementById('input')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  const res = await send('prompt', { text })
  if (res?.ok === false) ui.sendFail(res.error)
  refresh()
}

document.getElementById('send').addEventListener('click', doSend)
document.getElementById('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    doSend()
  }
})
// Stop the live run: the SW aborts the turn (session/interrupt → agent.cancel).
// The turn settles with a `turn/end` (aborted) and the agent goes idle, so the
// Stop button swaps back to Send and a new prompt resumes the same session.
document.getElementById('stop').addEventListener('click', async () => {
  const res = await send('stop')
  if (res?.ok === false) ui.sendFail(res.error)
})

// Test hook: sidepanel.html?task=<text> auto-connects and sends once
// ready (used for the automated browser-leg runs).
const taskParam = new URLSearchParams(location.search).get('task')
if (taskParam) {
  document.getElementById('input').value = taskParam
  document.getElementById('connect').click()
  const waitForSend = setInterval(() => {
    const sendBtn = document.getElementById('send')
    if (!sendBtn.disabled) {
      clearInterval(waitForSend)
      doSend()
    }
  }, 500)
  setTimeout(() => clearInterval(waitForSend), 60000)
}

refresh()
const poll = setInterval(refresh, 2000)
window.addEventListener('pagehide', () => clearInterval(poll))
