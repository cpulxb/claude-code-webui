import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import type { ScmFile, ScmStatus } from '@ccw/shared'

const execFileAsync = promisify(execFile)

/** `git hash-object -t tree /dev/null` — the diff base while HEAD is unborn. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * Which repository answers for a directory: the directory's own, or the
 * shadow repo tracking it (`--git-dir` under ~/.ccw, work tree pointed back
 * at the directory).
 *
 * `prefix` is the cwd's own path inside the work tree (`''` at the root, a
 * trailing slash otherwise) — what turns the repo-root-relative paths git
 * prints into the cwd-relative form the panel speaks.
 */
export type GitContext = { cwd: string; gitDir?: string; prefix: string }

export async function git(
  ctx: GitContext,
  args: string[],
  options?: { timeout?: number; env?: Record<string, string> },
): Promise<string> {
  // The subprocess cwd is the work tree in both modes, so relative pathspecs
  // (`-- <file>`) resolve identically — `--work-tree` alone would not do
  // that, since pathspecs follow the process cwd.
  const prefix = ctx.gitDir ? ['--git-dir', ctx.gitDir, '--work-tree', ctx.cwd] : []
  const { stdout } = await execFileAsync('git', [...prefix, ...args], {
    cwd: ctx.cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options?.env },
    ...(options?.timeout ? { timeout: options.timeout } : {}),
  })
  return stdout
}

/** Where `cwd` sits inside the repo owning it, null when there is none. */
async function repoPrefix(cwd: string): Promise<string | null> {
  try {
    // `--show-prefix` rather than the `--show-toplevel` path: that one is the
    // repo's *physical* root, so a cwd reached through a symlink never matches
    // it. The prefix is relative and needs no realpath. The toplevel line is
    // still asked for, as the "is there a work tree at all" gate — inside a
    // bare repo it fails outright, while `--show-prefix` alone would answer
    // `''` and claim the git dir as a work tree.
    // Also null when git itself is missing — the panel treats both the same.
    const lines = (await git({ cwd, prefix: '' }, ['rev-parse', '--show-toplevel', '--show-prefix'])).split('\n')
    if (!lines[0]) return null
    return lines[1] ?? ''
  } catch {
    return null
  }
}

/** A real repository always wins over a shadow that predates it. */
export async function contextFor(cwd: string): Promise<GitContext | null> {
  const prefix = await repoPrefix(cwd)
  if (prefix !== null) return { cwd, prefix }
  if (await hasShadow(cwd)) return { cwd, gitDir: shadowGitDir(cwd), prefix: '' }
  return null
}

/**
 * The RPC accepts any relative path, so it must not escape the workspace —
 * `..` in a discard request would otherwise delete files outside it.
 */
export function resolveInside(cwd: string, path: string): string {
  const root = resolve(cwd)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`path escapes workspace: ${path}`)
  }
  return target
}

/** HEAD when it exists, the empty tree before the first commit. */
export async function diffBase(ctx: GitContext): Promise<string> {
  try {
    await git(ctx, ['rev-parse', '-q', '--verify', 'HEAD'])
    return 'HEAD'
  } catch {
    return EMPTY_TREE
  }
}

export async function scmStatus(cwd: string): Promise<ScmStatus> {
  const ctx = await contextFor(cwd)
  if (!ctx) return { kind: 'none' }
  if (ctx.gitDir) return { kind: 'shadow', files: await changedFiles(ctx) }

  const [branch, files] = await Promise.all([currentBranch(ctx), changedFiles(ctx)])
  return { kind: 'git', branch, files }
}

async function currentBranch(ctx: GitContext): Promise<string | null> {
  try {
    // Works on an unborn branch too, where `rev-parse --abbrev-ref` fails.
    return (await git(ctx, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null
  } catch {
    try {
      // Detached HEAD: show the commit instead of a branch name.
      return (await git(ctx, ['rev-parse', '--short', 'HEAD'])).trim()
    } catch {
      return null
    }
  }
}

/**
 * @param scope `workspace` limits the listing to the cwd subtree (what the
 *   panel shows); `repo` covers the whole repository. A pathspec makes git
 *   drop the half of a rename that falls outside it, which turns `R old new`
 *   into a bare `A new` — so anything that acts on an entry must read it at
 *   `repo` scope to see the real pairing.
 */
async function changedFiles(ctx: GitContext, scope: 'workspace' | 'repo' = 'workspace'): Promise<ScmFile[]> {
  // -z output: `XY <path>\0` per entry, with a second NUL-terminated field
  // (the ORIGINAL path) appended for renames/copies.
  // Porcelain paths are repo-root relative, so `toWorkspace` restores the
  // cwd-relative form every other command here expects.
  const raw = await git(ctx, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
    ...(scope === 'workspace' ? ['--', '.'] : []),
  ])
  const fields = raw.split('\0')
  const files: ScmFile[] = []

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field || field.length < 4) continue
    const xy = field.slice(0, 2)
    const path = toWorkspace(ctx, field.slice(3))
    if (xy === 'R ' || xy === ' R' || xy[0] === 'R' || xy[1] === 'R') {
      const oldPath = fields[++i]
      files.push({ path, status: 'renamed', oldPath: oldPath ? toWorkspace(ctx, oldPath) : '' })
      continue
    }
    files.push({ path, status: classify(xy) })
  }

  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return files
}

/** Repo-root-relative porcelain path → path relative to the workspace cwd. */
function toWorkspace(ctx: GitContext, path: string): string {
  if (!ctx.prefix) return path
  // Both sides are repo-root relative, so this is pure string arithmetic:
  // `relative` resolves them against one and the same base, and no physical
  // path is involved to disagree with the cwd's spelling.
  return relative(ctx.prefix, path)
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
  const ctx = await contextFor(cwd)
  if (!ctx) throw new Error(`nothing tracks this directory: ${cwd}`)

  // A failing `git diff` is not "no changes": letting it through would render
  // the whole file as an addition via the untracked fallback below.
  const base = await diffBase(ctx)
  const diff = (await git(ctx, ['diff', base, '--', path])) || (await untrackedDiff(ctx, path))
  return { diff, binary: isBinaryDiff(diff) }
}

/**
 * Untracked files are invisible to a base diff; `--no-index` against
 * /dev/null renders them as a pure addition.
 */
export async function untrackedDiff(ctx: GitContext, path: string): Promise<string> {
  // Exit code 1 means "differs", which execFile reports as an error carrying
  // the stdout we want.
  try {
    return await git(ctx, ['diff', '--no-index', '--', '/dev/null', path])
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    if (typeof stdout !== 'string' || !stdout) throw error
    return stdout
  }
}

export function isBinaryDiff(diff: string): boolean {
  return /^Binary files .* differ$/m.test(diff)
}

export async function scmDiscard(cwd: string, path: string): Promise<void> {
  const target = resolveInside(cwd, path)
  const ctx = await contextFor(cwd)
  if (!ctx) throw new Error(`nothing tracks this directory: ${cwd}`)

  // Repo scope on purpose: a rename is only visible as one when both of its
  // names are in the listing (see `changedFiles`).
  const files = await changedFiles(ctx, 'repo')
  // A rename out of cwd is listed in the panel as deletion of its old name.
  // Prefer an exact destination match in case that old name was reused.
  const entry = files.find((file) => file.path === path)
    ?? files.find((file) => file.status === 'renamed' && file.oldPath === path)
  if (!entry) return

  if (entry.status === 'untracked') {
    await rm(target, { force: true })
    return
  }

  const base = await diffBase(ctx)
  if (entry.status === 'renamed') {
    if (!entry.oldPath) throw new Error(`cannot discard ${path}: its original name is unknown`)
    // Both names must be inside cwd before either the index or worktree is
    // touched, whether the panel supplied the original or destination name.
    const renamedTarget = resolveInside(cwd, entry.path)
    resolveInside(cwd, entry.oldPath)
    // Restore the original name first. The steps below are not atomic, so the
    // order is chosen for the least damaging failure: if anything after this
    // throws, the old file is already back and only the new one is left over.
    await git(ctx, ['restore', `--source=${base}`, '--staged', '--worktree', '--', entry.oldPath])
    // The new name has no counterpart in the base tree, so only
    // `restore --staged` can drop it from the index.
    await git(ctx, ['restore', '--staged', `--source=${base}`, '--', entry.path])
    await rm(renamedTarget, { force: true })
    return
  }

  if (entry.status === 'added') {
    // Nothing to restore from: drop the index entry, then the file itself.
    await git(ctx, ['restore', '--staged', `--source=${base}`, '--', path])
    await rm(target, { force: true })
    return
  }

  // Restores index and worktree from the base tree; also resurrects deletions.
  await git(ctx, ['checkout', base, '--', path])
}

/* --- shadow repo: diffs for directories that are not git repos ----------- */

/**
 * VS Code-Timeline-style external repository. The tracked directory never
 * gains a `.git`, and a real repo created there later simply takes
 * precedence in `contextFor`.
 */
function shadowGitDir(cwd: string): string {
  const hash = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
  return join(homedir(), '.ccw', 'shadow', hash)
}

async function hasShadow(cwd: string): Promise<boolean> {
  try {
    await access(join(shadowGitDir(cwd), 'HEAD'))
    return true
  } catch {
    return false
  }
}

/**
 * What a baseline must not swallow. Claude writes through Bash as much as
 * through Edit, so the net is wide; users can extend `<git-dir>/info/exclude`
 * by hand for anything project-specific.
 */
const SHADOW_EXCLUDES = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  '.nuxt/',
  '.cache/',
  '.turbo/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'target/',
  '.pnpm-store/',
  '.claude/',
  '.nvm/',
  '.npm/',
  '.local/',
  '.vscode-server/',
  '.DS_Store',
  '*.log',
]

/**
 * Creates the shadow repo on first call, then (re)commits the working tree as
 * the baseline the panel diffs against. Calling it again is "重置基线": the
 * current state becomes the new clean point.
 */
export async function shadowBaseline(cwd: string): Promise<void> {
  const gitDir = shadowGitDir(cwd)
  const ctx: GitContext = { cwd, gitDir, prefix: '' }

  if (!(await hasShadow(cwd))) {
    await mkdir(gitDir, { recursive: true })
    // Bare + explicit --work-tree is the dotfiles pattern: every worktree
    // command works, and the tracked directory stays untouched.
    await execFileAsync('git', ['init', '--quiet', '--bare', gitDir])
    await writeFile(join(gitDir, 'info', 'exclude'), SHADOW_EXCLUDES.join('\n') + '\n')
  }

  await git(ctx, ['add', '-A'])
  await git(ctx, [
    '-c',
    'user.email=ccw@localhost',
    '-c',
    'user.name=ccw',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'baseline',
  ])
}
