import {
  API_AUTH_PATH,
  API_DEVICES_PATH,
  API_EVENTS_PATH,
  API_FILES_UPLOAD_PATH,
  API_PAIR_PATH,
  API_PAIRING_CODE_PATH,
  API_REVOKE_PATH,
  API_RPC_PATH,
  API_TERM_PATH,
  type AuthStatus,
  type DeviceInfo,
  type PairingCode,
  type RpcFailure,
  type RpcMethod,
  type RpcParams,
  type RpcResponse,
  type RpcResult,
  type ServerEvent,
} from '@ccw/shared'

// Credentials need no handling here: off this machine the server pairs the
// browser through an HttpOnly cookie, which same-origin fetches and WebSocket
// handshakes carry on their own.

const UNAUTHORIZED = 'ccw:unauthorized'

/** Fires when the server stops accepting this browser — a revoked or expired device. */
export function onUnauthorized(listener: () => void): () => void {
  window.addEventListener(UNAUTHORIZED, listener)
  return () => window.removeEventListener(UNAUTHORIZED, listener)
}

function notifyUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED))
}

/** Typed RPC over `POST /api/rpc`. Rejects on transport and handler errors alike. */
export async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  const response = await fetch(API_RPC_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  if (response.status === 401) notifyUnauthorized()
  const body = (await response.json()) as RpcResponse<M>
  if (!body.ok) throw new Error(body.error)
  return body.result
}

export type UploadRequest = {
  cwd: string
  file: File
  signal: AbortSignal
  /** Bytes sent, not a simulated timer; completion still waits for server validation. */
  onProgress?: (loaded: number) => void
}

/** Raw bytes avoid base64 inflation; XHR exposes upload progress and real cancellation. */
export function uploadFile({ cwd, file, signal, onProgress }: UploadRequest): Promise<RpcResult<'files.upload'>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('上传已取消', 'AbortError'))
      return
    }
    const xhr = new XMLHttpRequest()
    const url = new URL(API_FILES_UPLOAD_PATH, window.location.href)
    url.searchParams.set('cwd', cwd)
    url.searchParams.set('filename', file.name)
    const abort = (): void => xhr.abort()
    const finish = (result: RpcResult<'files.upload'> | Error): void => {
      signal.removeEventListener('abort', abort)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    xhr.open('POST', url.toString())
    xhr.responseType = 'json'
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => onProgress?.(Math.min(file.size, event.loaded))
    // Even when a browser omits its last progress event, distinguish "sent"
    // from "accepted": only the JSON response below marks the file ready.
    xhr.upload.onload = () => onProgress?.(file.size)
    xhr.onload = () => {
      if (xhr.status === 401) notifyUnauthorized()
      const body = xhr.response as RpcResponse<'files.upload'> | null
      if (
        xhr.status >= 200 && xhr.status < 300 && body?.ok &&
        typeof body.result?.path === 'string' && typeof body.result.size === 'number'
      ) {
        finish(body.result)
      } else {
        const fallback = xhr.status === 413
          ? '文件过大，服务器或反向代理拒绝了上传'
          : `上传失败（HTTP ${xhr.status}），请检查网络或服务器配置`
        finish(new Error(body && !body.ok && typeof body.error === 'string' ? body.error : fallback))
      }
    }
    xhr.onerror = () => finish(new Error('网络连接中断，请重试上传'))
    xhr.ontimeout = () => finish(new Error('上传超时，请重试'))
    xhr.onabort = () => finish(new DOMException('上传已取消', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      xhr.send(file)
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })
}

export const fetchAuthStatus = (): Promise<AuthStatus> => authRequest('GET', API_AUTH_PATH)
export const pairDevice = (code: string): Promise<unknown> => authRequest('POST', API_PAIR_PATH, { code })
export const createPairingCode = (): Promise<PairingCode> => authRequest('POST', API_PAIRING_CODE_PATH, {})
export const listDevices = (): Promise<DeviceInfo[]> => authRequest('GET', API_DEVICES_PATH)
export const revokeDevice = (id: string): Promise<unknown> => authRequest('POST', API_REVOKE_PATH, { id })

async function authRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const reply = (await response.json()) as { ok: true; result: T } | RpcFailure
  if (!reply.ok) throw new Error(reply.error)
  return reply.result
}

/** The socket for one terminal tab: a fresh shell in `cwd`, sized up front. */
export function terminalUrl(params: { cwd: string; cols: number; rows: number }): string {
  const url = new URL(API_TERM_PATH, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('cwd', params.cwd)
  url.searchParams.set('cols', String(params.cols))
  url.searchParams.set('rows', String(params.rows))
  return url.toString()
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
    socket = new WebSocket(url)

    socket.addEventListener('open', () => handlers.onStatus?.('open'))
    socket.addEventListener('message', (event) => {
      handlers.onEvent(JSON.parse(String(event.data)) as ServerEvent)
    })
    socket.addEventListener('close', () => {
      handlers.onStatus?.('closed')
      if (disposed) return
      retry = setTimeout(open, 1000)
      // A refused handshake looks like any other drop from here; only the
      // auth status tells a revoked device apart from a restarting server.
      void fetchAuthStatus()
        .then((status) => {
          if (!status.authenticated) notifyUnauthorized()
        })
        .catch(() => {})
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
