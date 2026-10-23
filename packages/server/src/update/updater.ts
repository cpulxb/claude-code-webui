import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { UpdateProgress, UpdateStatus, UpdateStep } from '@ccw/shared'

const execFileAsync = promisify(execFile)

/** The checkout this server runs from. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

const CHECK_INTERVAL_MS = 60 * 60 * 1000
const GIT_TIMEOUT_MS = 60_000
const STEP_TIMEOUT_MS = 10 * 60_000
/** `vX.Y.Z` only: pre-release tags are never offered. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/

export type UpdateCommand = { step: UpdateStep; command: string; args: string[] }

/** What a merged release still needs: its dependencies, and the UI bundle when this server serves one. */
export function installCommands(buildWeb: boolean): UpdateCommand[] {
  return [
    { step: 'install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
    ...(buildWeb ? [{ step: 'build' as const, command: 'pnpm', args: ['--filter', '@ccw/web', 'build'] }] : []),
  ]
}

/**
 * Finds newer releases of this checkout and installs one on request.
 *
 * Git rather than the GitHub API: it honours HTTPS_PROXY, which Node's fetch
 * ignores, has no anonymous rate limit, and works with any remote. A release
 * counts as new while HEAD does not contain its tag, not when its version is
 * higher — so a checkout that cut the release itself is never offered it, and
 * a tag that forgot to bump package.json is not offered forever.
 */
export class Updater {
  readonly #root: string | null
  readonly #commands: UpdateCommand[]
  readonly #restart: (() => void) | null
  readonly #subscribers = new Set<(status: UpdateStatus) => void>()
  #status: UpdateStatus
  #timer: NodeJS.Timeout | null = null
  #checking: Promise<void> | null = null

  constructor(options: {
    /** The git checkout to update; null, no release is ever found. */
    root: string | null
    current: string
    canApply: boolean
    /** Run after the merge, in order. */
    commands: UpdateCommand[]
    /** Brings the server back on the new code; null when nothing would start it again. */
    restart: (() => void) | null
  }) {
    this.#root = options.root
    this.#commands = options.commands
    this.#restart = options.restart
    this.#status = { current: options.current, latest: null, changes: [], canApply: options.canApply, progress: null }
  }

  /** The updater for the checkout this server runs from; inert when that is not a git clone. */
  static async open(options: { canApply: boolean; buildWeb: boolean; restart: (() => void) | null }): Promise<Updater> {
    const { version } = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
    return new Updater({
      root: (await isCheckoutRoot(REPO_ROOT)) ? REPO_ROOT : null,
      current: version,
      canApply: options.canApply,
      commands: installCommands(options.buildWeb),
      restart: options.restart,
    })
  }

  /** For servers that never update (tests, smoke runs). */
  static none(): Updater {
    return new Updater({ root: null, current: '0.0.0', canApply: false, commands: [], restart: null })
  }

  get enabled(): boolean {
    return this.#root !== null
  }

  get status(): UpdateStatus {
    return this.#status
  }

  subscribe(handler: (status: UpdateStatus) => void): () => void {
    this.#subscribers.add(handler)
    return () => this.#subscribers.delete(handler)
  }

  /** Checks now, then hourly; those checks only log their failures. */
  start(): void {
    if (!this.#root || this.#timer) return
    const check = (): void => {
      this.check().catch((error: unknown) => console.warn(`[ccw] update check failed: ${describe(error)}`))
    }
    check()
    this.#timer = setInterval(check, CHECK_INTERVAL_MS)
    this.#timer.unref()
  }

  /**
   * Fetches the remote's release tags and recomputes `latest`. A check already
   * running — the hourly one, a click in another tab — is joined, not raced:
   * two fetches into one repository collide on its ref locks.
   */
  check(): Promise<void> {
    const root = this.#root
    if (!root) return Promise.reject(new Error('not a git checkout: there are no releases to check'))
    this.#checking ??= this.#fetch(root).finally(() => {
      this.#checking = null
    })
    return this.#checking
  }

  async #fetch(root: string): Promise<void> {
    if (this.#installing()) return
    try {
      await git(root, 'fetch', '--quiet', '--no-tags', 'origin', '+refs/tags/v*:refs/tags/v*')
      const tags = (await git(root, 'tag', '--list', 'v*', '--sort=-v:refname')).split('\n')
      const newest = tags.find((tag) => RELEASE_TAG.test(tag))
      let latest: string | null = null
      let changes: string[] = []
      if (newest && !(await contains(root, newest))) {
        latest = newest.slice(1)
        changes = (await git(root, 'log', '--no-merges', '--format=%s', `HEAD..refs/tags/${newest}`)).split('\n').filter(Boolean)
      }
      // An install that started while the fetch ran owns the status now; the
      // merge would otherwise read as "up to date" mid-install.
      if (this.#installing()) return
      this.#set({ ...this.#status, latest, changes })
    } catch (error) {
      // git's own words, not execFile's "Command failed: git fetch …" header.
      throw new Error(describe(error))
    }
  }

  /**
   * Starts installing `latest` and returns the status it starts with. A second
   * call while one runs — another tab clicking too — joins it.
   */
  apply(): UpdateStatus {
    const { latest, canApply, progress } = this.#status
    if (progress && progress.state !== 'failed') return this.#status
    if (!this.#root || !latest) throw new Error('no update available')
    if (!canApply) throw new Error('under pnpm dev, update with git pull and pnpm install')
    void this.#install(this.#root, `v${latest}`)
    return this.#status
  }

  async #install(root: string, tag: string): Promise<void> {
    // `^{commit}`: merging an annotated tag object would ask for a merge commit.
    const merge: UpdateCommand = { step: 'merge', command: 'git', args: ['merge', '--ff-only', '--quiet', `refs/tags/${tag}^{commit}`] }
    for (const { step, command, args } of [merge, ...this.#commands]) {
      if (step === 'install' && !(await dependenciesChanged(root))) continue
      this.#setProgress({ state: 'running', step })
      try {
        await run(command, args, root, STEP_TIMEOUT_MS)
      } catch (error) {
        const reason = describe(error)
        console.error(`[ccw] update to ${tag}: ${step} failed: ${reason}`)
        this.#setProgress({ state: 'failed', step, error: reason })
        return
      }
    }
    console.log(`[ccw] updated to ${tag}`)
    if (!this.#restart) {
      this.#setProgress({ state: 'restartRequired' })
      return
    }
    this.#setProgress({ state: 'restarting' })
    // Lets the frame above reach the sockets before shutdown cuts them.
    setTimeout(this.#restart, 500)
  }

  /** Once an install has started, the status describes it until the restart. */
  #installing(): boolean {
    return this.#status.progress !== null
  }

  #setProgress(progress: UpdateProgress): void {
    this.#set({ ...this.#status, progress })
  }

  #set(status: UpdateStatus): void {
    this.#status = status
    for (const handler of this.#subscribers) handler(status)
  }
}

/** True when `dir` is the top of its own repository, not a folder inside some other one. */
async function isCheckoutRoot(dir: string): Promise<boolean> {
  try {
    const top = (await git(dir, 'rev-parse', '--show-toplevel')).trim()
    return (await realpath(top)) === (await realpath(dir))
  } catch {
    return false
  }
}

async function contains(root: string, tag: string): Promise<boolean> {
  try {
    await git(root, 'merge-base', '--is-ancestor', `refs/tags/${tag}`, 'HEAD')
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false
    throw error
  }
}

/**
 * Whether the merge just made changes what pnpm installs; the merge left the
 * old HEAD in ORIG_HEAD. package.json alone does not count: a release bumps
 * every version field without touching a dependency, yet an install then
 * still rewrites node_modules/.pnpm/lock.yaml — which fails with EPERM where
 * the files carry a gid the user namespace cannot map. Any doubt (git
 * failing) runs the install.
 */
async function dependenciesChanged(root: string): Promise<boolean> {
  try {
    await git(root, 'diff', '--quiet', 'ORIG_HEAD', 'HEAD', '--', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')
    return false
  } catch {
    return true
  }
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return run('git', args, cwd, GIT_TIMEOUT_MS)
}

async function run(command: string, args: string[], cwd: string, timeout: number): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      // A remote that asks for credentials must fail, not wait on a prompt nobody sees.
      GIT_TERMINAL_PROMPT: '0',
      // Whether to install is decided above, from the lockfile. pnpm 11 left to
      // itself reruns the install before any script once package.json has
      // changed — and a release always bumps its version.
      pnpm_config_verify_deps_before_run: 'false',
    },
  })
  return stdout
}

/**
 * The tail of a failed command's output — where git and pnpm put the reason —
 * or the error itself. Git's `hint:` lines would crowd out its `fatal:` one,
 * and a crash's stack frames the message above them.
 */
function describe(error: unknown): string {
  const { stderr, stdout } = error as { stderr?: unknown; stdout?: unknown }
  for (const output of [stderr, stdout]) {
    if (typeof output !== 'string') continue
    const lines = output.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('hint:') && !/^\s+at /.test(line))
    if (lines.length > 0) return lines.slice(-4).join('\n')
  }
  return error instanceof Error ? error.message : String(error)
}
