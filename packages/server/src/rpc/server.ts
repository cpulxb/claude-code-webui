import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'

import {
  API_AUTH_PATH,
  API_EVENTS_PATH,
  API_RPC_PATH,
  API_TERM_PATH,
  type RpcMethod,
  type RpcResponse,
  type ServerEvent,
} from '@ccw/shared'
import { WebSocketServer, type WebSocket } from 'ws'

import type { AuthGate, Principal } from '../auth/gate.ts'
import { resolveInWorkspace } from '../files/roots.ts'
import { serveStatic } from '../http/static.ts'
import type { SessionManager } from '../session/manager.ts'
import { attachTerminal, resolveShell, terminalSize } from '../terminal/pty.ts'
import { Updater } from '../update/updater.ts'
import { createRpcHandlers } from './routes.ts'

const MAX_BODY_BYTES = 32 * 1024 * 1024 // headroom for base64 attachments
const HEARTBEAT_MS = 30_000
// Well under bin.ts's shutdown grace, so the hard cut still runs before exit.
const DRAIN_MS = 300

export type ServerHandle = { close: () => Promise<void> }

export type TlsOptions = { cert: Buffer; key: Buffer }

export function startServer(options: {
  host: string
  port: number
  manager: SessionManager
  auth: AuthGate
  /** Serve HTTPS directly. Omitted on loopback and behind a TLS-terminating proxy. */
  tls?: TlsOptions
  /** The built UI to serve next to the API; omitted, every non-API path is a 404. */
  webRoot?: string
  /** Release checks; omitted, the server never reports an update. */
  updater?: Updater
}): Promise<ServerHandle> {
  const { host, port, manager, auth, tls, webRoot } = options
  const updater = options.updater ?? Updater.none()
  const handlers = createRpcHandlers(manager, updater)

  const wss = new WebSocketServer({ noServer: true })
  // Event sockets get every broadcast; terminal sockets each carry one PTY and
  // must never see an event. Both are pinged.
  const sockets = new Set<WebSocket>()
  const terminals = new Set<WebSocket>()
  const alive = new Set<WebSocket>()
  // Which paired device opened each socket, so revoking it cuts it off now
  // rather than at its next reconnect.
  const owners = new Map<WebSocket, string>()

  const track = (ws: WebSocket, set: Set<WebSocket>, principal: Principal): void => {
    set.add(ws)
    alive.add(ws)
    if (principal.device) owners.set(ws, principal.device.id)
    ws.on('pong', () => alive.add(ws))
    ws.on('close', () => {
      set.delete(ws)
      alive.delete(ws)
      owners.delete(ws)
    })
    ws.on('error', () => ws.close())
  }

  const disconnectDevice = (deviceId: string): void => {
    for (const [ws, owner] of owners) {
      if (owner === deviceId) ws.close(1008, 'device revoked')
    }
  }

  const onRequest: RequestListener = (req, res) => {
    setSecurityHeaders(res, tls !== undefined)
    const path = pathOf(req.url)
    if (path !== '/api' && !path.startsWith('/api/')) {
      if (!webRoot) {
        respond(res, 404, { ok: false, error: 'not found' })
        return
      }
      void serveStatic(req, res, webRoot).catch((error) => {
        console.error('[ccw] static file failed', error)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
      return
    }

    res.setHeader('cache-control', 'no-store')
    if (crossSite(req)) {
      respond(res, 403, { ok: false, error: 'forbidden origin' })
      return
    }
    // Another site can POST text/plain here without a CORS preflight and
    // without reading the answer — enough to act through the loopback
    // exemption. A JSON content type forces the preflight, which fails.
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) {
      respond(res, 415, { ok: false, error: 'content-type must be application/json' })
      return
    }
    const principal = auth.identify(req)
    if (path === API_AUTH_PATH || path.startsWith(`${API_AUTH_PATH}/`)) {
      void auth
        .handle(req, res, principal, disconnectDevice)
        .then((handled) => {
          if (!handled) respond(res, 404, { ok: false, error: 'not found' })
        })
        .catch((error) => {
          console.error('[ccw] auth route failed', error)
          if (!res.headersSent) respond(res, 500, { ok: false, error: message(error) })
          else res.end()
        })
      return
    }
    if (!principal) {
      respond(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    if (req.method === 'POST' && path === API_RPC_PATH) {
      void handleRpc(req, res, handlers).catch((error) => {
        console.error('[ccw] rpc dispatch failed', error)
        if (!res.headersSent) respond(res, 500, { ok: false, error: message(error) })
        else res.end()
      })
      return
    }
    respond(res, 404, { ok: false, error: 'not found' })
  }

  const http = tls ? createHttpsServer(tls, onRequest) : createHttpServer(onRequest)

  const upgradeTerminal = async (req: IncomingMessage, socket: Duplex, head: Buffer, principal: Principal): Promise<void> => {
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
      track(ws, terminals, principal)
      attachTerminal(ws, { shell, cwd, cols: terminalSize(query?.get('cols')), rows: terminalSize(query?.get('rows')) })
    })
  }

  http.on('upgrade', (req, socket, head) => {
    const path = pathOf(req.url)
    const principal = (path === API_EVENTS_PATH || path === API_TERM_PATH) && !crossSite(req) ? auth.identify(req) : null
    if (!principal) {
      socket.destroy()
      return
    }
    if (path === API_TERM_PATH) {
      if (!sameOrigin(req)) {
        socket.destroy()
        return
      }
      void upgradeTerminal(req, socket, head, principal).catch((error) => {
        console.error('[ccw] terminal upgrade failed', error)
        socket.destroy()
      })
      return
    }
    // Every conversation streams through here, so another site's page must not
    // read it via the loopback exemption either. A browser always sends Origin;
    // a script with none (the smoke test) cannot be steered by a web page.
    if (req.headers.origin !== undefined && !sameOrigin(req)) {
      socket.destroy()
      return
    }
    // Downlink only: anything the browser writes here is ignored by design.
    wss.handleUpgrade(req, socket, head, (ws) => track(ws, sockets, principal))
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

  const broadcast = (event: ServerEvent): void => {
    const frame = JSON.stringify(event)
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(frame)
    }
  }
  const unsubscribe = manager.subscribe(broadcast)
  const unsubscribeUpdates = updater.subscribe((status) => broadcast({ type: 'update_status', status }))

  return new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, host, () => {
      http.removeListener('error', reject)
      resolve({
        close: async () => {
          unsubscribe()
          unsubscribeUpdates()
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

/**
 * Best-effort defence in depth, not a guarantee: clients that omit
 * Sec-Fetch-Site (curl, pre-16.4 Safari, some WebSocket handshakes) pass, so
 * this only catches browsers that do send it. `same-site` is rejected too,
 * which would 403 a sibling subdomain — harmless while the UI is served from
 * the same origin as the API. Only `/api` is checked: a link to the UI from
 * another site is an ordinary navigation and must load.
 */
function crossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'cross-site' || site === 'same-site'
}

/**
 * A WebSocket handshake is exempt from CORS, so through the loopback exemption
 * any page the user visits could otherwise open a shell here — and
 * crossSite's check is best-effort only. Browsers always send Origin on a
 * handshake and page scripts cannot set it, so requiring it to name the very
 * host the request was sent to keeps terminals to the UI's own origin. A
 * reverse proxy in front must therefore pass Host through unchanged.
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

/**
 * On every response, files and API alike. HSTS only when this process holds
 * the certificate: behind a proxy, the proxy owns that decision, and browsers
 * ignore it over a connection with certificate errors anyway.
 */
function setSecurityHeaders(res: ServerResponse, tls: boolean): void {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  // Nothing here is meant to be framed — a framed UI is a clickjacked
  // permission prompt.
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('content-security-policy', "frame-ancestors 'none'")
  if (tls) res.setHeader('strict-transport-security', 'max-age=15552000')
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
