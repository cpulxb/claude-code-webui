import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import type { ScmFile, ScmStatus } from '@ccw/shared'

const execFileAsync = promisify(execFile)

/** `git hash-object -t tree /dev/null` — the diff base while HEAD is unborn. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  return stdout
}

/**
 * The RPC accepts any relative path, so it must not escape the workspace —
 * `..` in a discard request would otherwise delete files outside it.
 */
function resolveInside(cwd: string, path: string): string {
  const root = resolve(cwd)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`path escapes workspace: ${path}`)
  }
  return target
}

/** HEAD when it exists, the empty tree before the first commit. */
async function diffBase(cwd: string): Promise<string> {
  try {
    await git(cwd, ['rev-parse', '-q', '--verify', 'HEAD'])
    return 'HEAD'
  } catch {
    return EMPTY_TREE
  }
}

export async function scmStatus(cwd: string): Promise<ScmStatus> {
  try {
    const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return { kind: 'none' }
  } catch {
    // Not a repository, or git itself is missing — the panel treats both as
    // "nothing to show here", not as an error.
    return { kind: 'none' }
  }

  const [branch, files] = await Promise.all([currentBranch(cwd), changedFiles(cwd)])
  return { kind: 'git', branch, files }
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    // Works on an unborn branch too, where `rev-parse --abbrev-ref` fails.
    return (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null
  } catch {
    try {
      // Detached HEAD: show the commit instead of a branch name.
      return (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
    } catch {
      return null
    }
  }
}

async function changedFiles(cwd: string): Promise<ScmFile[]> {
  // -z output: `XY <path>\0` per entry, with a second NUL-terminated field
  // (the ORIGINAL path) appended for renames/copies.
  const raw = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const fields = raw.split('\0')
  const files: ScmFile[] = []

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field || field.length < 4) continue
    const xy = field.slice(0, 2)
    const path = field.slice(3)
    if (xy === 'R ' || xy === ' R' || xy[0] === 'R' || xy[1] === 'R') {
      const oldPath = fields[++i] ?? ''
      files.push({ path, status: 'renamed', oldPath })
      continue
    }
    files.push({ path, status: classify(xy) })
  }

  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return files
}

function classify(xy: string): ScmFile['status'] {
  if (xy === '??') return 'untracked'
  // Both-sides states (AA, DD, and anything with U) are merge conflicts.
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflicted'
  if (xy.includes('D')) return 'deleted'
  if (xy.includes('A')) return 'added'
  return 'modified'
}

export async function scmDiff(cwd: string, path: string): Promise<{ diff: string; binary: boolean }> {
  resolveInside(cwd, path)

  let diff: string
  try {
    const base = await diffBase(cwd)
    diff = await git(cwd, ['diff', base, '--', path])
  } catch {
    diff = ''
  }
  if (!diff) {
    // Untracked files are invisible to a base diff; `--no-index` against
    // /dev/null renders them as a pure addition. Exit code 1 means "differs",
    // which execFile reports as an error carrying the stdout we want.
    try {
      diff = await git(cwd, ['diff', '--no-index', '--', '/dev/null', path])
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout
      if (typeof stdout !== 'string' || !stdout) throw error
      diff = stdout
    }
  }

  return { diff, binary: /^Binary files .* differ$/m.test(diff) }
}

export async function scmDiscard(cwd: string, path: string): Promise<void> {
  const target = resolveInside(cwd, path)

  const raw = await git(cwd, ['status', '--porcelain', '-z', '--', path])
  const entry = raw.split('\0')[0] ?? ''
  if (!entry) return

  if (entry.startsWith('??')) {
    await rm(target, { force: true })
    return
  }

  const base = await diffBase(cwd)
  if (entry[0] === 'R') {
    // Restore the original and drop the new name — checkout alone cannot,
    // since the new path does not exist in the base tree.
    const oldPath = raw.split('\0')[1]
    if (oldPath) await git(cwd, ['checkout', base, '--', oldPath])
    await rm(target, { force: true })
    return
  }

  // Restores index and worktree from the base tree; also resurrects deletions.
  await git(cwd, ['checkout', base, '--', path])
}
