import { realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { listProjects } from '../history/sessions.ts'

/**
 * Path guard for the project-scoped file and SCM RPCs.
 *
 * `files.read` / `files.write` / `files.list` / `files.suggest` and the `scm.*`
 * methods all take an absolute path straight from the browser, so without a
 * containment check the RPC is an arbitrary file read, overwrite, or
 * `git restore` in any directory. Every legitimate caller works inside a
 * session's cwd, so that is the boundary: the cwds of the sessions this server
 * started, plus the ones already on disk under `~/.claude/projects` (a history
 * session can be browsed before it has a runner).
 *
 * Note this is still a process-wide union of workspaces, not a per-session
 * grant: the file RPC params carry no sessionId, so a request cannot be tied
 * back to the session it claims to act for. Narrowing further needs the
 * sessionId threaded through `@ccw/shared` and the web callers.
 */
const roots = new Set<string>()

const HOME = resolve(homedir())
const TMP = resolve(tmpdir())

/**
 * A cwd so coarse that accepting it would hand out every project on the
 * machine. `$HOME` and `/tmp` really do show up as history project cwds, and
 * registering either one collapses the guard into "anything under home".
 * Anything less than two path segments deep (`/`, `/root`, `/tmp`, `/home`) is
 * refused for the same reason.
 *
 * This only filters roots we discovered on our own by scanning the transcript
 * directory. A cwd the user picked in the UI is a deliberate choice -- working
 * directly in `~` is a normal thing to do -- so `trusted` registrations skip
 * the check, or the whole file panel would be dead for that session.
 */
function tooBroad(root: string): boolean {
  if (root === HOME || root === TMP) return true
  return root.split(sep).filter(Boolean).length < 2
}

export function registerRoot(cwd: string, options?: { trusted?: boolean }): void {
  if (!isAbsolute(cwd)) return
  const root = resolve(cwd)
  // `/` is never a workspace, however it got here.
  if (root === sep) return
  if (!options?.trusted && tooBroad(root)) return
  roots.add(root)
}

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

// A root can itself sit behind a symlink (`/root/Project` -> `/mnt/...`), in
// which case the resolved real path of a legitimate target does not match the
// root lexically. Compare against both spellings; realpath per root is cached
// because roots are long-lived directories.
const realRoots = new Map<string, string>()

async function realRoot(root: string): Promise<string> {
  const cached = realRoots.get(root)
  if (cached !== undefined) return cached
  const real = await realpath(root).catch(() => root)
  realRoots.set(root, real)
  return real
}

async function insideAnyRoot(target: string): Promise<boolean> {
  for (const root of roots) {
    if (contains(root, target) || contains(await realRoot(root), target)) return true
  }
  return false
}

/**
 * Resolves symlinks in `target`. The path need not exist — a tree row can be
 * stale, and `scm.diff` names files that were just deleted — so fall back to
 * the nearest existing ancestor and re-append the part that does not resolve.
 */
async function realpathTolerant(target: string): Promise<string> {
  let existing = target
  let trailing = ''
  for (;;) {
    try {
      return trailing ? join(await realpath(existing), trailing) : await realpath(existing)
    } catch {
      const parent = dirname(existing)
      // Nothing above resolves either; nothing left to check.
      if (parent === existing) return target
      trailing = trailing ? join(relative(parent, existing), trailing) : relative(parent, existing)
      existing = parent
    }
  }
}

// Re-reading the transcript directory picks up history projects this process
// never started, but it is a full directory scan and it only runs on a miss --
// which is exactly what an out-of-workspace request hits. So: a path that has
// never missed before gets scanned right away (a project created elsewhere a
// moment ago must not stay rejected for a whole interval), and once a path has
// had its scan it only gets another one every RESCAN_INTERVAL_MS. MIN_INTERVAL
// still applies to first misses so a probe walking distinct paths cannot turn
// every rejected request into a scan.
const RESCAN_INTERVAL_MS = 30_000
const MIN_RESCAN_INTERVAL_MS = 1_000
/** Cheap bound: the miss set is a throttling hint, not state worth keeping. */
const MAX_TRACKED_MISSES = 1024
let lastRescan = 0
let rescanning: Promise<void> | null = null
const scannedMisses = new Set<string>()

async function rescanHistoryProjects(target: string): Promise<void> {
  if (rescanning) return rescanning
  const firstMiss = !scannedMisses.has(target)
  const interval = firstMiss ? MIN_RESCAN_INTERVAL_MS : RESCAN_INTERVAL_MS
  if (Date.now() - lastRescan < interval) return
  if (scannedMisses.size >= MAX_TRACKED_MISSES) scannedMisses.clear()
  scannedMisses.add(target)
  rescanning = (async () => {
    try {
      for (const project of await listProjects(new Set())) registerRoot(project.cwd)
    } finally {
      lastRescan = Date.now()
      rescanning = null
    }
  })()
  return rescanning
}

/** Resolves `path` against the known workspaces, or throws if it escapes them. */
export async function resolveInWorkspace(path: string): Promise<string> {
  const target = resolve(path)

  let known = await insideAnyRoot(target)
  if (!known) {
    await rescanHistoryProjects(target)
    known = await insideAnyRoot(target)
  }

  // Lexical containment is not enough on its own: a symlink anywhere inside a
  // workspace (including one the agent just created) otherwise points the RPC
  // at any file on the machine. The cost is that a symlink deliberately
  // pointing outside the project is no longer readable through these RPCs.
  if (known) {
    const real = await realpathTolerant(target)
    if (real !== target) known = await insideAnyRoot(real)
  }

  // Deliberately vague: the caller already knows the path it sent, and echoing
  // it back turns rejections into a probe for what exists on disk.
  if (!known) throw new Error('path is outside every known workspace')

  return target
}
