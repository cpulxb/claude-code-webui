import { MAX_UPLOAD_BYTES, uploadKind } from '@ccw/shared'

import { uploadFile } from '../api/client.ts'

export const MAX_ATTACHMENTS = 10
const MAX_CONCURRENT_UPLOADS = 2

export type UploadStatus = 'queued' | 'uploading' | 'processing' | 'ready' | 'error' | 'cancelled'
export type Upload = {
  key: number
  file: File
  status: UploadStatus
  loaded: number
  path?: string
  error?: string
}

/** Only accepted files can become CLI mentions, never @null or a failed upload. */
export function withUploads(uploads: readonly Upload[], text: string): string {
  const refs = uploads.filter((item) => item.status === 'ready' && item.path).map((item) => `@${item.path}`).join(' ')
  return refs ? (text ? `${text}\n\n${refs}` : refs) : text
}

export function uploadBlockReason(uploads: readonly Upload[]): string | null {
  if (uploads.some((item) => isPending(item.status))) return '等文件上传并校验完成后再发送'
  if (uploads.some((item) => item.status !== 'ready')) return '请重试或移除上传失败、已取消的文件'
  return null
}

function isPending(status: UploadStatus): boolean {
  return status === 'queued' || status === 'uploading' || status === 'processing'
}

/**
 * One composer's upload queue. Immutable snapshots feed React, while request
 * identity guards prevent a cancelled/retried request from changing a newer
 * one. A session gets its own queue, so late responses cannot cross sessions.
 */
export class UploadQueue {
  private items: readonly Upload[] = []
  private readonly listeners = new Set<() => void>()
  private readonly requests = new Map<number, AbortController>()
  private sequence = 0

  constructor(private readonly cwd: string | undefined, private readonly transfer = uploadFile) {}

  getSnapshot = (): readonly Upload[] => this.items

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Validates before allocating a request; repeated drops share the same budget. */
  add = (files: Iterable<File>): string | null => {
    if (this.cwd === undefined) return '请先打开一个会话再上传文件'
    const rejected: string[] = []
    const accepted: Upload[] = []
    let noRoom = false
    for (const file of files) {
      if (!uploadKind(file.name)) rejected.push(`${file.name}：不支持的文件类型`)
      else if (file.size === 0) rejected.push(`${file.name}：文件是空的`)
      else if (file.size > MAX_UPLOAD_BYTES) rejected.push(`${file.name}：超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`)
      else if (this.items.length + accepted.length >= MAX_ATTACHMENTS) noRoom = true
      else accepted.push({ key: ++this.sequence, file, status: 'queued', loaded: 0 })
    }
    if (noRoom) rejected.push(`最多 ${MAX_ATTACHMENTS} 个附件，请先移除不需要的文件`)
    if (accepted.length > 0) {
      this.items = [...this.items, ...accepted]
      this.emit()
      this.pump()
    }
    return rejected.length > 0 ? rejected.join('；') : null
  }

  cancel = (key: number): void => {
    const item = this.items.find((entry) => entry.key === key)
    if (!item || !isPending(item.status)) return
    this.abort(key)
    this.update(key, { status: 'cancelled' })
    this.pump()
  }

  retry = (key: number): void => {
    const item = this.items.find((entry) => entry.key === key)
    if (!item || (item.status !== 'error' && item.status !== 'cancelled')) return
    this.update(key, { status: 'queued', loaded: 0, path: undefined, error: undefined })
    this.pump()
  }

  /** Removing a ready chip drops the mention, not the file already saved on the server. */
  remove = (key: number): void => {
    this.abort(key)
    this.items = this.items.filter((item) => item.key !== key)
    this.emit()
    this.pump()
  }

  clear = (): void => {
    const controllers = [...this.requests.values()]
    this.requests.clear()
    this.items = []
    for (const controller of controllers) controller.abort()
    this.emit()
  }

  private abort(key: number): void {
    const controller = this.requests.get(key)
    // Invalidate before aborting: even synchronous callbacks must be ignored.
    this.requests.delete(key)
    controller?.abort()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private update(key: number, patch: Partial<Upload>): void {
    this.items = this.items.map((item) => item.key === key ? { ...item, ...patch } : item)
    this.emit()
  }

  private pump(): void {
    while (this.requests.size < MAX_CONCURRENT_UPLOADS) {
      const item = this.items.find((entry) => entry.status === 'queued')
      if (!item || this.cwd === undefined) return
      this.start(item, this.cwd)
    }
  }

  private start(item: Upload, cwd: string): void {
    const controller = new AbortController()
    const current = (): boolean => this.requests.get(item.key) === controller
    this.requests.set(item.key, controller)
    this.update(item.key, { status: 'uploading' })
    void this.transfer({
      cwd,
      file: item.file,
      signal: controller.signal,
      onProgress: (bytes) => {
        if (!current()) return
        const loaded = Math.min(item.file.size, Math.max(0, bytes))
        this.update(item.key, { loaded, status: loaded === item.file.size ? 'processing' : 'uploading' })
      },
    }).then(
      ({ path }) => {
        if (current()) this.update(item.key, { status: 'ready', path, loaded: item.file.size })
      },
      (cause: unknown) => {
        if (current()) this.update(item.key, {
          status: 'error',
          error: cause instanceof Error ? cause.message : String(cause),
        })
      },
    ).finally(() => {
      if (!current()) return
      this.requests.delete(item.key)
      this.pump()
    })
  }
}
