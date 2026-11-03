import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { after, before, beforeEach, test } from 'node:test'

import { API_FILES_RAW_PATH, API_RPC_PATH } from '@ccw/shared'

import { AuthGate } from '../src/auth/gate.ts'
import { sendFile } from '../src/files/raw.ts'
import { registerRoot } from '../src/files/roots.ts'
import { createShare, listShares, revokeShare } from '../src/files/shares.ts'
import { serveStatic } from '../src/http/static.ts'
import { startServer, type ServerHandle } from '../src/rpc/server.ts'
import { SessionManager } from '../src/session/manager.ts'

let workspace: string
let outside: string
let base: string
let handle: ServerHandle

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ccw-share-ws-'))
  outside = await mkdtemp(join(tmpdir(), 'ccw-share-out-'))
  registerRoot(workspace, { trusted: true })
  const port = await freePort()
  handle = await startServer({ host: '127.0.0.1', port, manager: new SessionManager(), auth: await AuthGate.open({ dir: await mkdtemp(join(tmpdir(), 'ccw-share-auth-')) }) })
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  await handle.close()
})

beforeEach(async () => {
  process.env['CCW_CONFIG_DIR'] = await mkdtemp(join(tmpdir(), 'ccw-share-cfg-'))
  await writeFile(join(workspace, '四格图.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(workspace, 'page.html'), '<script>fetch("/api/rpc")</script>')
  await writeFile(join(workspace, 'report.pdf'), '%PDF-1.4')
  await writeFile(join(outside, 'secret.txt'), 'secret')
})

const shareUrl = (share: { token: string; name: string }, query = ''): string =>
  `${base}/share/${share.token}/${encodeURIComponent(share.name)}${query}`

test('a share link serves the file to anyone, with no cookie and from another site', async () => {
  const share = await createShare(join(workspace, '四格图.png'), '7d')
  const reply = await fetch(shareUrl(share), { headers: { 'sec-fetch-site': 'cross-site', 'x-forwarded-for': '203.0.113.9' } })
  assert.equal(reply.status, 200)
  assert.equal(reply.headers.get('content-type'), 'image/png')
  assert.match(reply.headers.get('content-disposition') ?? '', /^inline; .*filename\*=UTF-8''%E5%9B%9B%E6%A0%BC%E5%9B%BE\.png$/)
  assert.equal(reply.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.deepEqual(Buffer.from(await reply.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const download = await fetch(shareUrl(share, '?download=1'))
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; /)
})

test('HTML is sandboxed into an opaque origin; PDF is left viewable', async () => {
  const html = await fetch(shareUrl(await createShare(join(workspace, 'page.html'), '1h')))
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(html.headers.get('content-security-policy'), "sandbox allow-scripts; frame-ancestors 'none'")
  const pdf = await fetch(shareUrl(await createShare(join(workspace, 'report.pdf'), '1h')))
  assert.equal(pdf.headers.get('content-security-policy'), "frame-ancestors 'none'")
})

test('a wrong token, a wrong name, an expired or a revoked link are all the same 404', async () => {
  const share = await createShare(join(workspace, '四格图.png'), '1h')
  const statuses = [
    (await fetch(`${base}/share/${'A'.repeat(22)}/${encodeURIComponent(share.name)}`)).status,
    (await fetch(`${base}/share/${share.token}/other.png`)).status,
    (await fetch(`${base}/share/${share.token}`)).status,
    (await fetch(`${base}/share/../api/rpc`)).status,
  ]
  assert.deepEqual(statuses, [404, 404, 404, 404])

  const expired = await createShare(join(workspace, 'page.html'), '1h', Date.now() - 2 * 60 * 60 * 1000)
  assert.equal((await fetch(shareUrl(expired))).status, 404)
  assert.equal((await listShares()).some((entry) => entry.id === expired.id), false)

  assert.equal(await revokeShare(share.id), true)
  assert.equal((await fetch(shareUrl(share))).status, 404)
  assert.equal(await revokeShare(share.id), false)
})

test('a file replaced by a symlink after sharing is not followed', async () => {
  const path = join(workspace, 'swap.txt')
  await writeFile(path, 'fine')
  const share = await createShare(path, 'never')
  assert.equal(share.expiresAt, null)
  await rm(path)
  await symlink(join(outside, 'secret.txt'), path)
  assert.equal((await fetch(shareUrl(share))).status, 404)
})

test('only files inside a workspace can be shared, and only files', async () => {
  const rpc = (method: string, params: unknown): Promise<Response> =>
    fetch(`${base}${API_RPC_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
  assert.match(await (await rpc('shares.create', { path: join(outside, 'secret.txt'), ttl: '1h' })).text(), /outside every known workspace/)
  await mkdir(join(workspace, 'dir'), { recursive: true })
  assert.match(await (await rpc('shares.create', { path: join(workspace, 'dir'), ttl: '1h' })).text(), /只能分享文件/)
  assert.match(await (await rpc('shares.create', { path: join(workspace, 'page.html'), ttl: 'forever' })).text(), /unknown ttl/)
  const made = (await (await rpc('shares.create', { path: join(workspace, 'page.html'), ttl: '1d' })).json()) as { ok: boolean; result: { id: string } }
  assert.equal(made.ok, true)
  const listed = (await (await rpc('shares.list', {})).json()) as { result: { shares: { id: string }[] } }
  assert.deepEqual(listed.result.shares.map((entry) => entry.id), [made.result.id])
  assert.equal((await stat(join(process.env['CCW_CONFIG_DIR']!, 'shares.json'))).mode & 0o777, 0o600)
})

test('the raw route needs a device and stays inside the workspaces', async () => {
  const raw = (path: string, init: RequestInit = {}, query = ''): Promise<Response> =>
    fetch(`${base}${API_FILES_RAW_PATH}?path=${encodeURIComponent(path)}${query}`, init)
  const own = await raw(join(workspace, 'page.html'), {}, '&download=1')
  assert.equal(own.status, 200)
  assert.match(own.headers.get('content-disposition') ?? '', /^attachment; filename="page.html"/)
  assert.equal(own.headers.get('content-security-policy'), "sandbox allow-scripts; frame-ancestors 'none'")
  assert.equal((await raw(join(outside, 'secret.txt'))).status, 404)
  assert.equal((await raw(join(workspace, 'page.html'), { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 401)
  assert.equal((await raw(join(workspace, 'page.html'), { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
})

test('an unknown extension is served as text only when it is text', async () => {
  await writeFile(join(workspace, 'notes.unknownext'), 'plain words')
  await writeFile(join(workspace, 'blob.unknownext2'), Buffer.from([1, 0, 2]))
  const text = await fetch(`${base}${API_FILES_RAW_PATH}?path=${encodeURIComponent(join(workspace, 'notes.unknownext'))}`)
  assert.equal(text.headers.get('content-type'), 'text/plain; charset=utf-8')
  const blob = await fetch(`${base}${API_FILES_RAW_PATH}?path=${encodeURIComponent(join(workspace, 'blob.unknownext2'))}`)
  assert.equal(blob.headers.get('content-type'), 'application/octet-stream')
  assert.equal(await readFile(join(workspace, 'notes.unknownext'), 'utf8'), 'plain words')
})

test('a download cancelled halfway closes the file it was reading', { skip: process.platform !== 'linux' }, async () => {
  const big = join(workspace, 'big.bin')
  await writeFile(big, Buffer.alloc(4 * 1024 * 1024))
  const req = { method: 'GET', url: '/big.bin' } as IncomingMessage
  for (let i = 0; i < 5; i++) {
    const shared = abortingResponse()
    await sendFile(req, shared.res, big, { name: 'big.bin', download: true })
    await shared.closed
    // The built UI is served the same way, to clients that never paired.
    const asset = abortingResponse()
    await serveStatic(req, asset.res, workspace)
    await asset.closed
  }
  // A destroyed read stream closes its descriptor a tick or two later.
  for (let tries = 0; tries < 50 && (await openCount(big)) > 0; tries++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await openCount(big), 0)
})

/** A response whose client goes away after the first chunk, as a cancelled download does. */
function abortingResponse(): { res: ServerResponse; closed: Promise<void> } {
  const res = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
      this.destroy()
    },
  })
  Object.assign(res, { writeHead: () => res })
  return { res: res as unknown as ServerResponse, closed: new Promise((resolve) => res.once('close', () => resolve())) }
}

/** This process's descriptors open on `path`. */
async function openCount(path: string): Promise<number> {
  let count = 0
  for (const fd of await readdir('/proc/self/fd')) {
    if ((await readlink(`/proc/self/fd/${fd}`).catch(() => '')) === path) count++
  }
  return count
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}
