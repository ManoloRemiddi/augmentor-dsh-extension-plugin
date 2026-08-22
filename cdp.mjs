#!/usr/bin/env node
/**
 * cdp.mjs — minimal Chrome DevTools Protocol client for Augmentor.
 * Talks to a Chromium instance exposing --remote-debugging-port (the user's
 * running instance uses 9222). Raw WebSocket: text frames only, no deps.
 *
 * usage:
 *   node cdp.mjs targets
 *   node cdp.mjs open <url>
 *   node cdp.mjs eval <targetId> '<js expression>'
 */

import { connect as netConnect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const HOST = '127.0.0.1'
const CDP_PORT = Number(process.env['CDP_PORT'] || 9222)

async function http(pathname) {
  const res = await fetch(`http://${HOST}:${CDP_PORT}${pathname}`)
  return res
}

// ------------------------------------------------- raw websocket client
function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl)
    const sock = netConnect({ host: u.hostname, port: Number(u.port) || 80 })
    let buf = Buffer.alloc(0)
    let upgraded = false
    const pending = new Map()
    let idSeq = 0
    let settled = false

    // Client-to-server frames MUST be masked (RFC 6455 §5.3): mask bit set,
    // 4-byte random key after the length, payload XOR'd with the key.
    function buildMaskedFrame(opcode, payload) {
      const mask = randomBytes(4)
      const masked = Buffer.alloc(payload.length)
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]
      let header
      if (payload.length < 126) {
        header = Buffer.from([opcode, payload.length | 0x80])
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4)
        header[0] = opcode
        header[1] = 126 | 0x80
        header.writeUInt16BE(payload.length, 2)
      } else {
        header = Buffer.alloc(10)
        header[0] = opcode
        header[1] = 127 | 0x80
        header.writeBigUInt64BE(BigInt(payload.length), 2)
      }
      return Buffer.concat([header, mask, masked])
    }

    const client = {
      onMessage: null,
      close() {
        sock.end()
      },
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++idSeq
          pending.set(id, { res, rej })
          const payload = Buffer.from(JSON.stringify({ id, method, params: params ?? {} }))
          if (payload.length > 2 ** 20) {
            pending.delete(id)
            rej(new Error('frame too large for augmentor ws client'))
            return
          }
          sock.write(buildMaskedFrame(0x81, payload))
        })
      },
    }

    function sendFrame(opcode, data) {
      sock.write(buildMaskedFrame(opcode, data))
    }

    sock.once('connect', () => {
      const key = randomBytes(16).toString('base64')
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) return
        const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString()
        if (!/^HTTP\/1\.[01] 101/i.test(statusLine)) {
          settled = true
          reject(new Error(`ws upgrade failed: ${statusLine}`))
          sock.destroy()
          return
        }
        upgraded = true
        buf = buf.subarray(idx + 4)
        settled = true
        resolve(client)
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f
        const len7 = buf[1] & 0x7f
        let off = 2
        let payloadLen = len7
        if (len7 === 126) {
          if (buf.length < 4) return
          payloadLen = buf.readUInt16BE(2)
          off = 4
        } else if (len7 === 127) {
          if (buf.length < 10) return
          payloadLen = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        if (buf.length < off + payloadLen) return
        const payload = buf.subarray(off, off + payloadLen)
        buf = buf.subarray(off + payloadLen)
        if (opcode === 0x8) {
          sock.end()
          return
        }
        if (opcode === 0x9) {
          sendFrame(0xa, payload) // pong
          continue
        }
        if (opcode !== 0x1 && opcode !== 0x0) continue
        let msg
        try {
          msg = JSON.parse(payload.toString('utf8'))
        } catch {
          continue
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.error) p.rej(new Error(msg.error.message))
          else p.res(msg.result)
        } else if (client.onMessage) {
          client.onMessage(msg)
        }
      }
    })

    sock.on('error', (e) => {
      if (!settled) {
        settled = true
        reject(e)
      }
    })
  })
}

// ------------------------------------------------------------- commands
async function listTargets() {
  const res = await http('/json/list')
  const targets = await res.json()
  return targets
}

async function newTab(url) {
  const res = await http(`/json/new?${new URLSearchParams({ url })}`, { method: 'PUT' })
  if (!res.ok) {
    // Older/newer Chrome variant: GET.
    const res2 = await http(`/json/new?${new URLSearchParams({ url })}`)
    if (!res2.ok) throw new Error(`/json/new failed: PUT ${res.status} GET ${res2.status}`)
    return res2.json()
  }
  return res.json()
}

async function closeTarget(id) {
  const res = await http(`/json/close/${id}`)
  return res.ok
}

async function evalIn(targetId, expression) {
  const targets = await listTargets()
  const target = targets.find((t) => t.id === targetId)
  if (!target?.webSocketDebuggerUrl) throw new Error(`no ws for target ${targetId}`)
  const ws = await wsConnect(target.webSocketDebuggerUrl)
  try {
    const r = await ws.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 60000,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)
      throw new Error(`page exception: ${d}`)
    }
    return r.result?.value
  } finally {
    ws.close()
  }
}

async function browserCommand(method, params) {
  const res = await http('/json/version')
  const v = await res.json()
  const ws = await wsConnect(v.webSocketDebuggerUrl)
  try {
    return await ws.send(method, params)
  } finally {
    ws.close()
  }
}

const [cmd, a, b] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'newtab': {
      const r = await browserCommand('Target.createTarget', { url: a })
      console.log(JSON.stringify(r))
      break
    }
    case 'bcmd': {
      const r = await browserCommand(a, JSON.parse(b ?? '{}'))
      console.log(JSON.stringify(r))
      break
    }
    case 'targets': {
      const t = await listTargets()
      for (const x of t) console.log(`${x.type}\t${x.id}\t${x.url.slice(0, 110)}`)
      break
    }
    case 'open': {
      const t = await newTab(a)
      console.log(JSON.stringify({ id: t.id, url: t.url }, null, 2))
      break
    }
    case 'eval': {
      const v = await evalIn(a, b)
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
      break
    }
    case 'close': {
      console.log(JSON.stringify({ closed: await closeTarget(a) }))
      break
    }
    case 'shot': {
      // Page.captureScreenshot on the target's own session → <a>=targetId <b>=out.png
      const targets = await listTargets()
      const target = targets.find((t) => t.id === a)
      if (!target?.webSocketDebuggerUrl) throw new Error(`no ws for target ${a}`)
      const ws = await wsConnect(target.webSocketDebuggerUrl)
      try {
        const r = await ws.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(b, Buffer.from(r.data, 'base64'))
        console.log(`saved ${b}`)
      } finally {
        ws.close()
      }
      break
    }
    default:
      console.error('usage: cdp.mjs targets | open <url> | eval <targetId> <expr> | close <targetId>')
      process.exit(2)
  }
} catch (e) {
  console.error(`cdp error: ${e.message}`)
  process.exit(1)
}
