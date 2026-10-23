import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import type { UpdateStatus } from '@ccw/shared'

import { Updater, type UpdateCommand } from '../src/update/updater.ts'

const exec = promisify(execFile)

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'core.hooksPath=/dev/null', '-c', 'tag.gpgSign=false']

/**
 * A bare `origin`, a `dev` clone that cuts releases, and an `install` clone
 * left at v0.1.0 — the deployment the updater runs in.
 */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccw-update-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = async (cwd: string, ...args: string[]) => (await exec('git', [...IDENTITY, ...args], { cwd })).stdout.trim()
  const dev = join(root, 'dev')
  const install = join(root, 'install')

  await git(root, 'init', '--quiet', '--bare', '-b', 'main', 'origin.git')
  await git(root, 'clone', '--quiet', join(root, 'origin.git'), dev)
  await git(dev, 'checkout', '--quiet', '-b', 'main')
  const release = async (version: string, subject: string): Promise<void> => {
    await writeFile(join(dev, 'package.json'), JSON.stringify({ version }))
    await git(dev, 'add', '.')
    await git(dev, 'commit', '--quiet', '--no-gpg-sign', '-m', subject)
    // Annotated, the way `git tag -a` and most release tooling cut them.
    await git(dev, 'tag', '-a', `v${version}`, '-m', `v${version}`)
    await git(dev, 'push', '--quiet', 'origin', 'main', `v${version}`)
  }
  await release('0.1.0', 'chore: first release')
  await git(root, 'clone', '--quiet', join(root, 'origin.git'), install)

  return { git, dev, install, release }
}

function updater(root: string, options: { commands?: UpdateCommand[]; restart?: (() => void) | null } = {}): Updater {
  return new Updater({ root, current: '0.1.0', canApply: true, commands: options.commands ?? [], restart: options.restart ?? null })
}

/** Resolves with the first status whose install has finished, one way or the other. */
function settled(updates: Updater): Promise<UpdateStatus> {
  return new Promise((resolve) => {
    const unsubscribe = updates.subscribe((status) => {
      if (status.progress && status.progress.state !== 'running') {
        unsubscribe()
        resolve(status)
      }
    })
  })
}

test('a newer release tag on origin is offered with the commits it brings', async (t) => {
  const { git, dev, install, release } = await fixture(t)
  await writeFile(join(dev, 'feature.txt'), 'new\n')
  await git(dev, 'add', '.')
  await git(dev, 'commit', '--quiet', '--no-gpg-sign', '-m', 'feat: a feature')
  await release('0.2.0', 'chore: release 0.2.0')
  // Neither a pre-release nor an untagged commit on main is a release.
  await git(dev, 'tag', 'v0.3.0-beta.1')
  await git(dev, 'commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'wip: unreleased')
  await git(dev, 'push', '--quiet', 'origin', 'main', 'v0.3.0-beta.1')

  const updates = updater(install)
  await updates.check()
  assert.equal(updates.status.latest, '0.2.0')
  assert.deepEqual(updates.status.changes, ['chore: release 0.2.0', 'feat: a feature'])
})

test('a checkout that already contains the newest tag is up to date', async (t) => {
  const { dev, release } = await fixture(t)
  await release('0.2.0', 'chore: release 0.2.0')
  const updates = updater(dev)
  await updates.check()
  assert.equal(updates.status.latest, null)
})

test('a check that cannot reach origin says why', async (t) => {
  const { git, install } = await fixture(t)
  await git(install, 'remote', 'set-url', 'origin', join(install, 'gone.git'))
  await assert.rejects(updater(install).check(), /Could not read from remote repository/)
  await assert.rejects(Updater.none().check(), /not a git checkout/)
})

test('a check started while one runs joins it', async (t) => {
  const { install, release } = await fixture(t)
  await release('0.2.0', 'chore: release 0.2.0')
  const updates = updater(install)
  const first = updates.check()
  assert.equal(updates.check(), first)
  await first
  assert.equal(updates.status.latest, '0.2.0')
})

test('apply fast-forwards to the tag, runs the install steps, then restarts', async (t) => {
  const { git, install, release } = await fixture(t)
  await release('0.2.0', 'chore: release 0.2.0')
  let restarted = false
  const updates = updater(install, {
    commands: [{ step: 'install', command: 'git', args: ['status', '--short'] }],
    restart: () => {
      restarted = true
    },
  })
  await updates.check()
  const done = settled(updates)
  assert.deepEqual(updates.apply().progress, { state: 'running', step: 'merge' })
  assert.deepEqual((await done).progress, { state: 'restarting' })
  assert.equal(await git(install, 'rev-parse', 'HEAD'), await git(install, 'rev-parse', 'v0.2.0^{commit}'))
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(restarted, true)
  // The status stays on the install until the restart, whatever a check finds.
  await updates.check()
  assert.equal(updates.status.latest, '0.2.0')
})

test('without a supervisor the install ends by asking for a restart', async (t) => {
  const { install, release } = await fixture(t)
  await release('0.2.0', 'chore: release 0.2.0')
  const updates = updater(install)
  await updates.check()
  const done = settled(updates)
  updates.apply()
  assert.deepEqual((await done).progress, { state: 'restartRequired' })
})

test('a diverged checkout fails at the merge and leaves HEAD alone', async (t) => {
  const { git, install, release } = await fixture(t)
  await release('0.2.0', 'chore: release 0.2.0')
  await git(install, 'commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'local change')
  const before = await git(install, 'rev-parse', 'HEAD')
  const updates = updater(install)
  await updates.check()
  const done = settled(updates)
  updates.apply()
  const { progress } = await done
  assert.equal(progress?.state, 'failed')
  if (progress?.state !== 'failed') return
  assert.equal(progress.step, 'merge')
  assert.equal(progress.error, 'fatal: Not possible to fast-forward, aborting.')
  assert.equal(await git(install, 'rev-parse', 'HEAD'), before)
})

test('a failing install step is reported with its output', async (t) => {
  const { dev, install, release } = await fixture(t)
  // A dependency change: with the lockfile untouched the install is skipped.
  await writeFile(join(dev, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  await release('0.2.0', 'chore: release 0.2.0')
  const updates = updater(install, { commands: [{ step: 'install', command: 'git', args: ['no-such-command'] }] })
  await updates.check()
  const done = settled(updates)
  updates.apply()
  const { progress } = await done
  assert.equal(progress?.state, 'failed')
  if (progress?.state !== 'failed') return
  assert.equal(progress.step, 'install')
  assert.match(progress.error, /no-such-command/)
})

test('a release that only bumps package.json skips the install but still builds', async (t) => {
  const { install, release } = await fixture(t)
  await release('0.2.0', 'chore: release 0.2.0')
  const updates = updater(install, {
    commands: [
      { step: 'install', command: 'git', args: ['no-such-install'] },
      { step: 'build', command: 'git', args: ['no-such-build'] },
    ],
  })
  await updates.check()
  const done = settled(updates)
  updates.apply()
  const { progress } = await done
  assert.equal(progress?.state, 'failed')
  if (progress?.state !== 'failed') return
  assert.equal(progress.step, 'build')
})

test('apply refuses under pnpm dev', async (t) => {
  const { install, release } = await fixture(t)
  await release('0.2.0', 'chore: release 0.2.0')
  const updates = new Updater({ root: install, current: '0.1.0', canApply: false, commands: [], restart: null })
  await updates.check()
  assert.throws(() => updates.apply(), /pnpm dev/)
})
