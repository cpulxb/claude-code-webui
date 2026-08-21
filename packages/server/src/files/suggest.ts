import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { fuzzyFilter, type FileSuggestion } from '@ccw/shared'

/**
 * Backs the composer's `@` menu.
 *
 * The CLI has a `file_suggestions` control request internally, but the SDK's
 * `Query` interface does not expose it — so the scan lives here. Results are
 * cached per cwd because a menu keystroke must not re-walk the tree.
 */

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.turbo',
])

const MAX_ENTRIES = 20_000
const MAX_DEPTH = 12
const MAX_RESULTS = 30
const CACHE_TTL_MS = 10_000

type CacheEntry = { paths: FileSuggestion[]; expires: number }
const cache = new Map<string, CacheEntry>()

export async function suggestFiles(cwd: string, query: string): Promise<FileSuggestion[]> {
  const entries = await scan(cwd)
  if (query === '') return entries.slice(0, MAX_RESULTS)
  return fuzzyFilter(query, entries, (entry) => entry.path).slice(0, MAX_RESULTS)
}

async function scan(cwd: string): Promise<FileSuggestion[]> {
  const cached = cache.get(cwd)
  if (cached && cached.expires > Date.now()) return cached.paths

  const found: FileSuggestion[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }]

  while (queue.length > 0 && found.length < MAX_ENTRIES) {
    const { dir, depth } = queue.shift()!
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory (permissions, race with a delete) — skip it.
      continue
    }

    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') && dirent.name !== '.claude') continue
      if (dirent.isDirectory() && IGNORED_DIRS.has(dirent.name)) continue

      const full = join(dir, dirent.name)
      const rel = relative(cwd, full).split(sep).join('/')
      const isDirectory = dirent.isDirectory()
      found.push({ path: isDirectory ? `${rel}/` : rel, isDirectory })

      if (isDirectory && depth < MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 })
    }
  }

  cache.set(cwd, { paths: found, expires: Date.now() + CACHE_TTL_MS })
  return found
}
