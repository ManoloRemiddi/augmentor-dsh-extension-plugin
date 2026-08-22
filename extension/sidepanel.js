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
  model: document.getElementById('model'),
  stats: document.getElementById('stats'),
  dot: document.getElementById('dot'),
  status: document.getElementById('status'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  connect: document.getElementById('connect'),
  top: document.getElementById('top'),
})

function showModel() {
  const m = document.getElementById('model')
  m.hidden = !m.textContent
}
const modelObs = new MutationObserver(showModel)
modelObs.observe(document.getElementById('model'), { childList: true, characterData: true })

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload })
}

async function refresh() {
  try {
    // sinceSeq: the panel already rendered up to this event seq, so the SW
    // trims the reply to genuinely new events. -1 (nothing rendered yet)
    // requests the full history — a fresh panel load replays the whole chat.
    const res = await send('log', { sinceSeq: ui.lastSeq })
    if (!res) return
    ui.setState({ phase: res.phase, error: res.error, running: res.running })
    ui.applyLog(res.log)
  } catch {
    /* SW not ready yet */
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'evt') return
  ui.setState({ phase: msg.phase, error: msg.error, running: msg.running })
  // The SW pushes each new log entry with the event: render it directly.
  // The old per-event 'log' round-trip plus the 2 s poll is what made
  // streaming arrive in blocks.
  if (msg.entry) ui.applyLog([msg.entry])
  else refresh()
})

// Theme toggle: dark is the default (the GUI's dark palette); light rebinds
// every token on :root[data-theme="light"] and flips color-scheme so the
// native scrollbar follows. The preference persists across panel opens
// (restored pre-paint by theme-boot.js).
const themeBtn = document.getElementById('theme')
themeBtn.addEventListener('click', () => {
  const root = document.documentElement
  const toLight = root.dataset.theme !== 'light'
  if (toLight) root.dataset.theme = 'light'
  else delete root.dataset.theme
  themeBtn.title = toLight ? 'Switch to dark theme' : 'Switch to light theme'
  try {
    if (toLight) localStorage.setItem('augmentor-theme', 'light')
    else localStorage.removeItem('augmentor-theme')
  } catch { /* storage unavailable: theme still toggles for this open */ }
})

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
