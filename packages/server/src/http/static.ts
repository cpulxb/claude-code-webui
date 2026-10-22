import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `pnpm --filter @ccw/web build` output. */
export const WEB_DIST = fileURLToPath(new URL('../../../web/dist', import.meta.url))

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * The built UI, so a remote deployment is one port behind one certificate
 * instead of also exposing the Vite dev server. Public on purpose: the bundle
 * holds no secrets, and the pairing screen has to load before there is a
 * device cookie. Paths without an extension fall back to index.html.
 */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, root = WEB_DIST): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }

  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  } catch {
    res.writeHead(400).end()
    return
  }

  const base = resolve(root)
  let file = resolve(base, `.${pathname}`)
  // `resolve` already folded any `..`; anything that left the root is refused.
  if (file !== base && !file.startsWith(base + sep)) {
    res.writeHead(404).end()
    return
  }

  let info = await stat(file).catch(() => null)
  if (info?.isDirectory()) {
    file = join(file, 'index.html')
    info = await stat(file).catch(() => null)
  }
  if (!info?.isFile() && extname(pathname) === '') {
    file = join(base, 'index.html')
    info = await stat(file).catch(() => null)
  }
  if (!info?.isFile()) {
    res.writeHead(404).end()
    return
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    // Vite fingerprints everything under assets/; index.html must be re-read
    // to pick up a new build.
    'cache-control': file.startsWith(join(base, 'assets') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
}
