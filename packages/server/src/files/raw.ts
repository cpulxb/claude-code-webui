import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** How much of an unknown file is read to tell text from binary. */
const SNIFF_BYTES = 8192

/**
 * Streams a workspace file to the browser, inline or as a download. Every
 * file is untrusted content served from the UI's own origin, so anything that
 * could run script (HTML, SVG, XML) is put in a CSP sandbox: its scripts run
 * in an opaque origin that carries no device cookie and that the API's
 * same-site checks refuse. PDF is the exception, since Chrome will not show a
 * sandboxed one, and its viewer runs PDF scripts apart from the page anyway.
 * `path` must already be resolved and checked by the caller.
 */
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  options: { name: string; download: boolean },
): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
    return
  }
  const type = TYPES[extname(path).toLowerCase()] ?? ((await looksLikeText(path)) ? 'text/plain; charset=utf-8' : 'application/octet-stream')
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'content-disposition': disposition(options.download ? 'attachment' : 'inline', options.name),
    'cache-control': 'private, no-store',
    'content-security-policy': type === 'application/pdf' ? "frame-ancestors 'none'" : "sandbox allow-scripts; frame-ancestors 'none'",
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(path)
    .on('error', () => res.destroy())
    .pipe(res)
}

/** `filename` for old clients, ASCII only; `filename*` with the real name for everyone else. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

async function looksLikeText(path: string): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return false
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
    return !buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}
