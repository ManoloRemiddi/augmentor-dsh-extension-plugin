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
 *   GET <apiPath>   handshake JSON: {name, protocol, version, wsPath, pipes,
 *                   chatCwd, agentPreset, saved, time}
 *   WS  <wsPath>    pipe channel (token-gated, see below); frame vocabulary below
 *   tools browser_tabs_list / browser_navigate / browser_snapshot /
 *         browser_click / browser_type (the M2 browser tool set)
 *
 * M3 chat lifecycle (proposal §5): the extension's chats live as real DSH
 * sessions with cwd pinned to the dedicated directory (config.chatDir,
 * default ~/Augmentor — created at boot). Save = idempotent
 * workspaceRegistry.create(chatDir) + attachSession; Unsave = detachSession.
 * A housekeeping sweep (boot + interval) archives extension sessions older
 * than retentionDays that no workspace attaches; with deleteAfterDays > 0 it
 * also deletes their raw artifacts (off by default).
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
 *                   {type: 'request', id, method: 'augmentor/save'|'augmentor/unsave'|
 *                                        'augmentor/state', params}
 *   plugin → pipe: {type: 'welcome', name, version}
 *                  {type: 'reply', id, result}
 *                  {type: 'reply', id, error: {message}}
 * browser/execute requests are broadcast to every connected pipe; the first
 * reply settles the waiter, later replies are dropped as late. augmentor/*
 * requests are answered by the plugin itself (no browser involved).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

export const name = 'dsh-augmentor'
// 'workspaceRegistry' and 'sessionPersistence' are declared so the loader
// starts them (and their own dependencies) before this plugin's apply runs —
// the M3 save/housekeeping paths touch them synchronously at request time,
// and the registry's startup table must be warm by then.
export const inject = ['tools', 'workspaceRegistry', 'sessionPersistence']

export interface Config {
  /** Exact HTTP handshake route under /api. */
  apiPath: string
  /** Exact WS upgrade route the pipe connects to. */
  wsPath: string
  /** Timeout in milliseconds for one tool round trip through the pipe to the browser (the navigate action may wait up to ~20s for the page load). */
  commandTimeoutMs: number
  /**
   * Action-channel token. Empty (default) = fall back to the per-machine
   * secret file $DSH_HOME/augmentor-ws-token (created on first boot).
   */
  wsToken: string
  /**
   * Dedicated directory for Augmentor chats (proposal §5.1–§5.2). Every
   * extension session is created with cwd = this directory so Save can
   * attach it to the workspace over it. `~` expands to the user's home.
   * Created (mkdir -p) and canonicalized (realpath) at boot; a directory
   * that cannot be prepared fails the plugin loudly.
   */
  chatDir: string
  /**
   * Agent preset the extension sessions are created with (session.create
   * meta `agentPreset`). Carries the Augmentor persona — the
   * browser-control identity the old bridge passed as DSH_SYSTEM_PROMPT,
   * ported to the five browser_* tools — shipped as the user preset
   * $DSH_HOME/.agent-presets/augmentor (source: augmentor/presets/augmentor).
   * The SW passes it only when the handshake carries one, so a roster
   * without the preset degrades to the deployment default instead of
   * failing session.create.
   */
  agentPreset: string
  /** Title of the workspace the Save button attaches chats to. */
  workspaceTitle: string
  /**
   * Housekeeping sweep: extension sessions in chatDir that no workspace
   * attaches and that are older than this many days get archived.
   */
  retentionDays: number
  /**
   * Housekeeping sweep: archived extension sessions older than this many
   * days also have their raw session artifacts deleted. 0 (default) =
   * never delete — archiving only, as decided in proposal §5.4.
   */
  deleteAfterDays: number
  /** Interval between housekeeping sweeps, milliseconds. */
  sweepEveryMs: number
  /** Delay after boot before the first housekeeping sweep, milliseconds. */
  sweepFirstDelayMs: number
}

export const Config: z<Config> = z.object({
  apiPath: z.string().default('/api/augmentor'),
  wsPath: z.string().default('/api/augmentor/ws'),
  commandTimeoutMs: z.number().default(30000),
  wsToken: z.string().default(''),
  chatDir: z.string().default('~/Augmentor'),
  agentPreset: z.string().default('augmentor'),
  workspaceTitle: z.string().default('Augmentor Chat'),
  retentionDays: z.number().default(14),
  deleteAfterDays: z.number().default(0),
  sweepEveryMs: z.number().default(60 * 60 * 1000),
  sweepFirstDelayMs: z.number().default(60 * 1000),
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
// F7 (audit): read from the package's own manifest (single source of truth)
// instead of hand-duplicating. The file ships with the bundle both from the
// source mount (M1) and from npm (M4). import.meta.url may carry the
// home-patch `?src=…` freshness query — clear it before resolving.
function packageVersion(): string {
  try {
    const here = new URL(import.meta.url)
    here.search = ''
    const p = JSON.parse(readFileSync(new URL('../package.json', here), 'utf8'))
    return typeof p.version === 'string' && p.version ? p.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
const VERSION = packageVersion()

/** S9 (audit): constant-time token comparison (digests: equal length, and
 * the result does not reveal where the mismatch occurred). */
function tokenEquals(presented: string | null, expected: string): boolean {
  if (presented == null || presented === '') return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

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

/** One navigate round trip as the extension reports it. */
interface BrowserNavigateResult {
  tabId?: number
  url?: string
  title?: string | null
  newTab?: boolean
}

/** One snapshot round trip as the extension reports it. */
interface BrowserSnapshotResult {
  title?: string
  url?: string
  text?: string
  links?: { text: string; href: string }[]
}

/** One click/type round trip as the extension reports it (action-level ok). */
interface BrowserElementResult {
  ok?: boolean
  error?: string
  tag?: string
  text?: string
  name?: string
}

/** Structural view of the host web server; the service lives outside this bundle's dependency graph. */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }): () => void
}

// Structural views of two host services used by the M3 chat lifecycle. The
// plugin is a third-party bundle (main: src/index.ts, no @deepseek-ai/dsh-*
// workspace dependency), so it sees them through plain shapes and a
// runtime `ctx.get` lookup — the loader's inject declaration above still
// guarantees they are started first.

/** One workspace row, as the M3 paths need it (workspace/workspace/src/entity.ts). */
interface WorkspaceLike {
  id: string
  title: string
  path: string
  /** Session ids attached to this workspace (cwd-index filtered, newest first). */
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
  detachSession(sessionId: string): Promise<void>
}

/** The workspace registry surface the plugin drives (index.ts). */
interface WorkspaceRegistryLike {
  /** Idempotent per canonical path; rejects if the directory does not exist. */
  create(path: string, title?: string): Promise<WorkspaceLike>
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  list(): WorkspaceLike[]
  archiveSession(sessionId: string): Promise<void>
  readonly archivedSessionIds: readonly string[]
}

/** One session header row (core/session SessionHeader, persistence list shape). */
interface SessionHeaderLike {
  id: string
  /** Absolute cwd the session was created in (may be undefined). */
  cwd?: string
  /** Epoch ms. */
  createdAt: number
}

/** The session persistence surface the sweep needs (session-persistence). */
interface SessionPersistenceLike {
  list(): Promise<readonly SessionHeaderLike[]>
  /** Absolute path of the raw artifact for a header, or undefined when the backend keeps nothing deletable. */
  locate(meta: SessionHeaderLike): { path: string } | undefined
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

  // ----------------------------------------------------- M3 chat lifecycle
  // The extension's chats are real DSH sessions with cwd pinned to a
  // dedicated directory. Save attaches the session to the workspace over
  // that directory; the sweep archives stale ones no workspace claims.

  /**
   * Prepare the chat directory: expand ~, mkdir -p, canonicalize. A
   * directory that cannot be prepared is a misconfiguration — fail the
   * plugin loudly (docs/user/develop/basic/config.md: "Fail loudly on
   * invalid configuration").
   */
  const chatDirRaw = config.chatDir.startsWith('~/')
    ? path.join(os.homedir(), config.chatDir.slice(2))
    : config.chatDir
  let chatDir: string
  try {
    mkdirSync(chatDirRaw, { recursive: true })
    chatDir = realpathSync(chatDirRaw)
  } catch (e) {
    throw new Error(`dsh-augmentor: cannot prepare chat dir ${config.chatDir} (${(e as Error).message})`)
  }
  console.log('[dsh-augmentor] chat dir ready: %s (workspace: %s)', chatDir, config.workspaceTitle)

  // Declared in inject, so both services are started before apply runs.
  const registry = ctx.get('workspaceRegistry') as unknown as WorkspaceRegistryLike
  const persistence = ctx.get('sessionPersistence') as unknown as SessionPersistenceLike

  /** The workspace the Save button attaches chats to; created idempotently on demand. */
  const ensureWorkspace = () => registry.create(chatDir, config.workspaceTitle)
  /** The existing workspace over the chat dir, if any (resolveByPath is async). */
  const chatWorkspace = () => registry.resolveByPath(chatDir)

  /** Answer the extension's lifecycle requests that ride in as pipe frames. */
  async function handlePipeRequest(frame: { id: string; method: string; params?: Record<string, unknown> }): Promise<void> {
    const id = frame.id
    const reply = (out: Record<string, unknown>) => sendToPipes({ type: 'reply', id, result: out })
    try {
      const sessionId = String(frame.params?.sessionId ?? '')
      if (frame.method === 'augmentor/save') {
        if (!sessionId) throw new Error('save: missing sessionId')
        const ws = await ensureWorkspace()
        await ws.attachSession(sessionId) // validates the session's cwd header against chatDir
        reply({ ok: true, saved: true, sessionId, workspace: { id: ws.id, title: ws.title, path: ws.path } })
      } else if (frame.method === 'augmentor/unsave') {
        if (!sessionId) throw new Error('unsave: missing sessionId')
        const ws = await chatWorkspace()
        if (ws) await ws.detachSession(sessionId) // idempotent
        reply({ ok: true, saved: false, sessionId, workspace: ws ? { id: ws.id, title: ws.title, path: ws.path } : null })
      } else if (frame.method === 'augmentor/state') {
        const ws = await chatWorkspace()
        reply({ ok: true, saved: [...(ws?.sessionIds ?? [])], archived: [...registry.archivedSessionIds] })
      } else {
        reply({ ok: false, error: `unknown augmentor method: ${frame.method}` })
      }
    } catch (e) {
      const message = (e as Error).message ?? String(e)
      // attachSession throws when the session's cwd header is not chatDir —
      // that happens for chats created before the cwd pinning existed.
      const friendly = /cwd/i.test(message)
        ? `${message} — this chat was created outside ${chatDir}; start a new chat to save it`
        : message
      reply({ ok: false, error: friendly })
    }
  }

  // ------------------------------------------------------ housekeeping
  const DAY_MS = 24 * 60 * 60 * 1000
  async function sweep(): Promise<void> {
    try {
      const headers = await persistence.list()
      const archived = new Set<string>(registry.archivedSessionIds)
      const claimed = new Set<string>()
      for (const ws of registry.list()) for (const sid of ws.sessionIds) claimed.add(sid)
      const now = Date.now()
      const retentionMs = config.retentionDays * DAY_MS
      const deleteMs = config.deleteAfterDays > 0 ? config.deleteAfterDays * DAY_MS : Infinity
      let archivedNow = 0
      let deleted = 0
      for (const h of headers) {
        if (typeof h.cwd !== 'string') continue
        let canon: string
        try {
          canon = realpathSync(h.cwd)
        } catch {
          continue // header cwd vanished from disk: nothing to claim, leave it
        }
        if (canon !== chatDir) continue // only extension chats live here
        if (archived.has(h.id) || claimed.has(h.id)) continue
        if (now - h.createdAt < retentionMs) continue
        await registry.archiveSession(h.id)
        archivedNow++
        if (now - h.createdAt > deleteMs) {
          const loc = persistence.locate(h)
          if (loc) {
            try {
              rmSync(loc.path, { recursive: true, force: true })
              deleted++
            } catch (e) {
              console.warn('[dsh-augmentor] housekeeping: could not delete artifact for %s (%s)', h.id, (e as Error).message)
            }
          }
        }
      }
      if (archivedNow || deleted) console.log('[dsh-augmentor] housekeeping sweep: archived %d, deleted %d', archivedNow, deleted)
    } catch (e) {
      // The sweep is best-effort housekeeping; one failed pass logs and the
      // next interval retries. A throw here must never kill the plugin.
      console.warn('[dsh-augmentor] housekeeping sweep failed: %s', (e as Error).message)
    }
  }
  {
    // Boot + interval timers. ctx.effect(setup) runs setup NOW and disposes
    // whatever it RETURNS with the plugin fiber (HMR replacement or profile
    // teardown) — so the cleanup must be the returned function, exactly like
    // the action-channel route disposers below. A replaced instance therefore
    // never keeps sweeping.
    let interval: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(() => {
      void sweep()
      interval = setInterval(() => void sweep(), config.sweepEveryMs)
    }, config.sweepFirstDelayMs)
    ctx.effect(() => () => {
      clearTimeout(first)
      if (interval) clearInterval(interval)
    }, 'dsh-augmentor: housekeeping sweep')
  }

  wss.on('connection', (pipe: WebSocket) => {
    pipes.add(pipe)
    pipe.send(JSON.stringify({ type: 'welcome', name: 'dsh-augmentor', protocol: PROTOCOL, version: VERSION }))
    pipe.on('message', (data) => {
      let frame: { type?: string; id?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
      try {
        frame = JSON.parse(String(data))
      } catch {
        return // non-JSON frames are outside the pipe vocabulary
      }
      if (frame.type === 'request' && frame.id !== undefined && frame.method) {
        // The extension's lifecycle requests (save/unsave/state) arrive as
        // forwarded pipe frames; the plugin answers them itself.
        void handlePipeRequest(frame)
        return
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
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
            return
          }
          // The handshake carries the chat-lifecycle state: the pipe folds
          // it into its `initialize` result so the extension learns the
          // pinned cwd and which chats are already saved. resolveByPath
          // reads the registry's startup table — try-guarded so a not-yet
          // warm registry degrades to an empty saved list instead of 500s.
          let saved: string[] = []
          try {
            saved = [...((await registry.resolveByPath(chatDir))?.sessionIds ?? [])]
          } catch {
            /* registry table not warm yet */
          }
          const body = JSON.stringify({
            name: 'dsh-augmentor',
            protocol: PROTOCOL,
            version: VERSION,
            wsPath: config.wsPath,
            wsTokenRequired: Boolean(resolved.token),
            wsTokenSource: resolved.source,
            chatCwd: chatDir,
            agentPreset: config.agentPreset,
            saved,
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
            // S7 (audit): prefer the handshake header — a query token lands
            // in any request log the DSH app keeps. The query stays as a
            // legacy fallback so an older pipe (which only sends ?token=)
            // keeps working during a mixed upgrade.
            let presented: string | null =
              (req.headers['x-augmentor-token'] as string | undefined) ?? null
            if (presented == null) {
              try {
                presented = new URL(req.url ?? '', 'http://localhost').searchParams.get('token')
              } catch {
                presented = null
              }
            }
            if (!tokenEquals(presented, resolved.token)) {
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
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: value.error ?? 'no tabs' }]
        if (!value.tabs.length) return [{ type: 'text', text: '0 tabs open in the user\'s browser' }]
        return [{ type: 'text', text: value.tabs.map((t) => `tab ${t.id ?? '?'}${t.active ? ' [active]' : ''}${t.focusedWindow ? ' [focused window]' : ''}: ${t.title ?? '(untitled)'} — ${t.url ?? '(no url yet)'}`).join('\n') }]
      },
    },
    async execute(_args, exec) {
      if (exec.signal.aborted) throw new Error('cancelled')
      const round = await browserRequest({ action: 'tabs_list' }, config.commandTimeoutMs)
      if (!round.ok) return { ok: false, error: round.error }
      const value = round.result as { tabs?: BrowserTab[] } | undefined
      return { ok: true, tabs: value?.tabs ?? [] }
    },
  }))

  /**
   * The M2 browser tool set (proposal line 272): everything acts on the
   * extension's STICKY WORK TAB — the tab the agent is working in (the
   * focused tab of the user's last-focused window unless a navigate created
   * a dedicated one). Each action round-trips plugin -> pipe -> extension
   * action WS -> real tab, and the extension raises the frost veil on the
   * acted-upon tab while it runs, so the user always sees what is happening
   * and where.
   */
  const act = (params: Record<string, unknown>) => browserRequest(params, config.commandTimeoutMs)

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description:
      'Open an http(s) URL in the user\'s real browser. It navigates the agent\'s current work tab (creating a dedicated tab if there is no workable one) and a frost veil with progress is shown on that tab while it runs. Returns the settled URL and page title. Prefer this over any other way of reaching a page, then use browser_snapshot to read what loaded.',
    parameters: {
      url: { type: 'string', required: true, description: 'The http or https URL to open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string' },
          title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          newTab: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `Opened ${value.url ?? 'a page'}${value.title ? ` \u2014 \u201C${value.title}\u201D` : ''}${value.newTab ? ' (new tab)' : ''}` : `navigate failed: ${value.error ?? 'unknown error'}` },
      ],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('cancelled')
      const round = await act({ action: 'navigate', url: args.url })
      if (!round.ok) return { ok: false, error: round.error }
      const value = round.result as BrowserNavigateResult | undefined
      return { ok: true, url: value?.url ?? String(args.url), title: value?.title ?? null, newTab: Boolean(value?.newTab) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description:
      'Read the agent\'s current work tab in the user\'s browser: page title, URL, visible text (up to 6000 characters) and the first 40 links. This is how you see a page after browser_navigate and before browser_click / browser_type. Fails when the work tab is not a readable http(s) page (e.g. the new-tab page).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          title: { type: 'string' },
          url: { type: 'string' },
          text: { type: 'string' },
          links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                href: { type: 'string', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `snapshot failed: ${value.error ?? 'unknown error'}` }]
        const parts = [`Page: ${value.title}`, `URL: ${value.url}`, '', value.text || '(no visible text)']
        if (value.links?.length) {
          parts.push('', `Links (${value.links.length}):`)
          for (const l of value.links) parts.push(`- [${l.text}](${l.href})`)
        }
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(_args, exec) {
      if (exec.signal.aborted) throw new Error('cancelled')
      const round = await act({ action: 'snapshot' })
      if (!round.ok) return { ok: false, error: round.error }
      const value = round.result as BrowserSnapshotResult | undefined
      return { ok: true, title: value?.title ?? '', url: value?.url ?? '', text: value?.text ?? '', links: value?.links ?? [] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description:
      'Click an element in the agent\'s current work tab in the user\'s browser, identified by a CSS selector. The element pulses visibly in the user\'s accent color, so the user sees exactly where the click lands. Use browser_snapshot first to choose a selector from the visible page. Returns the clicked element\'s tag and a human-readable name, or an error when no element matches the selector.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the element to click, e.g. "#save" or "button.login".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tag: { type: 'string' },
          text: { type: 'string' },
          name: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `Clicked ${value.name ?? value.tag ?? 'an element'}${value.text ? ` \u201C${value.text}\u201D` : ''}` : `click failed: ${value.error ?? 'unknown error'}` },
      ],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('cancelled')
      const round = await act({ action: 'click', selector: args.selector })
      if (!round.ok) return { ok: false, error: round.error }
      const value = round.result as BrowserElementResult | undefined
      if (value?.ok === false) return { ok: false, error: value.error ?? 'no element matched the selector' }
      return { ok: true, tag: value?.tag ?? '', text: value?.text ?? '', name: value?.name ?? '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description:
      'Type text into an element (input, textarea, or contenteditable) in the agent\'s current work tab in the user\'s browser, identified by a CSS selector. Replaces any existing value and dispatches input + change events so page scripts react. The element pulses visibly, so the user sees where the text lands. Returns the element\'s tag and a human-readable name, or an error when no element matches the selector.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the element to type into, e.g. "#search" or "input[name=email]".' },
      text: { type: 'string', required: true, description: 'The text to type (replaces the element\'s current value).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tag: { type: 'string' },
          name: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `Typed into ${value.name ?? value.tag ?? 'an element'}` : `type failed: ${value.error ?? 'unknown error'}` },
      ],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('cancelled')
      const round = await act({ action: 'type', selector: args.selector, text: args.text })
      if (!round.ok) return { ok: false, error: round.error }
      const value = round.result as BrowserElementResult | undefined
      if (value?.ok === false) return { ok: false, error: value.error ?? 'no element matched the selector' }
      return { ok: true, tag: value?.tag ?? '', name: value?.name ?? '' }
    },
  }))
}
