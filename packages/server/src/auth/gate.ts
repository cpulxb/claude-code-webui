import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  API_AUTH_PATH,
  API_DEVICES_PATH,
  API_PAIR_PATH,
  API_PAIRING_CODE_PATH,
  API_REVOKE_PATH,
  type AuthStatus,
  type DeviceInfo,
  type RpcFailure,
} from '@ccw/shared'

import { DEVICE_IDLE_MS, DeviceStore, type Device } from './devices.ts'
import { configDir, issueCode, redeemCode, revokeAllCodes } from './pairing.ts'

/**
 * `__Host-` makes the browser refuse the cookie unless it is Secure, host-only
 * and path `/`, so no sibling subdomain or plain-HTTP page can plant or read it.
 */
const COOKIE = '__Host-ccw-device'

/** Wrong codes tolerated within the window before every pending code is burned. */
const FAILURE_LIMIT = 5
const FAILURE_WINDOW_MS = 15 * 60 * 1000

/** Pairing bodies are one short field; anything larger is not a client of ours. */
const MAX_AUTH_BODY = 4 * 1024

/** The machine itself, or a paired device. A request that is neither gets null. */
export type Principal = { local: true; device?: undefined } | { local: false; device: Device }

/**
 * Pairing in front of every `/api` route. A 40-bit code, consumed on first use,
 * buys a 256-bit device token carried in an HttpOnly cookie — so the token is
 * never in a URL, a WebSocket handshake carries it without page code touching
 * it, and an XSS cannot read it out.
 */
export class AuthGate {
  readonly #store: DeviceStore
  readonly #dir: string
  readonly #requirePairing: boolean
  #failures: number[] = []

  private constructor(store: DeviceStore, dir: string, requirePairing: boolean) {
    this.#store = store
    this.#dir = dir
    this.#requirePairing = requirePairing
  }

  /** `requirePairing` takes the loopback exemption away (`CCW_REQUIRE_PAIRING=1`). */
  static async open(options: { dir?: string; requirePairing?: boolean } = {}): Promise<AuthGate> {
    const dir = options.dir ?? configDir()
    return new AuthGate(await DeviceStore.open(dir), dir, options.requirePairing ?? false)
  }

  identify(req: IncomingMessage): Principal | null {
    if (!this.#requirePairing && isLocalRequest(req)) return { local: true }
    const token = readCookie(req.headers.cookie, COOKIE)
    const device = token ? this.#store.authenticate(token, clientIp(req)) : null
    return device ? { local: false, device } : null
  }

  /** Serves a route under `/api/auth`. False when the path is none of them. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal | null,
    onRevoke: (deviceId: string) => void,
  ): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = `${req.method} ${path}`

    if (route === `GET ${API_AUTH_PATH}`) {
      const status: AuthStatus = { authenticated: principal !== null, local: principal?.local ?? false }
      // Re-issuing the cookie on every app load is what makes the idle expiry
      // slide in the browser too, not only in devices.json.
      const token = principal?.device ? readCookie(req.headers.cookie, COOKIE) : undefined
      send(res, 200, { ok: true, result: status }, token ? { 'set-cookie': deviceCookie(token) } : {})
      return true
    }

    if (route === `POST ${API_PAIR_PATH}`) {
      await this.#pair(req, res)
      return true
    }

    const routes = [
      `POST ${API_PAIRING_CODE_PATH}`,
      `GET ${API_DEVICES_PATH}`,
      `POST ${API_REVOKE_PATH}`,
    ]
    if (!routes.includes(route)) return false
    if (!principal) {
      send(res, 401, { ok: false, error: 'unauthorized' })
      return true
    }

    if (route === `POST ${API_PAIRING_CODE_PATH}`) {
      send(res, 200, { ok: true, result: await issueCode(this.#dir) })
    } else if (route === `GET ${API_DEVICES_PATH}`) {
      const devices: DeviceInfo[] = this.#store.list().map((device) => ({
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        lastIp: device.lastIp,
        current: device.id === principal.device?.id,
      }))
      send(res, 200, { ok: true, result: devices })
    } else {
      const { id } = await readJson(req)
      if (typeof id !== 'string' || !(await this.#store.revoke(id))) {
        send(res, 404, { ok: false, error: 'unknown device' })
        return true
      }
      console.log(`[ccw] revoked device ${id}`)
      onRevoke(id)
      send(res, 200, { ok: true, result: {} })
    }
    return true
  }

  async #pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { code } = await readJson(req)
    const ip = clientIp(req)
    if (typeof code === 'string' && (await redeemCode(code, this.#dir))) {
      this.#failures = []
      const { device, token } = await this.#store.add(deviceName(req.headers['user-agent']), ip)
      console.log(`[ccw] paired ${device.name} from ${ip}`)
      send(res, 200, { ok: true, result: {} }, { 'set-cookie': deviceCookie(token) })
      return
    }

    // A wrong guess cannot tell which code it was aimed at, so the limit is
    // global: past it every pending code is burned, which caps a guesser at a
    // handful of tries per code no matter how many addresses it comes from.
    const now = Date.now()
    this.#failures = [...this.#failures.filter((at) => now - at < FAILURE_WINDOW_MS), now]
    console.warn(`[ccw] wrong pairing code from ${ip} (${this.#failures.length}/${FAILURE_LIMIT})`)
    if (this.#failures.length >= FAILURE_LIMIT) {
      this.#failures = []
      await revokeAllCodes(this.#dir)
      console.warn('[ccw] too many wrong pairing codes; every pending code was revoked')
      send(res, 429, { ok: false, error: 'too many attempts' })
      return
    }
    send(res, 401, { ok: false, error: 'invalid pairing code' })
  }
}

/**
 * A request from this machine that no proxy relayed. All three must hold: a
 * reverse proxy on the same host connects from loopback too, but Caddy and
 * Tailscale keep the public Host and add X-Forwarded-For, which rules them out.
 * The Vite dev server proxies with neither, which is why it must stay bound to
 * loopback — exposed, it would launder outside requests into local ones.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const relayed = req.headers['x-forwarded-for'] ?? req.headers['forwarded'] ?? req.headers['x-real-ip']
  return isLoopbackAddress(req.socket.remoteAddress) && isLoopbackHost(req.headers.host) && relayed === undefined
}

/** The peer address, or the client a local proxy says it relayed for. Informational only. */
export function clientIp(req: IncomingMessage): string {
  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
  const forwarded = req.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return isLoopbackAddress(peer) && first ? first : peer
}

export function isLoopbackHost(header: string | undefined): boolean {
  if (!header) return false
  try {
    const { hostname } = new URL(`http://${header}`)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function deviceCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${DEVICE_IDLE_MS / 1000}; HttpOnly; Secure; SameSite=Strict`
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

/** "Safari · iPhone" — enough to tell devices apart in the list. */
function deviceName(userAgent = ''): string {
  const os = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Mac OS X/.test(userAgent)
            ? 'macOS'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : '未知系统'
  const browser = /Edg(e|A|iOS)?\//.test(userAgent)
    ? 'Edge'
    : /Firefox\/|FxiOS\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : '浏览器'
  return `${browser} · ${os}`
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_AUTH_BODY) return {}
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: { ok: true; result: unknown } | RpcFailure,
  headers: Record<string, string> = {},
): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), ...headers })
  res.end(json)
}
