import { open, readdir, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import type { FilePreview, TreeEntry } from '@ccw/shared'

/** Text previews stop here; the overlay says so rather than paging. */
const TEXT_CAP = 256 * 1024
/** Images above this are shown as "binary" instead of shipped as base64. */
const IMAGE_CAP = 4 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/**
 * One readdir level for the Explorer tree. Directories sort first, matching
 * every file manager the panel imitates. Only `.git` is hidden — the tree is
 * lazy, so even huge directories cost a single readdir when expanded.
 */
export async function listEntries(path: string): Promise<TreeEntry[]> {
  const dirents = await readdir(path, { withFileTypes: true })
  const entries: TreeEntry[] = []

  for (const dirent of dirents) {
    if (dirent.name === '.git') continue

    const full = join(path, dirent.name)
    let isDirectory = dirent.isDirectory()
    if (!isDirectory && dirent.isSymbolicLink()) {
      // A linked directory should expand like one; a dangling link stays a file row.
      try {
        isDirectory = (await stat(full)).isDirectory()
      } catch {
        // Dangling symlink.
      }
    }
    entries.push({ name: dirent.name, path: full, isDirectory })
  }

  entries.sort((a, b) =>
    a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name, 'en'),
  )
  return entries
}

/**
 * Bounded read for the preview overlay. A fixed-length `read` instead of
 * `readFile` keeps a multi-gigabyte log from being pulled into memory just to
 * show its first screenful.
 */
export async function readFilePreview(path: string): Promise<FilePreview> {
  const info = await stat(path)
  const size = info.size

  const mediaType = IMAGE_TYPES[extname(path).toLowerCase()]
  if (mediaType) {
    if (size > IMAGE_CAP) return { kind: 'binary', size }
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(size)
      await handle.read(buffer, 0, size, 0)
      return { kind: 'image', size, mediaType, data: buffer.toString('base64') }
    } finally {
      await handle.close()
    }
  }

  const handle = await open(path, 'r')
  try {
    const length = Math.min(size, TEXT_CAP)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    // git's own heuristic: a NUL in the first 8KB means "not text".
    if (buffer.subarray(0, 8192).includes(0)) return { kind: 'binary', size }
    return { kind: 'text', size, content: buffer.toString('utf8'), truncated: size > TEXT_CAP }
  } finally {
    await handle.close()
  }
}

/**
 * Whole-file save behind the editor tab. Only an existing regular file is
 * accepted: the tab was opened from the tree, so a miss means the file was
 * deleted or replaced since — surfacing that beats silently creating one.
 */
export async function writeTextFile(path: string, content: string): Promise<number> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`不是普通文件：${path}`)
  await writeFile(path, content, 'utf8')
  return Buffer.byteLength(content, 'utf8')
}
