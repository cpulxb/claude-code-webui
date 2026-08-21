import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { DirectoryEntry, DirectoryListing } from '@ccw/shared'

/**
 * Lists real directories for the workspace picker.
 *
 * Only directories are returned — a session's cwd is always a directory, so
 * showing files would just be noise to scroll past.
 */
export async function browseDirectory(path: string | undefined, showHidden: boolean): Promise<DirectoryListing> {
  const home = homedir()
  const target = resolve(path && path.trim() ? path : home)

  const dirents = await readdir(target, { withFileTypes: true })
  const entries: DirectoryEntry[] = []

  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith('.')) continue

    const full = join(target, dirent.name)
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: full })
    } else if (dirent.isSymbolicLink()) {
      // `isDirectory()` is false for symlinks, but a linked directory is a
      // perfectly good workspace — resolve it, and skip broken links.
      try {
        if ((await stat(full)).isDirectory()) entries.push({ name: dirent.name, path: full })
      } catch {
        // Dangling symlink: not selectable, so leave it out.
      }
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))

  const parent = dirname(target)
  return { path: target, parent: parent === target ? null : parent, entries, home }
}
