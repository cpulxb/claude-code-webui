import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'

import type { RpcResponse } from '@ccw/shared'

import { resolveInWorkspace } from './roots.ts'
import { saveUploadStream, UploadError } from './upload.ts'

/** Authentication, origin and binary content-type gates run in rpc/server.ts first. */
export async function serveUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  const responseClosed = (): void => {
    // req.aborted alone misses cancellation after the body arrived but while
    // the temporary file is still being validated/closed/published.
    if (!res.writableFinished) abort()
  }
  req.once('aborted', abort)
  req.once('error', abort)
  res.once('close', responseClosed)
  try {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const requested = query.get('cwd')
    const filename = query.get('filename')
    if (!requested || !isAbsolute(requested) || !filename) throw new UploadError('cwd 和 filename 不能为空，cwd 必须是绝对路径')
    const cwd = await resolveInWorkspace(requested).catch(() => null)
    if (!cwd || !(await stat(cwd).then((info) => info.isDirectory(), () => false))) throw new UploadError('not found', 404)
    const length = req.headers['content-length']
    const size = length === undefined ? undefined : Number(length)
    // Do not destroy the HTTP request on an early validation/limit failure:
    // the client still needs to receive the JSON error before we close it.
    const result = await saveUploadStream(cwd, filename, req.iterator({ destroyOnReturn: false }), { size, signal: controller.signal })
    send(req, res, 200, { ok: true, result })
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return
    const status = error instanceof UploadError ? error.status : 500
    if (status === 500) console.error('[ccw] upload failed', error)
    send(req, res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    req.removeListener('aborted', abort)
    req.removeListener('error', abort)
    res.removeListener('close', responseClosed)
  }
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: RpcResponse<'files.upload'>): void {
  if (res.destroyed || res.writableEnded) return
  if (!req.complete) {
    // Reject oversized or unsupported bodies immediately instead of buffering
    // or waiting for an attacker to finish sending them. Node closes the
    // connection after delivering this response; discarded bytes are not saved.
    res.setHeader('connection', 'close')
    req.resume()
  }
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) })
  res.end(json)
}
