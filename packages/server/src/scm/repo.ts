import { rm } from 'node:fs/promises'
import { relative } from 'node:path'

import type { ScmBranch, ScmCommit, ScmFile, ScmRef, ScmRepo, ScmSyncAction } from '@ccw/shared'

import {
  contextFor,
  diffBase,
  git,
  isBinaryDiff,
  resolveInside,
  untrackedDiff,
  type GitContext,
} from './git.ts'

/**
 * The 源代码管理 tab: staging, commits, history, branches and remote sync for
 * the real repository owning a workspace. Shadow repos are left to the 详情
 * section — there is nothing to commit or push there.
 *
 * Anything naming files stays inside the workspace subtree, as `git.ts` does:
 * the workspace is the boundary the file RPCs guard, and a repo whose root
 * sits above it (a dotfiles repo at `~`, say) must not hand out the rest.
 * Commits, branches and remotes are repo-wide by nature and act as git does.
 */

/** Commits per `scm.log` page. */
const LOG_PAGE = 50

/** How long fetch, pull and push get before they are killed. */
const NETWORK_TIMEOUT_MS = 120_000

/**
 * Nobody can answer a credentials prompt from here, so one fails at once
 * instead of hanging the request until the timeout.
 */
const NETWORK_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
}

async function requireRepo(cwd: string): Promise<GitContext> {
  const ctx = await contextFor(cwd)
  if (!ctx || ctx.gitDir) throw new Error(`not a git repository: ${cwd}`)
  return ctx
}

/**
 * git, failing with git's own complaint rather than "Command failed: git …",
 * minus the `hint:` lines that only make sense at a terminal.
 */
async function run(
  ctx: GitContext,
  args: string[],
  options?: { timeout?: number; env?: Record<string, string> },
): Promise<string> {
  try {
    return await git(ctx, args, options)
  } catch (error) {
    if ((error as { killed?: boolean }).killed) throw new Error(`git ${args[0]} timed out`)
    const stderr = (error as { stderr?: unknown }).stderr
    const complaint =
      typeof stderr === 'string'
        ? stderr
            .split('\n')
            .filter((line) => !line.startsWith('hint:'))
            .join('\n')
            .trim()
        : ''
    throw new Error(complaint || (error as Error).message)
  }
}

/** Every path a request names must stay inside the workspace. */
function checkPaths(cwd: string, paths: string[]): void {
  if (paths.length === 0) throw new Error('no paths given')
  for (const path of paths) resolveInside(cwd, path)
}

/** A hash goes onto git's command line, so it must not read as an option. */
function checkHash(hash: string): void {
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error(`not a commit hash: ${hash}`)
}

/** git's one-letter change codes; copies show up as additions. */
function changeStatus(letter: string): ScmFile['status'] {
  switch (letter[0]) {
    case 'A':
    case 'C':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    default:
      return 'modified'
  }
}

/* --- status ------------------------------------------------------------- */

export async function scmRepo(cwd: string): Promise<ScmRepo | null> {
  const ctx = await contextFor(cwd)
  if (!ctx || ctx.gitDir) return null

  // Repo-wide on purpose: the staged entries outside the workspace still go
  // into a commit, so they are counted even though they are not listed.
  const [raw, remotes, root] = await Promise.all([
    run(ctx, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    run(ctx, ['remote']),
    ctx.prefix ? run(ctx, ['rev-parse', '--show-toplevel']) : Promise.resolve(''),
  ])

  const repo: ScmRepo = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: remotes.trim() !== '',
    staged: [],
    unstaged: [],
    stagedOutside: 0,
    root: root.trim() || null,
  }

  // Porcelain v2 paths are repo-root relative. Every field before the path is
  // free of spaces, so the path is whatever follows the fixed token count.
  const inside = (path: string): boolean => !ctx.prefix || path.startsWith(ctx.prefix)
  // A rename's other half can sit outside, which comes out as `../…`.
  const local = (path: string): string => (ctx.prefix ? relative(ctx.prefix, path) : path)
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.startsWith('# ')) {
      const [key, ...rest] = field.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid' && value !== '(initial)') repo.head = value.slice(0, 7)
      else if (key === 'branch.head' && value !== '(detached)') repo.branch = value
      else if (key === 'branch.upstream') repo.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          repo.ahead = Number(match[1])
          repo.behind = Number(match[2])
        }
      }
      continue
    }

    const tokens = field.split(' ')
    const kind = tokens[0]
    if (kind === '?') {
      const path = field.slice(2)
      if (inside(path)) repo.unstaged.push({ path: local(path), status: 'untracked' })
      continue
    }
    if (kind === 'u') {
      const path = tokens.slice(10).join(' ')
      if (inside(path)) repo.unstaged.push({ path: local(path), status: 'conflicted' })
      continue
    }
    if (kind !== '1' && kind !== '2') continue

    // `.` marks the side that did not change: X is the index, Y the work tree.
    const [x, y] = [tokens[1]![0]!, tokens[1]![1]!]
    const path = tokens.slice(kind === '2' ? 9 : 8).join(' ')
    // A rename carries its original name as the next NUL-separated field.
    const oldPath = kind === '2' ? fields[++i] : undefined
    if (!inside(path)) {
      if (x !== '.') repo.stagedOutside++
      continue
    }
    if (x !== '.') {
      const status = changeStatus(x)
      repo.staged.push({
        path: local(path),
        status,
        ...(status === 'renamed' && oldPath !== undefined ? { oldPath: local(oldPath) } : {}),
      })
    }
    if (y !== '.') repo.unstaged.push({ path: local(path), status: changeStatus(y) })
  }

  repo.staged.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  repo.unstaged.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return repo
}

export async function scmChangeDiff(
  cwd: string,
  path: string,
  staged: boolean,
  oldPath?: string,
): Promise<{ diff: string; binary: boolean }> {
  checkPaths(cwd, oldPath ? [path, oldPath] : [path])
  const ctx = await requireRepo(cwd)
  let diff: string
  if (staged) {
    // Without HEAD, `--cached` shows everything staged as added, which is right.
    diff = await run(ctx, ['diff', '--cached', '-M', '--', path, ...(oldPath ? [oldPath] : [])])
  } else {
    diff = (await run(ctx, ['diff', '--', path])) || (await untrackedDiff(ctx, path))
  }
  return { diff, binary: isBinaryDiff(diff) }
}

/* --- staging and committing --------------------------------------------- */

export async function scmStage(cwd: string, paths: string[]): Promise<void> {
  checkPaths(cwd, paths)
  // `-A` stages deletions too.
  await run(await requireRepo(cwd), ['add', '-A', '--', ...paths])
}

export async function scmUnstage(cwd: string, paths: string[]): Promise<void> {
  checkPaths(cwd, paths)
  const ctx = await requireRepo(cwd)
  // From the empty tree while HEAD is unborn, which drops the entries.
  const base = await diffBase(ctx)
  await run(ctx, ['restore', '--staged', `--source=${base}`, '--', ...paths])
}

/**
 * Discards work-tree changes only: tracked files go back to their staged
 * content, so a partly staged file keeps what was staged. Untracked files
 * have nothing to go back to and are deleted.
 */
export async function scmRestore(cwd: string, paths: string[]): Promise<void> {
  checkPaths(cwd, paths)
  const ctx = await requireRepo(cwd)
  // Asked of git rather than taken from the request: which files get deleted
  // must not depend on what the client claims is untracked.
  const known = new Set((await run(ctx, ['ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean))
  const tracked = paths.filter((path) => known.has(path))
  const untracked = paths.filter((path) => !known.has(path))
  if (tracked.length > 0) await run(ctx, ['restore', '--worktree', '--', ...tracked])
  for (const path of untracked) await rm(resolveInside(cwd, path), { force: true })
}

export async function scmCommit(cwd: string, message: string, stageAll: boolean): Promise<string> {
  if (!message.trim()) throw new Error('the commit message is empty')
  const ctx = await requireRepo(cwd)
  if (stageAll) await run(ctx, ['add', '-A', '--', '.'])
  // `-m` leaves no editor to wait for; hooks still run, as they would in a terminal.
  await run(ctx, ['commit', '--quiet', '-m', message])
  return (await run(ctx, ['rev-parse', '--short', 'HEAD'])).trim()
}

/* --- history ------------------------------------------------------------ */

const FIELD = '\x1f'
const RECORD = '\x1e'

export async function scmLog(cwd: string, skip: number): Promise<{ commits: ScmCommit[]; more: boolean }> {
  const ctx = await requireRepo(cwd)
  if ((await diffBase(ctx)) !== 'HEAD') return { commits: [], more: false }

  const raw = await run(ctx, [
    'log',
    '--decorate=full',
    `--format=%H${FIELD}%h${FIELD}%an${FIELD}%at${FIELD}%D${FIELD}%s${RECORD}`,
    `--skip=${Math.max(0, Math.floor(skip))}`,
    // One extra tells whether another page exists.
    '-n',
    String(LOG_PAGE + 1),
    // A pathspec at the repo root would only add history simplification.
    ...(ctx.prefix ? ['--', '.'] : []),
  ])

  const commits: ScmCommit[] = []
  for (const record of raw.split(RECORD)) {
    const [hash, shortHash, author, date, refs, subject] = record.replace(/^\n/, '').split(FIELD)
    if (!hash || subject === undefined) continue
    commits.push({
      hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      author: author ?? '',
      date: Number(date),
      subject,
      refs: parseRefs(refs ?? ''),
    })
  }
  return { commits: commits.slice(0, LOG_PAGE), more: commits.length > LOG_PAGE }
}

/** `%D` under `--decorate=full`, e.g. `HEAD -> refs/heads/main, tag: refs/tags/v1`. */
function parseRefs(decoration: string): ScmRef[] {
  const refs: ScmRef[] = []
  for (const part of decoration.split(', ')) {
    if (!part) continue
    if (part === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' })
    else if (part.startsWith('HEAD -> refs/heads/')) refs.push({ name: part.slice(19), kind: 'head' })
    else if (part.startsWith('refs/heads/')) refs.push({ name: part.slice(11), kind: 'branch' })
    else if (part.startsWith('tag: refs/tags/')) refs.push({ name: part.slice(15), kind: 'tag' })
    // `origin/HEAD` only repeats where the remote's default branch is.
    else if (part.startsWith('refs/remotes/') && !part.endsWith('/HEAD')) {
      refs.push({ name: part.slice(13), kind: 'remote' })
    }
  }
  return refs
}

/**
 * Shared by the file list and the per-file diff. A merge is shown against its
 * first parent — what the merge brought in — and `--relative` both keeps the
 * listing to the workspace and prints paths relative to it.
 */
const SHOW_ARGS = ['show', '--format=', '-M', '--diff-merges=first-parent', '--relative']

export async function scmShow(cwd: string, hash: string): Promise<{ body: string; files: ScmFile[] }> {
  checkHash(hash)
  const ctx = await requireRepo(cwd)
  const [body, raw] = await Promise.all([
    run(ctx, ['show', '-s', '--format=%b', hash]),
    run(ctx, [...SHOW_ARGS, '--name-status', '-z', hash]),
  ])

  // `-z` name-status: the status, then one path — two for a rename or copy.
  const fields = raw.split('\0')
  const files: ScmFile[] = []
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]
    if (!code) continue
    const status = changeStatus(code)
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = fields[++i] ?? ''
      const path = fields[++i] ?? ''
      files.push(status === 'renamed' ? { path, status, oldPath } : { path, status })
    } else {
      files.push({ path: fields[++i] ?? '', status })
    }
  }
  return { body: body.trim(), files }
}

export async function scmShowDiff(
  cwd: string,
  hash: string,
  path: string,
  oldPath?: string,
): Promise<{ diff: string; binary: boolean }> {
  checkHash(hash)
  checkPaths(cwd, oldPath ? [path, oldPath] : [path])
  const ctx = await requireRepo(cwd)
  // Both names in the pathspec, or the rename splits into a delete and an add.
  const diff = await run(ctx, [...SHOW_ARGS, '-p', hash, '--', path, ...(oldPath ? [oldPath] : [])])
  return { diff, binary: isBinaryDiff(diff) }
}

/* --- branches and remotes ----------------------------------------------- */

export async function scmBranches(cwd: string): Promise<ScmBranch[]> {
  const ctx = await requireRepo(cwd)
  const raw = await run(ctx, [
    'for-each-ref',
    `--format=%(refname)${FIELD}%(HEAD)${FIELD}%(upstream:short)${FIELD}%(upstream:track,nobracket)`,
    'refs/heads',
    'refs/remotes',
  ])

  const branches: ScmBranch[] = []
  for (const line of raw.split('\n')) {
    const [ref, head, upstream, track] = line.split(FIELD)
    if (!ref) continue
    const remote = ref.startsWith('refs/remotes/')
    if (remote && ref.endsWith('/HEAD')) continue
    branches.push({
      name: ref.slice(remote ? 13 : 11),
      remote,
      current: head === '*',
      upstream: upstream || null,
      ahead: Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0),
    })
  }
  return branches
}

export async function scmSwitch(cwd: string, name: string, mode: 'switch' | 'create' | 'track'): Promise<void> {
  // A leading dash would be read as an option, and `git switch -` means
  // "the previous branch" — neither is a name anyone typed on purpose.
  if (!name.trim() || name.startsWith('-')) throw new Error(`not a branch name: ${name}`)
  const ctx = await requireRepo(cwd)
  if (mode === 'create') {
    await run(ctx, ['check-ref-format', '--branch', name])
    await run(ctx, ['switch', '-c', name])
  } else if (mode === 'track') {
    await run(ctx, ['switch', '--track', name])
  } else if (mode === 'switch') {
    await run(ctx, ['switch', name])
  } else {
    throw new Error(`unknown switch mode: ${String(mode)}`)
  }
}

export async function scmSync(cwd: string, action: ScmSyncAction): Promise<void> {
  const ctx = await requireRepo(cwd)
  const options = { timeout: NETWORK_TIMEOUT_MS, env: NETWORK_ENV }
  if (action === 'fetch') {
    await run(ctx, ['fetch', '--prune'], options)
  } else if (action === 'pull') {
    // Fast-forward only: a merge or rebase can stop on conflicts, which
    // belong in a terminal rather than a button.
    await run(ctx, ['pull', '--ff-only'], options).catch((error: Error) => {
      if (/Not possible to fast-forward/.test(error.message)) {
        throw new Error('本地和远程已经分叉，无法快进。请在终端里 merge 或 rebase。')
      }
      throw error
    })
  } else if (action === 'push') {
    const hasUpstream = await run(ctx, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).then(
      () => true,
      () => false,
    )
    if (hasUpstream) {
      await run(ctx, ['push'], options).catch((error: Error) => {
        if (/\[rejected\]/.test(error.message)) {
          throw new Error('推送被拒绝：远程有本地还没有的提交。先拉取（分叉时在终端里合并）再推送。')
        }
        throw error
      })
    } else {
      // First push of a branch: to `origin` when there is one, else the
      // only remote, and remember it as the upstream.
      const remotes = (await run(ctx, ['remote'])).split('\n').filter(Boolean)
      const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined
      if (!remote) throw new Error(remotes.length === 0 ? 'no remote to push to' : 'several remotes and no upstream set')
      await run(ctx, ['push', '-u', remote, 'HEAD'], options)
    }
  } else {
    // The wire is untyped: an unknown action must not fall through to a push.
    throw new Error(`unknown sync action: ${String(action)}`)
  }
}
