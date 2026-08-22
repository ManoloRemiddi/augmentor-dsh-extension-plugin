/**
 * Augmentor (powered by DSH) — popup UI (legacy).
 *
 * Thin renderer over the service-worker log: user messages, streaming
 * assistant text, tool calls/results, turn markers. The SW owns the native
 * port; this view may close and reopen freely.
 */

const $log = document.getElementById('log')
const $status = document.getElementById('status')
const $dot = document.getElementById('dot')
const $running = document.getElementById('running')
const $input = document.getElementById('input')
const $send = document.getElementById('send')
const $connect = document.getElementById('connect')

let assistantEl = null
let reasoningEl = null
let maxSeq = -1

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function addDivider(text) {
  $log.appendChild(el('div', 'divider', text))
  scroll()
}

function scroll() {
  $log.scrollTop = $log.scrollHeight
}

function compact(value, max = 240) {
  let s = typeof value === 'string' ? value : JSON.stringify(value)
  if (s == null) s = 'null'
  return s.length > max ? s.slice(0, max) + '…' : s
}

function blockText(content) {
  if (!Array.isArray(content)) return compact(content)
  return content
    .map((b) => (b?.type === 'text' ? b.text : b?.type === 'tool-result' ? blockText(b.content) : ''))
    .filter(Boolean)
    .join('\n')
}

function renderEvent(entry) {
  // entries are {t, kind:'event', sessionId, event} from the SW log
  const ev = entry.event
  if (!ev || !ev.type) return
  const data = ev.data ?? {}
  switch (ev.type) {
    case 'user/message': {
      assistantEl = null
      reasoningEl = null
      const text = blockText(data.content)
      $log.appendChild(el('div', 'msg user', 'You: ' + text))
      break
    }
    case 'assistant/chunk': {
      const c = data.chunk
      if (c.type === 'text-delta') {
        if (!assistantEl) {
          assistantEl = el('div', 'msg assistant')
          $log.appendChild(assistantEl)
        }
        assistantEl.appendChild(document.createTextNode(c.text))
      } else if (c.type === 'reasoning-delta') {
        if (!reasoningEl) {
          reasoningEl = document.createElement('details')
          reasoningEl.className = 'reason'
          reasoningEl.append(el('summary', null, 'reasoning'))
          reasoningEl.appendChild(el('pre'))
          if (!assistantEl) {
            assistantEl = el('div', 'msg assistant')
            $log.appendChild(assistantEl)
          }
          assistantEl.appendChild(reasoningEl)
        }
        reasoningEl.querySelector('pre').appendChild(document.createTextNode(c.text))
      }
      break
    }
    case 'assistant/message': {
      if (data.usage) {
        const u = data.usage
        const span = el(
          'span',
          'usage',
          `tokens: in ${u.inputTokens} / out ${u.outputTokens}${u.reasoningTokens ? ` / r ${u.reasoningTokens}` : ''}`,
        )
        ;(assistantEl ?? $log).appendChild(span)
      }
      assistantEl = null
      reasoningEl = null
      break
    }
    case 'tool/call': {
      $log.appendChild(el('div', 'tool', `🔧 ${data.name} ${compact(data.arguments, 200)}`))
      break
    }
    case 'tool/result': {
      const isError = !!(data.message?.isError ?? data.error)
      const text = blockText(data.message?.content)
      $log.appendChild(el('div', `tool result${isError ? ' err' : ''}`, `↳ ${compact(text, 240)}`))
      break
    }
    case 'turn/end': {
      addDivider(`— turn ${data.turn} ended: ${data.reason} —`)
      break
    }
    case 'turn/start':
      break
    default:
      break // step/*, request/*, todo/write, … not rendered in this panel
  }
  scroll()
}

function applyLog(log) {
  let browserActions = 0
  for (const entry of log) {
    if (entry.kind === 'event' && entry.event?.seq != null) {
      if (entry.event.seq <= maxSeq) continue
      maxSeq = entry.event.seq
      renderEvent(entry)
    }
    if (entry.kind === 'browser') browserActions++
  }
  $status.dataset.actions = browserActions
  scroll()
}

function updateStatus(phase, error, running) {
  $dot.className = 'dot ' + (phase === 'ready' ? 'ready' : phase === 'connecting' ? 'connecting' : phase === 'error' ? 'error' : '')
  $status.textContent =
    phase === 'ready' ? 'connected' : phase === 'connecting' ? 'connecting…' : phase === 'error' ? `error: ${error ?? ''}` : 'disconnected — click Connect'
  const actions = Number($status.dataset.actions ?? 0)
  $running.textContent = [running ? 'agent working…' : '', actions ? `${actions} browser call(s)` : ''].filter(Boolean).join(' · ')
  $send.disabled = phase !== 'ready' || running
  $connect.disabled = phase === 'ready' || phase === 'connecting'
}

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload })
}

async function refresh() {
  try {
    const res = await send('log')
    if (!res) return
    updateStatus(res.phase, res.error, res.running)
    applyLog(res.log)
  } catch {
    /* SW not ready yet */
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'evt') {
    updateStatus(msg.phase, msg.error, msg.running)
    refresh()
  }
})

$connect.addEventListener('click', async () => {
  $connect.disabled = true
  await send('connect')
  refresh()
})

async function doSend() {
  const text = $input.value.trim()
  if (!text) return
  $input.value = ''
  const res = await send('prompt', { text })
  if (res?.ok === false) {
    $log.appendChild(el('div', 'tool err', `send failed: ${res.error}`))
  }
  scroll()
  refresh()
}

$send.addEventListener('click', doSend)
$input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    doSend()
  }
})

// Test hook: popup.html?task=<text> auto-connects and sends the task
// once the sidecar is ready (used for the automated browser-leg run).
const taskParam = new URLSearchParams(location.search).get('task')
if (taskParam) {
  $input.value = taskParam
  $connect.click()
  const waitForSend = setInterval(() => {
    if (!$send.disabled) {
      clearInterval(waitForSend)
      doSend()
    }
  }, 500)
  setTimeout(() => clearInterval(waitForSend), 60000)
}

refresh()
// Poll lightly in case the popup opened before an evt landed.
const poll = setInterval(refresh, 2000)
window.addEventListener('pagehide', () => clearInterval(poll))
