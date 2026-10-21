import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  API_EVENTS_PATH,
  API_RPC_PATH,
  API_TERM_PATH,
  type RpcMethod,
  type RpcResponse,
  type ServerEvent,
} from '@ccw/shared'
import { WebSocketServer, type WebSocket } from 'ws'

import { resolveInWorkspace } from '../files/roots.ts'
import type { SessionManager } from '../session/manager.ts'
import { attachTerminal, resolveShell, terminalSize } from '../terminal/pty.ts'
import { createRpcHandlers } from './routes.ts'

const MAX_BODY_BYTES = 32 * 1024 * 1024 // headroom for base64 attachments
const HEARTBEAT_MS = 30_000
// Well under bin.ts's shutdown grace, so the hard cut still runs before exit.
const DRAIN_MS = 300

export type ServerHandle = { close: () => Promise<void> }

export function startServer(options: { host: string; port: number; manager: SessionManager; token?: string }): Promise<ServerHandle> {
  const { host, port, manager, token } = options
  const handlers = createRpcHandlers(manager)

  const http = createServer((req, res) => {
    const denied = denyReason(req, token)
    if (denied) {
      respond(res, 403, { ok: false, error: denied })
      return
    }
    if (req.method === 'POST' && pathOf(req.url) === API_RPC_PATH) {
      void handleRpc(req, res, handlers).catch((error) => {
        console.error('[ccw] rpc dispatch failed', error)
        if (!res.headersSent) respond(res, 500, { ok: false, error: message(error) })
        else res.end()
      })
      return
    }
    respond(res, 404, { ok: false, error: 'not found' })
  })

  const wss = new WebSocketServer({ noServer: true })
  // Event sockets get every broadcast; terminal sockets each carry one PTY and
  // must never see an event. Both are pinged.
  const sockets = new Set<WebSocket>()
  const terminals = new Set<WebSocket>()
  const alive = new Set<WebSocket>()

  const track = (ws: WebSocket, set: Set<WebSocket>): void => {
    set.add(ws)
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
    ws.on('close', () => {
      set.delete(ws)
      alive.delete(ws)
    })
    ws.on('error', () => ws.close())
  }

  const upgradeTerminal = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const query = parseTarget(req.url)?.searchParams
    const shell = await resolveShell()
    // Same containment as the file RPCs: a shell only opens inside a known
    // workspace, and the error stays vague for the same reason. A missing cwd
    // must not fall through to `resolve('')`, which is this process's own.
    const requested = query?.get('cwd')
    const cwd = requested ? await resolveInWorkspace(requested).catch(() => null) : null
    if (cwd === null) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      track(ws, terminals)
      attachTerminal(ws, { shell, cwd, cols: terminalSize(query?.get('cols')), rows: terminalSize(query?.get('rows')) })
    })
  }

  http.on('upgrade', (req, socket, head) => {
    const path = pathOf(req.url)
    if ((path !== API_EVENTS_PATH && path !== API_TERM_PATH) || denyReason(req, token)) {
      socket.destroy()
      return
    }
    if (path === API_TERM_PATH) {
      if (!sameOrigin(req)) {
        socket.destroy()
        return
      }
      void upgradeTerminal(req, socket, head).catch((error) => {
        console.error('[ccw] terminal upgrade failed', error)
        socket.destroy()
      })
      return
    }
    // Downlink only: anything the browser writes here is ignored by design.
    wss.handleUpgrade(req, socket, head, (ws) => track(ws, sockets))
  })

  // A socket whose peer vanished stays OPEN for minutes; ping/pong evicts it so
  // events are not written into a dead pipe, and a terminal's shell does not
  // outlive the tab that was driving it.
  const heartbeat = setInterval(() => {
    for (const ws of [...sockets, ...terminals]) {
      if (!alive.delete(ws)) {
        ws.terminate()
        continue
      }
      ws.ping()
    }
  }, HEARTBEAT_MS)

  const unsubscribe = manager.subscribe((event: ServerEvent) => {
    const frame = JSON.stringify(event)
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(frame)
    }
  })

  return new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, host, () => {
      http.removeListener('error', reject)
      resolve({
        close: async () => {
          unsubscribe()
          clearInterval(heartbeat)
          for (const ws of sockets) ws.terminate()
          // Each terminal socket's close handler kills its shell.
          for (const ws of terminals) ws.terminate()
          manager.closeAll()
          // close() alone waits forever on a half-dead or headerless
          // connection, since Node tears down its idle sweeper on preclose.
          // Drop idle sockets first so a request already in flight gets this
          // short window to finish writing before the hard cut.
          http.closeIdleConnections()
          const closed = new Promise<void>((done) => http.close(() => done()))
          const cutoff = setTimeout(() => http.closeAllConnections(), DRAIN_MS)
          await closed
          clearTimeout(cutoff)
        },
      })
    })
  })
}

/** Non-empty string when the request must be rejected. */
function denyReason(req: IncomingMessage, token: string | undefined): string | null {
  // Only meaningful on the loopback default: there the server binds loopback
  // only, so a non-loopback Host means a DNS rebinding attempt because a real
  // local client always sends one. A token is issued precisely when the bind is
  // *not* loopback (see resolveAccessToken), and then legitimate requests carry
  // the real hostname; the token, not the forgeable header, is the gate.
  if (!token && !isLoopbackHost(req.headers.host)) {
    return 'forbidden host'
  }
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site' || site === 'same-site') {
    // Best-effort defence in depth, not a guarantee: clients that omit the
    // header (curl, pre-16.4 Safari, some WebSocket handshakes) are allowed
    // through, so this only catches browsers that do send it. `same-site` is
    // rejected too, which would 403 a sibling subdomain — harmless while the UI
    // is served from the same origin as the API, worth revisiting if it is not.
    return 'forbidden origin'
  }
  if (token && !hasToken(req, token)) return 'unauthorized'
  return null
}

/**
 * A WebSocket handshake is exempt from CORS, so on the token-less loopback
 * default any page the user visits could otherwise open a shell here — and
 * denyReason's Sec-Fetch-Site check is best-effort only. Browsers always send
 * Origin on a handshake and page scripts cannot set it, so requiring it to
 * name the very host the request was sent to keeps terminals to the UI's own
 * origin. A reverse proxy in front must therefore pass Host through unchanged.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin || !req.headers.host) return false
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function hasToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  // Browsers cannot set headers on a WebSocket handshake, hence the query form.
  const query = parseTarget(req.url)?.searchParams.get('token') ?? undefined
  return matches(bearer, token) || matches(query, token)
}

function matches(candidate: string | undefined, token: string): boolean {
  if (!candidate) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Request path, or '' — which matches no route — when the target is unparseable. */
function pathOf(url: string | undefined): string {
  return parseTarget(url)?.pathname ?? ''
}

/**
 * Node's HTTP parser forwards request-targets that WHATWG URL rejects, such as
 * a hand-written `POST http://[::1/x`. Every caller runs inside a synchronous
 * request or upgrade callback, where a throw becomes an uncaughtException and
 * bin.ts exits the process, so a parse failure returns null instead.
 */
function parseTarget(url: string | undefined): URL | null {
  try {
    return new URL(url ?? '/', 'http://localhost')
  } catch {
    return null
  }
}

async function handleRpc(req: IncomingMessage, res: ServerResponse, handlers: ReturnType<typeof createRpcHandlers>): Promise<void> {
  let payload: { method?: string; params?: unknown }
  try {
    const parsed = JSON.parse(await readBody(req)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object')
    payload = parsed as typeof payload
  } catch (error) {
    respond(res, 400, { ok: false, error: `bad request body: ${message(error)}` })
    return
  }

  const method = payload.method as RpcMethod | undefined
  // hasOwn, not `in`: `in` walks the prototype chain, so "constructor" or
  // "toString" would pass as methods and get called as handlers.
  const handler = method && Object.hasOwn(handlers, method) ? (handlers[method] as unknown) : undefined
  if (typeof handler !== 'function') {
    respond(res, 404, { ok: false, error: `unknown method: ${String(payload.method)}` })
    return
  }

  try {
    // The params type is pinned per method by RpcMap; the wire is untyped, so
    // this one cast is where the two meet.
    const invoke = handler as (params: unknown) => Promise<unknown>
    respond(res, 200, { ok: true, result: await invoke(payload.params ?? {}) } as RpcResponse)
  } catch (error) {
    console.error(`[ccw] rpc ${method} failed`, error)
    respond(res, 200, { ok: false, error: message(error) })
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function respond(res: ServerResponse, status: number, body: RpcResponse): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) })
  res.end(json)
}

function isLoopbackHost(header: string | undefined): boolean {
  if (!header) return false
  try {
    const { hostname } = new URL(`http://${header}`)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
