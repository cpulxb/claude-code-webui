import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { SessionConfig } from '@ccw/shared'

import { createRpcHandlers } from '../src/rpc/routes.ts'
import type { SessionManager } from '../src/session/manager.ts'
import type { Updater } from '../src/update/updater.ts'

test('a session will not start in a directory that is gone, and the error says so', async () => {
  let started = 0
  const manager = {
    create: () => {
      started += 1
      throw new Error('the CLI must not start')
    },
  } as unknown as SessionManager
  const handlers = createRpcHandlers(manager, {} as Updater)
  await assert.rejects(
    handlers['session.create']({ cwd: '/nonexistent/(unknown)' } as SessionConfig),
    /工作目录不存在：\/nonexistent\/\(unknown\)/,
  )
  assert.equal(started, 0)
})

// --- the mode a session starts in -------------------------------------------

/** A user config dir and a project; `user` / `project` / `local` are each tier's settings, when given. */
async function folders(tiers: { user?: unknown; project?: unknown; local?: unknown }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ccw-mode-'))
  const config = join(root, 'config')
  const project = join(root, 'project')
  await mkdir(join(project, '.claude'), { recursive: true })
  await mkdir(config, { recursive: true })
  process.env['CLAUDE_CONFIG_DIR'] = config
  if (tiers.user !== undefined) await writeFile(join(config, 'settings.json'), typeof tiers.user === 'string' ? tiers.user : JSON.stringify(tiers.user))
  if (tiers.project !== undefined) await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify(tiers.project))
  if (tiers.local !== undefined) await writeFile(join(project, '.claude', 'settings.local.json'), JSON.stringify(tiers.local))
  return project
}

/** Starts a session and returns the config the runner got and what the browser was told. */
async function start(config: SessionConfig): Promise<{ started: SessionConfig; answer: { sessionId: string; permissionMode: string } }> {
  let started: SessionConfig | undefined
  const manager = {
    create: (config: SessionConfig) => {
      started = config
      return { sessionId: config.resume ?? config.sessionId ?? 'new' }
    },
  } as unknown as SessionManager
  const answer = await createRpcHandlers(manager, {} as Updater)['session.create'](config)
  assert.ok(started)
  return { started, answer }
}

const mode = (defaultMode: string) => ({ permissions: { defaultMode } })

test('a session the browser gives no mode starts in the one settings.json names', async () => {
  const cwd = await folders({ user: mode('bypassPermissions') })
  const { started, answer } = await start({ cwd, sessionId: 's' })
  assert.equal(started.permissionMode, 'bypassPermissions')
  assert.deepEqual(answer, { sessionId: 's', permissionMode: 'bypassPermissions' })
})

test('a mode the browser gives beats settings.json', async () => {
  const cwd = await folders({ user: mode('bypassPermissions') })
  const { started, answer } = await start({ cwd, sessionId: 's', permissionMode: 'plan' })
  assert.equal(started.permissionMode, 'plan')
  assert.equal(answer.permissionMode, 'plan')
})

test('with no defaultMode anywhere the session starts in default, never left to the SDK', async () => {
  const cwd = await folders({ user: { model: 'opus' } })
  const { started, answer } = await start({ cwd, sessionId: 's' })
  assert.equal(started.permissionMode, 'default')
  assert.equal(answer.permissionMode, 'default')
})

test("a project's settings.local.json overrides the user's defaultMode, as in the terminal", async () => {
  const cwd = await folders({ user: mode('bypassPermissions'), local: mode('acceptEdits') })
  assert.equal((await start({ cwd, sessionId: 's' })).started.permissionMode, 'acceptEdits')
})

test('a checked-in .claude/settings.json cannot start sessions without approvals', async () => {
  const cwd = await folders({ project: mode('bypassPermissions') })
  assert.equal((await start({ cwd, sessionId: 's' })).started.permissionMode, 'default')
  // A mode that only takes approvals away is still honoured from there.
  const planned = await folders({ project: mode('plan') })
  assert.equal((await start({ cwd: planned, sessionId: 's' })).started.permissionMode, 'plan')
})

test('a defaultMode the CLI does not know, or a broken settings.json, starts in default', async () => {
  const unknown = await folders({ user: mode('yolo') })
  assert.equal((await start({ cwd: unknown, sessionId: 's' })).started.permissionMode, 'default')
  const broken = await folders({ user: '{ "permissions": ' })
  assert.equal((await start({ cwd: broken, sessionId: 's' })).started.permissionMode, 'default')
})

test('resuming a session with no transcript yet still starts it in the settings mode', async () => {
  const cwd = await folders({ user: mode('acceptEdits') })
  const id = '00000000-0000-4000-8000-0000000000aa'
  const { started, answer } = await start({ cwd, resume: id })
  assert.equal(started.resume, undefined)
  assert.equal(started.sessionId, id)
  assert.equal(started.permissionMode, 'acceptEdits')
  assert.equal(answer.permissionMode, 'acceptEdits')
})
