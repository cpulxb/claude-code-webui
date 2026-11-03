import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'

import { SHARE_TTLS, type Share, type ShareTtl } from '@ccw/shared'

import { configDir } from '../auth/pairing.ts'
import { sendFile } from './raw.ts'

const FILE = 'shares.json'
const MAX_SHARES = 500
const TOKEN = /^[\w-]{22}$/

/** Writes one at a time, so two shares made at once do not drop each other. */
let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

/**
 * Makes a link to one file that works without pairing, until it expires or
 * is revoked. `path` must already be resolved inside a workspace; the link is
 * bound to its real path, so a symlink swapped in later is not followed. The
 * token is 128 random bits, kept in the private config directory so the link
 * can be copied again from the settings page.
 */
export function createShare(path: string, ttl: ShareTtl, now = Date.now()): Promise<Share> {
  return serialized(async () => {
    const real = await realpath(path)
    if (!(await stat(real)).isFile()) throw new Error('只能分享文件，不能分享目录')
    const shares = await live(now)
    if (shares.length >= MAX_SHARES) throw new Error(`最多保留 ${MAX_SHARES} 个分享链接，请先撤销一些旧的`)
    const lifetime = SHARE_TTLS[ttl]
    const share: Share = {
      id: randomBytes(6).toString('hex'),
      token: randomBytes(16).toString('base64url'),
      path: real,
      name: basename(real),
      createdAt: now,
      expiresAt: lifetime === null ? null : now + lifetime,
    }
    await save([...shares, share])
    console.log(`[ccw] shared ${real} as ${share.id} (${ttl})`)
    return share
  })
}

/** The links still valid, newest first. Expired ones are left out, and dropped from the file at its next write. */
export async function listShares(now = Date.now()): Promise<Share[]> {
  return [...(await live(now))].reverse()
}

export function revokeShare(id: string, now = Date.now()): Promise<boolean> {
  return serialized(async () => {
    const shares = await live(now)
    const kept = shares.filter((share) => share.id !== id)
    if (kept.length === shares.length) return false
    await save(kept)
    console.log(`[ccw] revoked share ${id}`)
    return true
  })
}

/**
 * `GET /share/<token>/<name>`: the shared file, to anyone holding the link.
 * Every failure — unknown, expired or revoked token, a name that is not the
 * shared file's, a file gone or replaced by a symlink — is the same 404, so
 * the answer tells a guesser nothing.
 */
export async function serveShare(req: IncomingMessage, res: ServerResponse, now = Date.now()): Promise<void> {
  const notFound = (): void => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('链接不存在或已失效')
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = /^\/share\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  let name: string
  try {
    name = decodeURIComponent(match?.[2] ?? '')
  } catch {
    return notFound()
  }
  const token = match?.[1] ?? ''
  if (!TOKEN.test(token)) return notFound()
  const share = (await live(now)).find((entry) => sameToken(entry.token, token))
  if (!share || share.name !== name) return notFound()
  if ((await realpath(share.path).catch(() => null)) !== share.path) return notFound()
  res.setHeader('x-robots-tag', 'noindex, nofollow')
  if (req.method === 'GET') console.log(`[ccw] share ${share.id} fetched (${share.name})`)
  await sendFile(req, res, share.path, { name: share.name, download: url.searchParams.get('download') === '1' })
}

function sameToken(stored: string, given: string): boolean {
  const a = Buffer.from(stored)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function live(now: number): Promise<Share[]> {
  const all = await load()
  return all.filter((share) => share.expiresAt === null || share.expiresAt > now)
}

async function load(): Promise<Share[]> {
  const raw = await readFile(join(configDir(), FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '[]'
    throw error
  })
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // A damaged file revokes every link rather than stopping the server.
    console.warn(`[ccw] ${FILE} is not valid JSON; treating it as empty`)
    return []
  }
  return Array.isArray(value) ? value.filter(isShare) : []
}

async function save(shares: Share[]): Promise<void> {
  const dir = configDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, FILE)
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(shares, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

function isShare(value: unknown): value is Share {
  if (typeof value !== 'object' || value === null) return false
  const share = value as Record<string, unknown>
  return (
    typeof share['id'] === 'string' &&
    typeof share['token'] === 'string' &&
    typeof share['path'] === 'string' &&
    typeof share['name'] === 'string' &&
    typeof share['createdAt'] === 'number' &&
    (share['expiresAt'] === null || typeof share['expiresAt'] === 'number')
  )
}
