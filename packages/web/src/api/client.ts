import {
  API_EVENTS_PATH,
  API_RPC_PATH,
  type RpcMethod,
  type RpcParams,
  type RpcResponse,
  type RpcResult,
  type ServerEvent,
} from '@ccw/shared'

/**
 * Shared secret from `?token=` in the page URL, for the non-loopback deployment
 * where the server demands one (see resolveAccessToken). Empty on the loopback
 * default, and then nothing extra is sent.
 */
const accessToken = new URLSearchParams(window.location.search).get('token') ?? ''

/** Typed RPC over `POST /api/rpc`. Rejects on transport and handler errors alike. */
export async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  const response = await fetch(API_RPC_PATH, {
    method: 'POST',
    headers: accessToken
      ? { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` }
      : { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  const body = (await response.json()) as RpcResponse<M>
  if (!body.ok) throw new Error(body.error)
  return body.result
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

/**
 * Downlink-only socket. The browser never writes to it; a drop just means we
 * reconnect and keep listening, so there is no request state to recover.
 */
export function connectEvents(handlers: {
  onEvent: (event: ServerEvent) => void
  onStatus?: (status: ConnectionStatus) => void
}): () => void {
  let socket: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const open = (): void => {
    if (disposed) return
    handlers.onStatus?.('connecting')

    const url = new URL(API_EVENTS_PATH, window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    // A WebSocket handshake cannot carry custom headers, so the token goes in
    // the query string here instead of an Authorization header.
    if (accessToken) url.searchParams.set('token', accessToken)
    socket = new WebSocket(url)

    socket.addEventListener('open', () => handlers.onStatus?.('open'))
    socket.addEventListener('message', (event) => {
      handlers.onEvent(JSON.parse(String(event.data)) as ServerEvent)
    })
    socket.addEventListener('close', () => {
      handlers.onStatus?.('closed')
      if (!disposed) retry = setTimeout(open, 1000)
    })
    socket.addEventListener('error', () => socket?.close())
  }

  open()

  return () => {
    disposed = true
    if (retry) clearTimeout(retry)
    socket?.close()
  }
}
