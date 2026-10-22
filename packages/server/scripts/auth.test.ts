import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { API_AUTH_PATH, API_DEVICES_PATH, API_EVENTS_PATH, API_PAIR_PATH, API_PAIRING_CODE_PATH, API_REVOKE_PATH, API_RPC_PATH } from '@ccw/shared'
import { WebSocket } from 'ws'

import { DEVICE_IDLE_MS, DeviceStore } from '../src/auth/devices.ts'
import { AuthGate } from '../src/auth/gate.ts'
import { CODE_TTL_MS, issueCode, normalizeCode, redeemCode } from '../src/auth/pairing.ts'
import { startServer, type ServerHandle } from '../src/rpc/server.ts'
import { SessionManager } from '../src/session/manager.ts'

/** Sent by any request that should look like it came through a reverse proxy. */
const VIA_PROXY = { 'x-forwarded-for': '203.0.113.9' }

type Reply = { status: number; headers: IncomingHttpHeaders; body: string }

let dir: string
let webRoot: string
let port: number
let handle: ServerHandle

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ccw-auth-'))
  webRoot = await mkdtemp(join(tmpdir(), 'ccw-web-'))
  await mkdir(join(webRoot, 'assets'))
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>ccw</title>')
  await writeFile(join(webRoot, 'assets', 'app-1234.js'), 'console.log(1)')
  port = await freePort()
  handle = await startServer({ host: '127.0.0.1', port, manager: new SessionManager(), auth: await AuthGate.open({ dir }), webRoot })
})

after(async () => {
  await handle.close()
})

test('pairing codes are 8 Crockford characters and forgive case and look-alikes', () => {
  assert.equal(normalizeCode('k7qm-3xpd'), 'K7QM3XPD')
  assert.equal(normalizeCode('OIL0 1234'), '01101234')
  assert.equal(normalizeCode('K7QM-3XP'), null)
  assert.equal(normalizeCode('K7QM-3XPU'), null)
})

test('a code works once and not after it expires', async () => {
  const { code } = await issueCode(dir)
  assert.equal(await redeemCode(code, dir), true)
  assert.equal(await redeemCode(code, dir), false)

  const now = Date.now()
  const late = await issueCode(dir, now)
  assert.equal(await redeemCode(late.code, dir, now + CODE_TTL_MS + 1), false)
})

test('a device left unused past the idle limit has to pair again', async () => {
  const store = await DeviceStore.open(await mkdtemp(join(tmpdir(), 'ccw-devices-')))
  const now = Date.now()
  const { token } = await store.add('Chrome · Linux', '203.0.113.9', now)
  assert.ok(store.authenticate(token, '203.0.113.9', now + DEVICE_IDLE_MS - 1))
  // Using it moved the idle clock, so measure from that use.
  assert.equal(store.authenticate(token, '203.0.113.9', now + 2 * DEVICE_IDLE_MS), null)
})

test('a request from this machine needs no pairing, one relayed by a proxy does', async () => {
  const local = await call('GET', API_AUTH_PATH)
  assert.deepEqual(JSON.parse(local.body).result, { authenticated: true, local: true })

  const relayed = await call('GET', API_AUTH_PATH, { headers: VIA_PROXY })
  assert.deepEqual(JSON.parse(relayed.body).result, { authenticated: false, local: false })
  assert.equal((await call('POST', API_RPC_PATH, { headers: VIA_PROXY, json: { method: 'nope' } })).status, 401)

  // A public Host is what Caddy and tailscale serve pass through.
  const publicHost = await call('POST', API_RPC_PATH, { headers: { host: 'ccw.example.com' }, json: { method: 'nope' } })
  assert.equal(publicHost.status, 401)
})

test('pairing sets an HttpOnly, Secure, SameSite=Strict cookie that then authorizes', async () => {
  const { code } = await issueCode(dir)
  const paired = await call('POST', API_PAIR_PATH, { headers: { ...VIA_PROXY, 'user-agent': iphone }, json: { code } })
  assert.equal(paired.status, 200)
  const cookie = setCookie(paired)
  assert.match(cookie, /^__Host-ccw-device=[\w-]{43};/)
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(attribute), attribute)

  const headers = { ...VIA_PROXY, cookie: cookie.split(';')[0]! }
  // Past the gate: an unknown method is a 404, not a 401.
  assert.equal((await call('POST', API_RPC_PATH, { headers, json: { method: 'nope' } })).status, 404)
  const status = await call('GET', API_AUTH_PATH, { headers })
  assert.deepEqual(JSON.parse(status.body).result, { authenticated: true, local: false })
  assert.ok(setCookie(status), 'every app load re-issues the cookie so its expiry slides')

  const devices = JSON.parse((await call('GET', API_DEVICES_PATH, { headers })).body).result as { name: string; current: boolean; lastIp: string }[]
  const current = devices.find((device) => device.current)
  assert.equal(current?.name, 'Safari · iPhone')
  assert.equal(current?.lastIp, '203.0.113.9')

  const stored = await readFile(join(dir, 'devices.json'), 'utf8')
  assert.ok(!stored.includes(cookie.split(';')[0]!.split('=')[1]!), 'devices.json keeps only a hash of the token')
})

test('repeated wrong codes burn every pending code', async () => {
  const { code } = await issueCode(dir)
  const statuses: number[] = []
  for (let i = 0; i < 5; i++) {
    statuses.push((await call('POST', API_PAIR_PATH, { headers: VIA_PROXY, json: { code: 'AAAA-AAAA' } })).status)
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 429])
  const late = await call('POST', API_PAIR_PATH, { headers: VIA_PROXY, json: { code } })
  assert.equal(late.status, 401)
})

test('revoking a device rejects its cookie and closes its open sockets', async () => {
  const cookie = await pairDevice()
  const headers = { ...VIA_PROXY, cookie }
  const socket = new WebSocket(`ws://127.0.0.1:${port}${API_EVENTS_PATH}`, { headers: { ...headers, origin: `http://127.0.0.1:${port}` } })
  await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject))
  const closed = new Promise<number>((resolve) => socket.once('close', resolve))

  const devices = JSON.parse((await call('GET', API_DEVICES_PATH, { headers })).body).result as { id: string; current: boolean }[]
  const id = devices.find((device) => device.current)!.id
  assert.equal((await call('POST', API_REVOKE_PATH, { headers, json: { id } })).status, 200)

  const stillOpen = new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 2000).unref())
  assert.equal(await Promise.race([closed, stillOpen]), 1008)
  assert.equal((await call('POST', API_RPC_PATH, { headers, json: { method: 'nope' } })).status, 401)
})

test('sockets need a principal, and a browser page from another origin is refused', async () => {
  assert.equal(await opens(`ws://127.0.0.1:${port}${API_EVENTS_PATH}`, VIA_PROXY), false)
  const cookie = await pairDevice()
  assert.equal(await opens(`ws://127.0.0.1:${port}${API_EVENTS_PATH}`, { ...VIA_PROXY, cookie }), true)
  // Through the loopback exemption, another site's page must not read the stream.
  assert.equal(await opens(`ws://127.0.0.1:${port}${API_EVENTS_PATH}`, { origin: 'https://evil.example' }), false)
})

test('an API POST that skips the CORS preflight is refused, even from this machine', async () => {
  const reply = await call('POST', API_RPC_PATH, { headers: { 'content-type': 'text/plain' }, body: '{"method":"nope"}' })
  assert.equal(reply.status, 415)
  const code = await call('POST', API_PAIRING_CODE_PATH, { headers: { 'content-type': 'text/plain' }, body: '{}' })
  assert.equal(code.status, 415)
})

test('the built UI is public, falls back to index.html, and cannot be escaped', async () => {
  const index = await call('GET', '/', { headers: VIA_PROXY })
  assert.equal(index.status, 200)
  assert.match(index.body, /<title>ccw/)
  assert.equal(index.headers['cache-control'], 'no-cache')
  assert.equal(index.headers['x-frame-options'], 'DENY')

  const route = await call('GET', '/sessions/abc', { headers: VIA_PROXY })
  assert.match(route.body, /<title>ccw/)

  const asset = await call('GET', '/assets/app-1234.js', { headers: VIA_PROXY })
  assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.match(String(asset.headers['cache-control']), /immutable/)

  const escape = await call('GET', '/..%2f..%2f..%2fetc%2fpasswd', { headers: VIA_PROXY })
  assert.equal(escape.status, 404)
  assert.ok(!escape.body.includes('root:'))

  // A navigation in from another site is fine; only /api is held to same-origin.
  const linked = await call('GET', '/', { headers: { ...VIA_PROXY, 'sec-fetch-site': 'cross-site' } })
  assert.equal(linked.status, 200)
})

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

async function pairDevice(): Promise<string> {
  const { code } = await issueCode(dir)
  const reply = await call('POST', API_PAIR_PATH, { headers: VIA_PROXY, json: { code } })
  assert.equal(reply.status, 200)
  return setCookie(reply).split(';')[0]!
}

function setCookie(reply: Reply): string {
  const header = reply.headers['set-cookie']
  return (Array.isArray(header) ? header[0] : header) ?? ''
}

/** Raw node:http, since fetch will not send a custom Host header. */
function call(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; json?: unknown; body?: string } = {},
): Promise<Reply> {
  const body = options.json !== undefined ? JSON.stringify(options.json) : options.body
  const headers = { ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function opens(url: string, headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers })
    socket.once('open', () => {
      socket.close()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}
