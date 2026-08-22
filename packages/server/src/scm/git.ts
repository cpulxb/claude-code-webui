import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import type { ScmFile, ScmStatus } from '@ccw/shared'

const execFileAsync = promisify(execFile)

/** `git hash-object -t tree /dev/null` — the diff base while HEAD is unborn. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * Which repository answers for a directory: the directory's own, or the
 * shadow repo tracking it (`--git-dir` under ~/.ccw, work tree pointed back
 * at the directory).
 */
type GitContext = { cwd: string; gitDir?: string }

async function git(ctx: GitContext, args: string[]): Promise<string> {
  // The subprocess cwd is the work tree in both modes, so relative pathspecs
  // (`-- <file>`) resolve identically — `--work-tree` alone would not do
  // that, since pathspecs follow the process cwd.
  const prefix = ctx.gitDir ? ['--git-dir', ctx.gitDir, '--work-tree', ctx.cwd] : []
  const { stdout } = await execFileAsync('git', [...prefix, ...args], {
    cwd: ctx.cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  return stdout
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    // Also false when git itself is missing — the panel treats both the same.
    return (await git({ cwd }, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

/** A real repository always wins over a shadow that predates it. */
async function contextFor(cwd: string): Promise<GitContext | null> {
  if (await isGitRepo(cwd)) return { cwd }
  if (await hasShadow(cwd)) return { cwd, gitDir: shadowGitDir(cwd) }
  return null
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
async function diffBase(ctx: GitContext): Promise<string> {
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

async function changedFiles(ctx: GitContext): Promise<ScmFile[]> {
  // -z output: `XY <path>\0` per entry, with a second NUL-terminated field
  // (the ORIGINAL path) appended for renames/copies.
  const raw = await git(ctx, ['status', '--porcelain', '-z', '--untracked-files=all'])
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
  const ctx = await contextFor(cwd)
  if (!ctx) throw new Error(`nothing tracks this directory: ${cwd}`)

  let diff: string
  try {
    const base = await diffBase(ctx)
    diff = await git(ctx, ['diff', base, '--', path])
  } catch {
    diff = ''
  }
  if (!diff) {
    // Untracked files are invisible to a base diff; `--no-index` against
    // /dev/null renders them as a pure addition. Exit code 1 means "differs",
    // which execFile reports as an error carrying the stdout we want.
    try {
      diff = await git(ctx, ['diff', '--no-index', '--', '/dev/null', path])
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
  const ctx = await contextFor(cwd)
  if (!ctx) throw new Error(`nothing tracks this directory: ${cwd}`)

  const raw = await git(ctx, ['status', '--porcelain', '-z', '--', path])
  const entry = raw.split('\0')[0] ?? ''
  if (!entry) return

  if (entry.startsWith('??')) {
    await rm(target, { force: true })
    return
  }

  const base = await diffBase(ctx)
  if (entry[0] === 'R') {
    // Restore the original and drop the new name — checkout alone cannot,
    // since the new path does not exist in the base tree.
    const oldPath = raw.split('\0')[1]
    if (oldPath) await git(ctx, ['checkout', base, '--', oldPath])
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
  const ctx: GitContext = { cwd, gitDir }

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
