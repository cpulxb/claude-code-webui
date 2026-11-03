import { lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { MAX_UPLOAD_BYTES, UPLOAD_DIR, uploadKind, type UploadKind } from '@ccw/shared'

/** All of a workspace's uploads together; past it the oldest have to be deleted by hand. */
export const MAX_UPLOAD_DIR_BYTES = 500 * 1024 * 1024
const MAX_STEM_LENGTH = 100
const MAX_NAME_TRIES = 1000

const ZIP = [Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('PK\x05\x06', 'latin1')]
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
/**
 * A VBA project inside an Office file. OOXML keeps it as `vbaProject.bin`,
 * whose name zip stores in plain ASCII; the legacy formats keep a
 * `_VBA_PROJECT` stream, named in UTF-16LE in the OLE directory.
 */
const MACROS = [Buffer.from('vbaProject.bin', 'latin1'), Buffer.from('_VBA_PROJECT', 'utf16le')]

/**
 * Saves a file the composer could not send inline into `<cwd>/upload/`, for
 * the prompt to reference as `@upload/<name>`. `cwd` must already be resolved
 * inside a workspace. Only the extensions in `UPLOAD_KINDS` are taken, and only
 * when the bytes look like that kind; the name is reduced to a safe basename
 * and never replaces an existing file. Returns the path relative to `cwd`.
 */
export async function saveUpload(cwd: string, filename: string, data: Buffer): Promise<{ path: string; size: number }> {
  const name = safeName(filename)
  const kind = uploadKind(name)
  if (!kind) throw new Error(`不支持上传这种文件：${extname(name) || '没有扩展名'}`)
  if (data.length === 0) throw new Error('文件是空的')
  if (data.length > MAX_UPLOAD_BYTES) throw new Error(`文件超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`)
  const problem = inspect(kind, data)
  if (problem) throw new Error(problem)

  const dir = await uploadDir(cwd)
  if ((await usedBytes(dir)) + data.length > MAX_UPLOAD_DIR_BYTES) {
    throw new Error(`${UPLOAD_DIR}/ 已超过 ${MAX_UPLOAD_DIR_BYTES / (1024 * 1024)} MB，请先清理旧文件`)
  }

  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let attempt = 0; attempt < MAX_NAME_TRIES; attempt++) {
    const candidate = attempt === 0 ? name : `${stem}-${attempt}${ext}`
    // `wx` is O_CREAT|O_EXCL: it never follows a symlink planted at the name,
    // and never overwrites a file — including an earlier upload.
    const handle = await open(join(dir, candidate), 'wx', 0o644).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return null
      throw error
    })
    if (!handle) continue
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    return { path: `${UPLOAD_DIR}/${candidate}`, size: data.length }
  }
  throw new Error('同名文件太多，请改个文件名再上传')
}

/**
 * The basename only, with nothing a shell, a `@` mention or a dotfile lookup
 * would read specially: no separators, control characters or whitespace, and
 * no leading dots, so `../../.bashrc` lands as `bashrc` inside the folder.
 */
export function safeName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*`$;&'!#%{}[\]^~]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^[.\-_]+/, '')
  const ext = extname(cleaned).toLowerCase()
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, MAX_STEM_LENGTH).replace(/[.\-_]+$/, '')
  return `${stem || 'file'}${ext}`
}

/** Why `data` is not the kind its extension claims, or null when it plausibly is. */
function inspect(kind: UploadKind, data: Buffer): string | null {
  switch (kind) {
    case 'office': {
      const zip = startsWith(data, ...ZIP)
      if (!zip && !startsWith(data, OLE)) return '文件内容不是 Office 文档，扩展名和内容不符'
      if (MACROS.some((marker) => data.includes(marker))) return '文档里带有宏（VBA），出于安全考虑不接受'
      return null
    }
    case 'zip':
      return startsWith(data, ...ZIP) ? null : '文件内容不是 zip 压缩包'
    case 'text':
      // Executables and other binaries are full of NUL bytes; text in any
      // single-byte or UTF-8 encoding (GBK CSVs included) has none.
      return data.includes(0) ? '文件里有二进制内容，不像文本文件' : null
  }
}

function startsWith(data: Buffer, ...signatures: Buffer[]): boolean {
  return signatures.some((signature) => data.subarray(0, signature.length).equals(signature))
}

/**
 * `<cwd>/upload`, created on first use with a `.gitignore` that keeps it out
 * of the repository. A symlink or a file in its place is refused: following
 * one would write wherever it points.
 */
async function uploadDir(cwd: string): Promise<string> {
  const dir = join(cwd, UPLOAD_DIR)
  const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info && !info.isDirectory()) throw new Error(`${UPLOAD_DIR} 不是普通目录（可能是文件或符号链接），拒绝写入`)
  if (!info) {
    await mkdir(dir, { mode: 0o755 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o644 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  return dir
}

async function usedBytes(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    total += (await lstat(join(dir, entry.name)).catch(() => null))?.size ?? 0
  }
  return total
}
