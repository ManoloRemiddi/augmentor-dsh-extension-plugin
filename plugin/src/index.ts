/**
 * dsh-augmentor — the DSH-side half of the Augmentor bridge.
 *
 * The Chrome extension cannot reach the DSH /api surface: the trust fence
 * admits loopback-Host clients only and refuses cross-site fetch metadata,
 * and a chrome-extension Origin can never satisfy it. The native-messaging
 * pipe (augmentor/pipe.mjs) is therefore the sole pipe client. It speaks the
 * stock /api protocol directly (client-request POSTs plus the two downlink
 * WebSockets) and connects here over the upgrade route for the browser round
 * trips the tools need.
 *
 * Surface (loopback-reachable; reachability is the fence's job, not this
 * plugin's):
 *   GET <apiPath>   handshake JSON: {name, protocol, version, wsPath, pipes, time}
 *   WS  <wsPath>    pipe channel (token-gated, see below); frame vocabulary below
 *   tool browser_tabs_list
 *
 * Token gate: the action channel is the one surface that drives the user's
 * browser, so it takes a token on the upgrade URL (?token=…). Precedence:
 * config.wsToken (explicit) > the per-machine secret file
 * $DSH_HOME/augmentor-ws-token (created 0600 on first boot by whichever side
 * gets there first — the plugin or the pipe read the same file). With no
 * token resolvable the channel is open, which is logged as a warning.
 *
 * Pipe frame vocabulary (one JSON object per WS message):
 *   pipe → plugin: {type: 'hello', name, version}
 *                   {type: 'request', id, method: 'browser/execute', params}
 *   plugin → pipe: {type: 'welcome', name, version}
 *                  {type: 'reply', id, result}
 *                  {type: 'reply', id, error: {message}}
 * Requests are broadcast to every connected pipe; the first reply settles
 * the waiter, later replies are dropped as late.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

export const name = 'dsh-augmentor'
export const inject = ['tools']

export interface Config {
  /** Exact HTTP handshake route under /api. */
  apiPath: string
  /** Exact WS upgrade route the pipe connects to. */
  wsPath: string
  /** Timeout in milliseconds for one tool round trip through the pipe to the browser. */
  commandTimeoutMs: number
  /**
   * Action-channel token. Empty (default) = fall back to the per-machine
   * secret file $DSH_HOME/augmentor-ws-token (created on first boot).
   */
  wsToken: string
}

export const Config: z<Config> = z.object({
  apiPath: z.string().default('/api/augmentor'),
  wsPath: z.string().default('/api/augmentor/ws'),
  commandTimeoutMs: z.number().default(15000),
  wsToken: z.string().default(''),
})

/** Per-machine action-channel secret: created 0600 on first boot, same path on both sides. */
const TOKEN_FILE_NAME = 'augmentor-ws-token'

function resolveToken(configured: string): { token: string; source: 'config' | 'file' | 'generated' | 'none' } {
  if (configured) return { token: configured, source: 'config' }
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const file = path.join(home, TOKEN_FILE_NAME)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return { token: existing, source: 'file' }
  } catch {
    /* first boot: generate */
  }
  const token = randomBytes(16).toString('hex')
  try {
    writeFileSync(file, token + '\n', { mode: 0o600 })
  } catch {
    /* unresolvable home dir: fall back to an unshared ephemeral token */
  }
  return { token, source: 'generated' }
}

/** Pipe protocol revision; the pipe logs it in its trace for fence-probe evidence. */
const PROTOCOL = 'augmentor-pipe/v1'

/** Bundle version; the pipe logs the plugin-reported one in its trace. */
const VERSION = '0.1.0'

/** One pipe round-trip result. */
interface BrowserRoundTrip {
  ok: boolean
  result?: unknown
  error?: string
}

/** One tab row as the extension reports it. */
interface BrowserTab {
  id: number | null
  url: string | null
  title: string | null
  active: boolean
  focusedWindow: boolean
}

/** Structural view of the host web server; the service lives outside this bundle's dependency graph. */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }): () => void
}

export function apply(ctx: Context, config: Config) {
  const pipes = new Set<WebSocket>()
  const pending = new Map<string, { settle: (value: BrowserRoundTrip) => void }>()
  const wss = new WebSocketServer({ noServer: true })

  function sendToPipes(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame)
    for (const pipe of pipes) {
      if (pipe.readyState === pipe.OPEN) pipe.send(text)
    }
  }

  /** One round trip through the pipe to the browser, or a clean no-client error. */
  function browserRequest(params: Record<string, unknown>, timeoutMs: number): Promise<BrowserRoundTrip> {
    return new Promise((resolve) => {
      if (pipes.size === 0) {
        resolve({ ok: false, error: 'no browser client connected' })
        return
      }
      const id = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ ok: false, error: `browser round trip timed out after ${timeoutMs}ms` })
      }, timeoutMs)
      pending.set(id, {
        settle(value: BrowserRoundTrip) {
          clearTimeout(timer)
          pending.delete(id)
          resolve(value)
        },
      })
      sendToPipes({ type: 'request', id, method: 'browser/execute', params })
    })
  }

  wss.on('connection', (pipe: WebSocket) => {
    pipes.add(pipe)
    pipe.send(JSON.stringify({ type: 'welcome', name: 'dsh-augmentor', protocol: PROTOCOL, version: VERSION }))
    pipe.on('message', (data) => {
      let frame: { type?: string; id?: string; result?: unknown; error?: { message?: string } }
      try {
        frame = JSON.parse(String(data))
      } catch {
        return // non-JSON frames are outside the pipe vocabulary
      }
      if (frame.type !== 'reply' || frame.id === undefined) return
      const waiter = pending.get(frame.id)
      if (!waiter) return // late reply after the timeout already settled the waiter
      if (frame.error) waiter.settle({ ok: false, error: frame.error.message ?? 'browser error' })
      else waiter.settle({ ok: true, result: frame.result })
    })
    const drop = () => pipes.delete(pipe)
    pipe.on('close', drop)
    pipe.on('error', drop)
  })

  const resolved = resolveToken(config.wsToken)
  if (resolved.source === 'none' || !resolved.token) {
    console.warn('[dsh-augmentor] action channel has no token resolvable; running open (dev only)')
  }

  // Action channel registration. On a fresh boot this plugin's apply runs
  // before the web server's fiber has provided its service (fiber activation
  // ordering), so `ctx.get('webServer')` is legitimately undefined at apply
  // time; the service event covers that case. A headless profile never
  // provides webServer, so the channel simply stays off there.
  let currentServer: WebServerLike | undefined
  let routesEffect: { dispose: () => void | Promise<void> } | undefined
  const registerActionChannel = (webServer: WebServerLike) => {
    if (webServer === currentServer) return
    if (routesEffect) routesEffect.dispose() // routes leave with the old server instance
    currentServer = webServer
    // Both disposers run with the plugin fiber (HMR instance replacement or
    // profile teardown), so a re-apply can register again without a
    // duplicate-route collision.
    routesEffect = ctx.effect(() => {
      const disposeRoute = webServer.register({
        kind: 'exact',
        path: config.apiPath,
        handler(req, res) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
            return
          }
          const body = JSON.stringify({
            name: 'dsh-augmentor',
            protocol: PROTOCOL,
            version: VERSION,
            wsPath: config.wsPath,
            wsTokenRequired: Boolean(resolved.token),
            wsTokenSource: resolved.source,
            pipes: pipes.size,
            time: Date.now(),
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(body)
        },
      })
      const disposeUpgrade = webServer.registerUpgrade({
        path: config.wsPath,
        handler(req, socket, head) {
          if (resolved.token) {
            let presented: string | null = null
            try {
              presented = new URL(req.url ?? '', 'http://localhost').searchParams.get('token')
            } catch {
              presented = null
            }
            if (presented !== resolved.token) {
              console.warn('[dsh-augmentor] action channel upgrade rejected (bad or missing token)')
              socket.destroy()
              return
            }
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req)
          })
        },
      })
      return [disposeRoute, disposeUpgrade]
    }, 'dsh-augmentor: action channel routes')
    console.log('[dsh-augmentor] action channel ready (api=%s, ws token: %s)', config.apiPath, resolved.source)
  }

  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer) {
    registerActionChannel(webServer)
  } else {
    console.log('[dsh-augmentor] webServer service not up yet; watching for it (headless profiles never provide it)')
    ctx.on('internal/service', (name: string, value: unknown) => {
      if (name === 'webServer') registerActionChannel(value as WebServerLike)
    })
  }

  ctx.tools.register(defineTool({
    name: 'browser_tabs_list',
    description:
      'List the browser tabs the Augmentor extension can see, through its native pipe. Returns {ok: true, tabs} when a browser client is connected and {ok: false, error} when none is.',
    parameters: {},
    output: {
      schema: {
        // dsh-tools value-schema DSL: object nodes carry no `required`
        // array — a property is required by marking `required: true` inside
        // its own schema, and `additionalProperties` must be explicit.
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                // chrome.tabs reports url/title as null for pending/devtools
                // tabs and id as undefined while a tab is being torn down.
                id: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                url: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                active: { type: 'boolean', required: true },
                focusedWindow: { type: 'boolean', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `${value.tabs.length} tab(s) open in the user's browser` : value.error ?? 'no tabs' },
      ],
    },
    async execute(_args, exec) {
      if (exec.signal.aborted) throw new Error('cancelled')
      const round = await browserRequest({ action: 'tabs_list' }, config.commandTimeoutMs)
      if (!round.ok) return { ok: false, error: round.error }
      const value = round.result as { tabs?: BrowserTab[] } | undefined
      return { ok: true, tabs: value?.tabs ?? [] }
    },
  }))
}
