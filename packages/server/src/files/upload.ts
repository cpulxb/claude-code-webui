import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { MAX_UPLOAD_BYTES, UPLOAD_DIR, uploadKind, type UploadKind } from '@ccw/shared'

/** All of a workspace's uploads together; past it the oldest have to be deleted by hand. */
export const MAX_UPLOAD_DIR_BYTES = 500 * 1024 * 1024
const MAX_STEM_LENGTH = 100
const MAX_NAME_TRIES = 1000
const HEADER_BYTES = 64 * 1024

const ZIP = [Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('PK\x05\x06', 'latin1')]
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
/** OOXML zip entry names and legacy OLE stream names, including across chunks. */
const MACROS = [Buffer.from('vbaProject.bin', 'latin1'), Buffer.from('_VBA_PROJECT', 'utf16le')]
const MACRO_OVERLAP = Math.max(...MACROS.map((marker) => marker.length)) - 1

export class UploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'UploadError'
  }
}

type Quota = { tail: Promise<void>; used: number; reserved: number; temporary: Set<string> }
// Canonical directory keys keep symlink aliases from getting separate quotas.
// Both the legacy RPC and HTTP receiver use these short critical sections;
// network reads and file writes run concurrently, with reserved bytes counted.
const quotas = new Map<string, Quota>()

function quotaFor(dir: string): Quota {
  let quota = quotas.get(dir)
  if (!quota) {
    quota = { tail: Promise.resolve(), used: 0, reserved: 0, temporary: new Set() }
    quotas.set(dir, quota)
  }
  return quota
}

async function locked<T>(quota: Quota, action: () => T | Promise<T>): Promise<T> {
  const previous = quota.tail
  let release!: () => void
  quota.tail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await action()
  } finally {
    release()
  }
}

/** Compatibility for existing base64 RPC callers; all safety rules are shared. */
export function saveUpload(cwd: string, filename: string, data: Buffer): Promise<{ path: string; size: number }> {
  return saveUploadStream(cwd, filename, [data], { size: data.length })
}

/**
 * Stream into a private temporary file, inspect incrementally, then publish a
 * complete file without replacing any existing name. `cwd` must already have
 * passed the workspace guard. A known size is reserved up front; chunked
 * requests reserve each chunk before writing, never exceeding either limit.
 */
export async function saveUploadStream(
  cwd: string,
  filename: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: { size?: number; signal?: AbortSignal } = {},
): Promise<{ path: string; size: number }> {
  const name = safeName(filename)
  const kind = uploadKind(name)
  if (!kind) throw new UploadError(`不支持上传这种文件：${extname(name) || '没有扩展名'}`)
  if (options.size !== undefined) {
    if (!Number.isSafeInteger(options.size) || options.size < 0) throw new UploadError('文件大小无效')
    if (options.size === 0) throw new UploadError('文件是空的')
    checkSize(options.size)
  }
  cancelled(options.signal)
  const dir = await uploadDir(await realpath(cwd))
  const quota = quotaFor(dir)
  const temporaryName = `.upload-${randomUUID()}.part`
  const temporary = join(dir, temporaryName)
  let handle: FileHandle | undefined
  let created = false
  let published: string | undefined
  let reserved = 0
  let size = 0
  let saved = false
  const inspector = new UploadInspector(kind, extname(name))

  try {
    handle = await locked(quota, async () => {
      cancelled(options.signal)
      await assertDirectory(dir)
      quota.used = await usedBytes(dir, quota.temporary)
      checkQuota(quota, options.size ?? 0)
      const file = await open(temporary, 'wx', 0o600)
      created = true
      quota.temporary.add(temporaryName)
      reserved = options.size ?? 0
      quota.reserved += reserved
      return file
    })

    for await (const value of source) {
      cancelled(options.signal)
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      checkSize(size + chunk.length)
      if (options.size !== undefined && size + chunk.length > options.size) throw new UploadError('文件大小与声明不符')
      inspector.add(chunk)
      if (options.size === undefined) {
        await locked(quota, () => {
          cancelled(options.signal)
          checkQuota(quota, chunk.length)
          reserved += chunk.length
          quota.reserved += chunk.length
        })
      }
      cancelled(options.signal)
      await handle.writeFile(chunk)
      size += chunk.length
    }
    cancelled(options.signal)
    if (size === 0) throw new UploadError('文件是空的')
    if (options.size !== undefined && size !== options.size) throw new UploadError('文件大小与声明不符')
    inspector.finish()
    await handle.chmod(0o644) // Saved source files must not become executable.
    await handle.close()
    handle = undefined

    return await locked(quota, async () => {
      cancelled(options.signal)
      await assertDirectory(dir)
      // Also notice files added by something other than this upload receiver.
      quota.used = await usedBytes(dir, quota.temporary)
      checkQuota(quota, 0)
      const ext = extname(name)
      const stem = name.slice(0, name.length - ext.length)
      for (let attempt = 0; attempt < MAX_NAME_TRIES; attempt++) {
        cancelled(options.signal)
        const candidate = attempt === 0 ? name : `${stem}-${attempt}${ext}`
        const target = join(dir, candidate)
        // A hard link publishes the already complete file atomically. Unlike
        // rename(), it fails on EEXIST, including a planted target symlink.
        const linked = await link(temporary, target).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST') return false
          throw error
        })
        if (!linked) continue
        published = target
        cancelled(options.signal)
        await unlink(temporary)
        created = false
        cancelled(options.signal)
        quota.temporary.delete(temporaryName)
        quota.reserved -= reserved
        reserved = 0
        quota.used += size
        saved = true
        return { path: `${UPLOAD_DIR}/${candidate}`, size }
      }
      throw new UploadError('同名文件太多，请改个文件名再上传')
    })
  } finally {
    try {
      await handle?.close()
    } finally {
      if (!saved) {
        await locked(quota, async () => {
          try {
            await assertDirectory(dir) // Cleanup must not follow a replaced directory symlink either.
            if (published) await remove(published)
            if (created) await remove(temporary)
          } finally {
            quota.temporary.delete(temporaryName)
            quota.reserved -= reserved
            // Fail closed if cleanup or the directory itself became unreadable.
            quota.used = MAX_UPLOAD_DIR_BYTES
            await assertDirectory(dir)
            quota.used = await usedBytes(dir, quota.temporary)
          }
        })
      }
    }
  }
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new UploadError('上传已取消', 499)
}

function checkSize(size: number): void {
  if (size > MAX_UPLOAD_BYTES) throw new UploadError(`文件超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB`, 413)
}

function checkQuota(quota: Quota, extra: number): void {
  if (quota.used + quota.reserved + extra > MAX_UPLOAD_DIR_BYTES) {
    throw new UploadError(`${UPLOAD_DIR}/ 已超过 ${MAX_UPLOAD_DIR_BYTES / (1024 * 1024)} MiB，请先清理旧文件`, 413)
  }
}

/** Basename only: no path traversal, dotfiles, options, whitespace or shell metacharacters. */
export function safeName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*`$;&'!#%@{}[\]^~]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^[.\-_]+/, '')
  const ext = extname(cleaned).toLowerCase()
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, MAX_STEM_LENGTH).replace(/[.\-_]+$/, '')
  return `${stem || 'file'}${ext}`
}

/** Bounded header storage; text and Office macro checks cover the entire stream. */
class UploadInspector {
  readonly #header = Buffer.alloc(HEADER_BYTES)
  #length = 0
  #tail = Buffer.alloc(0)

  constructor(readonly kind: UploadKind, readonly ext: string) {}

  add(chunk: Buffer): void {
    const length = Math.min(chunk.length, HEADER_BYTES - this.#length)
    chunk.copy(this.#header, this.#length, 0, length)
    this.#length += length
    if (this.kind === 'text' && chunk.includes(0)) throw new UploadError('文件里有二进制内容，不像文本文件')
    if (this.kind === 'office') {
      const scan = this.#tail.length ? Buffer.concat([this.#tail, chunk]) : chunk
      if (MACROS.some((marker) => scan.includes(marker))) throw new UploadError('文档里带有宏（VBA），出于安全考虑不接受')
      this.#tail = Buffer.from(scan.subarray(Math.max(0, scan.length - MACRO_OVERLAP)))
    }
  }

  finish(): void {
    const data = this.#header.subarray(0, this.#length)
    switch (this.kind) {
      case 'office': {
        const modern = ['.docx', '.xlsx', '.pptx'].includes(this.ext)
        if (!(modern ? startsWith(data, ...ZIP) : startsWith(data, OLE))) {
          throw new UploadError('文件内容不是 Office 文档，扩展名和内容不符')
        }
        break
      }
      case 'zip':
        if (!startsWith(data, ...ZIP)) throw new UploadError('文件内容不是 zip 压缩包')
        break
      case 'image':
        if (!imageMatches(this.ext, data)) throw new UploadError('文件内容不是这种图片，扩展名和内容不符')
        break
      case 'pdf':
        if (!/^%PDF-(?:1\.[0-9]|2\.0)/.test(data.subarray(0, 8).toString('latin1'))) throw new UploadError('文件内容不是 PDF 文档')
        break
      case 'video':
        if (!videoMatches(this.ext, data)) throw new UploadError('文件内容不是这种视频，扩展名和内容不符')
        break
      case 'text':
        break // Checked in every chunk, including non-UTF-8 text such as GBK.
    }
  }
}

function imageMatches(ext: string, data: Buffer): boolean {
  switch (ext) {
    case '.jpg':
    case '.jpeg': return startsWith(data, Buffer.from([0xff, 0xd8, 0xff]))
    case '.png': return startsWith(data, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case '.gif': return startsWith(data, Buffer.from('GIF87a'), Buffer.from('GIF89a'))
    case '.webp': return riff(data, 'WEBP')
    default: return false
  }
}

function videoMatches(ext: string, data: Buffer): boolean {
  switch (ext) {
    case '.avi': return riff(data, 'AVI ')
    case '.mpeg':
    case '.mpg': return startsWith(data, Buffer.from([0, 0, 1, 0xba]), Buffer.from([0, 0, 1, 0xb3]))
    case '.ogv': return startsWith(data, Buffer.from('OggS\x00', 'latin1')) && data.includes(Buffer.from('\x80theora', 'latin1'))
    case '.webm': return ebmlDocType(data) === 'webm'
    case '.mkv': return ebmlDocType(data) === 'matroska'
    default: return isoVideoMatches(ext, data)
  }
}

function riff(data: Buffer, format: string): boolean {
  return data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === format
}

function isoVideoMatches(ext: string, data: Buffer): boolean {
  if (data.length < 8) return false
  const atom = data.toString('latin1', 4, 8)
  // Older QuickTime files can predate ftyp entirely.
  if (atom !== 'ftyp') return ext === '.mov' && data.readUInt32BE(0) >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(atom)
  if (data.length < 16 || data.readUInt32BE(0) < 16) return false
  const brands = [data.toString('latin1', 8, 12)]
  for (let at = 16; at + 4 <= Math.min(data.readUInt32BE(0), data.length); at += 4) brands.push(data.toString('latin1', at, at + 4))
  // Do not mistake HEIF/AVIF images or an audio-only MP4 brand for a video.
  if (/^(?:avi[fs]|hei[cfxs]|hev[cx]|mi[fs]1|M4[ABP] )$/.test(brands[0]!)) return false
  if (ext === '.mov') return brands.includes('qt  ')
  if (ext === '.3gp') return brands.some((brand) => /^3g[persg]/.test(brand))
  if (ext === '.3g2') return brands.some((brand) => /^3g2/.test(brand))
  return brands.some((brand) => /^(?:isom|iso[2-9]|mp4[12]|avc[12]|M4V[ HP]|MSNV|dash|cmf[cs]|F4V |av01)$/.test(brand))
}

/** DocType inside an EBML header distinguishes WebM from Matroska. */
function ebmlDocType(data: Buffer): string | null {
  if (!startsWith(data, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return null
  const at = data.indexOf(Buffer.from([0x42, 0x82]), 4)
  if (at < 0 || at + 2 >= data.length) return null
  let bytes = 1
  while (bytes <= 8 && !(data[at + 2]! & (0x80 >> (bytes - 1)))) bytes++
  if (bytes > 8 || at + 2 + bytes > data.length) return null
  let length = data[at + 2]! & (0xff >> bytes)
  for (let index = 1; index < bytes; index++) length = length * 256 + data[at + 2 + index]!
  const start = at + 2 + bytes
  return length <= 8 && start + length <= data.length ? data.toString('ascii', start, start + length) : null
}

function startsWith(data: Buffer, ...signatures: Buffer[]): boolean {
  return signatures.some((signature) => data.subarray(0, signature.length).equals(signature))
}

/** Create only a real upload directory; wx never follows a planted .gitignore. */
async function uploadDir(cwd: string): Promise<string> {
  const dir = join(cwd, UPLOAD_DIR)
  const created = await mkdir(dir, { mode: 0o755 }).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return false
    throw error
  })
  await assertDirectory(dir) // Recheck even after a concurrent mkdir/EEXIST.
  if (created) {
    await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o644 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  return dir
}

async function assertDirectory(dir: string): Promise<void> {
  if (!(await lstat(dir)).isDirectory()) throw new UploadError(`${UPLOAD_DIR} 不是普通目录（可能是文件或符号链接），拒绝写入`)
}

async function usedBytes(dir: string, temporary: Set<string>): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || temporary.has(entry.name)) continue
    const info = await lstat(join(dir, entry.name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info?.isFile()) total += info.size
  }
  return total
}

async function remove(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}
