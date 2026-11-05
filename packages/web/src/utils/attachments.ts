import { MAX_UPLOAD_BYTES, UPLOAD_DIR, uploadKind, type Attachment } from '@ccw/shared'

import { uploadFile } from '../api/client.ts'

export const MAX_ATTACHMENTS = 10
const MAX_CONCURRENT_UPLOADS = 2
/** The API rejects an image whose base64 passes 5 MiB; this many bytes encode to exactly that. */
export const MAX_INLINE_IMAGE_BYTES = 3.75 * 1024 * 1024
/** Nor does it take a side over 8000px. Uploaded instead, the CLI's Read tool scales it down. */
const MAX_INLINE_IMAGE_SIDE = 8000
/**
 * Raw image bytes inlined per message. Base64 inflates them by 4/3 and the
 * RPC body is capped at 32MB (`MAX_BODY_BYTES` in packages/server/src/rpc/server.ts);
 * images past this budget are uploaded instead.
 */
export const MAX_INLINE_TOTAL_BYTES = 18 * 1024 * 1024

export type UploadStatus = 'queued' | 'uploading' | 'processing' | 'ready' | 'error'
export type Upload = {
  key: number
  file: File
  status: UploadStatus
  loaded: number
  /** Set once uploaded: referenced as `@path`. */
  path?: string
  /** Set instead of `path` for a small image sent inside the message. */
  inline?: Attachment
  error?: string
}

/** Only accepted files can become CLI mentions, never @null or a failed upload. */
export function withUploads(uploads: readonly Upload[], text: string): string {
  const refs = uploads.filter((item) => item.status === 'ready' && item.path).map((item) => `@${item.path}`).join(' ')
  return refs ? (text ? `${text}\n\n${refs}` : refs) : text
}

/**
 * `withUploads` the other way round, for the bubble: the trailing paragraph of
 * `@upload/…` mentions as paths, and the text before it.
 */
export function splitUploadRefs(text: string): { body: string; refs: string[] } {
  const match = UPLOAD_REFS.exec(text)
  if (!match) return { body: text, refs: [] }
  return { body: text.slice(0, match.index), refs: match[1]!.split(' ').map((ref) => ref.slice(1)) }
}

const UPLOAD_REF = `@${UPLOAD_DIR}/\\S+`
const UPLOAD_REFS = new RegExp(`(?:^|\\n\\n)(${UPLOAD_REF}(?: ${UPLOAD_REF})*)$`)

/** The images that travel inside the message as base64 blocks. */
export function inlineAttachments(uploads: readonly Upload[]): Attachment[] {
  return uploads.flatMap((item) => (item.status === 'ready' && item.inline ? [item.inline] : []))
}

export function uploadBlockReason(uploads: readonly Upload[]): string | null {
  if (uploads.some((item) => isPending(item.status))) return '等文件上传并校验完成后再发送'
  if (uploads.some((item) => item.status !== 'ready')) return '请重试或移除上传失败的文件'
  return null
}

export function isPending(status: UploadStatus): boolean {
  return status === 'queued' || status === 'uploading' || status === 'processing'
}

/**
 * The image as an inline block, or null when it has to be uploaded instead.
 * The bytes decide the media type: the API rejects a mismatched one, and a
 * `.png` saved from the web is often a JPEG.
 */
export async function inlineImage(file: File): Promise<Attachment | null> {
  if (file.size > MAX_INLINE_IMAGE_BYTES) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mediaType = imageType(bytes)
  if (!mediaType) return null
  // Throws on an image the browser cannot decode; the queue uploads that one.
  const bitmap = await createImageBitmap(file)
  const fits = bitmap.width <= MAX_INLINE_IMAGE_SIDE && bitmap.height <= MAX_INLINE_IMAGE_SIDE
  bitmap.close()
  return fits ? { kind: 'image', mediaType, data: base64(bytes), filename: file.name } : null
}

function imageType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/**
 * Encoded chunk by chunk so a large file never materialises as one giant
 * binary string. The chunk size is a multiple of 3 so each `btoa` call ends on
 * a whole base64 group and the pieces can simply be concatenated.
 */
function base64(bytes: Uint8Array): string {
  const chunkSize = 30000
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))))
  }
  return parts.join('')
}

/**
 * One composer's upload queue. Immutable snapshots feed React, while request
 * identity guards prevent a removed/retried request from changing a newer
 * one. A session gets its own queue, so late responses cannot cross sessions.
 */
export class UploadQueue {
  private items: readonly Upload[] = []
  private readonly listeners = new Set<() => void>()
  private readonly requests = new Map<number, AbortController>()
  private sequence = 0

  constructor(
    private readonly cwd: string | undefined,
    private readonly transfer = uploadFile,
    private readonly inline: (file: File) => Promise<Attachment | null> = inlineImage,
  ) {}

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

  retry = (key: number): void => {
    const item = this.items.find((entry) => entry.key === key)
    if (item?.status !== 'error') return
    this.update(key, { status: 'queued', loaded: 0, path: undefined, inline: undefined, error: undefined })
    this.pump()
  }

  /** Aborts an unfinished upload; a ready one keeps its file on the server, only the mention goes. */
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

  private inlineBytes(): number {
    return this.items.reduce((sum, item) => sum + (item.inline ? item.file.size : 0), 0)
  }

  /** A small image goes inline; anything else, or an image that cannot, is uploaded. */
  private start(item: Upload, cwd: string): void {
    const controller = new AbortController()
    const current = (): boolean => this.requests.get(item.key) === controller
    const done = (): void => {
      if (!current()) return
      this.requests.delete(item.key)
      this.pump()
    }
    this.requests.set(item.key, controller)
    if (uploadKind(item.file.name) !== 'image' || item.file.size > MAX_INLINE_IMAGE_BYTES) {
      this.upload(item, cwd, controller.signal, current, done)
      return
    }
    this.update(item.key, { status: 'processing' })
    void this.inline(item.file).catch(() => null).then((attachment) => {
      if (!current()) return
      // Checked after the await, so images prepared side by side cannot overrun the budget together.
      if (attachment && this.inlineBytes() + item.file.size <= MAX_INLINE_TOTAL_BYTES) {
        this.update(item.key, { status: 'ready', inline: attachment, loaded: item.file.size })
        done()
      } else {
        this.upload(item, cwd, controller.signal, current, done)
      }
    })
  }

  private upload(item: Upload, cwd: string, signal: AbortSignal, current: () => boolean, done: () => void): void {
    this.update(item.key, { status: 'uploading' })
    void this.transfer({
      cwd,
      file: item.file,
      signal,
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
    ).finally(done)
  }
}
