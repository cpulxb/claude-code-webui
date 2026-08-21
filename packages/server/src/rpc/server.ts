import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { API_EVENTS_PATH, API_RPC_PATH, type RpcMethod, type RpcResponse, type ServerEvent } from '@ccw/shared'
import { WebSocketServer, type WebSocket } from 'ws'

import type { SessionManager } from '../session/manager.ts'
import { createRpcHandlers } from './routes.ts'

const MAX_BODY_BYTES = 32 * 1024 * 1024 // headroom for base64 attachments

export type ServerHandle = { close: () => Promise<void> }

export function startServer(options: { host: string; port: number; manager: SessionManager }): Promise<ServerHandle> {
  const { host, port, manager } = options
  const handlers = createRpcHandlers(manager)

  const http = createServer((req, res) => {
    if (!isLoopbackHost(req.headers.host)) {
      // The server binds loopback only; a non-loopback Host means a DNS
      // rebinding attempt, since a real local client always sends one.
      respond(res, 403, { ok: false, error: 'forbidden host' })
      return
    }
    if (req.method === 'POST' && req.url === API_RPC_PATH) {
      void handleRpc(req, res, handlers)
      return
    }
    respond(res, 404, { ok: false, error: 'not found' })
  })

  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set<WebSocket>()

  http.on('upgrade', (req, socket, head) => {
    if (req.url !== API_EVENTS_PATH || !isLoopbackHost(req.headers.host)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      // Downlink only: anything the browser writes here is ignored by design.
      ws.on('error', () => ws.close())
    })
  })

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
          for (const ws of sockets) ws.terminate()
          manager.closeAll()
          await new Promise<void>((done) => http.close(() => done()))
        },
      })
    })
  })
}

async function handleRpc(req: IncomingMessage, res: ServerResponse, handlers: ReturnType<typeof createRpcHandlers>): Promise<void> {
  let payload: { method?: string; params?: unknown }
  try {
    payload = JSON.parse(await readBody(req)) as typeof payload
  } catch (error) {
    respond(res, 400, { ok: false, error: `bad request body: ${message(error)}` })
    return
  }

  const method = payload.method as RpcMethod | undefined
  if (!method || !(method in handlers)) {
    respond(res, 404, { ok: false, error: `unknown method: ${String(payload.method)}` })
    return
  }

  try {
    // The params type is pinned per method by RpcMap; the wire is untyped, so
    // this one cast is where the two meet.
    const handler = handlers[method] as (params: unknown) => Promise<unknown>
    respond(res, 200, { ok: true, result: await handler(payload.params ?? {}) } as RpcResponse)
  } catch (error) {
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
