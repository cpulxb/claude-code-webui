import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyTurnProgress, startTurnProgress, type PermissionRequest, type SDKMessage, type SessionConfig, type TurnProgress } from '@ccw/shared'

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

// --- authoritative reconnect snapshots (no CLI is created) ------------------

function stateFixture(progress: TurnProgress | null, status: 'idle' | 'running' = progress ? 'running' : 'idle') {
  const backlog = [{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'in flight' }] } }] as unknown as SDKMessage[]
  const runner = { status, backlog, pendingPermissions: [] as PermissionRequest[], permissionMode: 'plan', turnProgress: progress }
  const manager = { has: (id: string) => id === 'live', require: () => runner } as unknown as SessionManager
  return { runner, state: createRpcHandlers(manager, {} as Updater)['session.state'] }
}

test('unknown sessions have an explicit null progress and a server-clock sample', async () => {
  const { state } = stateFixture(null)
  const before = Date.now()
  const answer = await state({ sessionId: 'unknown' })
  const after = Date.now()
  assert.deepEqual({ ...answer, serverNow: 0 }, { live: false, status: 'idle', pendingPermissions: [], backlog: [], turnProgress: null, serverNow: 0 })
  assert.ok(answer.serverNow! >= before && answer.serverNow! <= after)
})

test('reconnect keeps the original retry deadline and turn start instead of replaying backlog', async () => {
  const retry = applyTurnProgress(startTurnProgress(1000), {
    type: 'system', subtype: 'api_retry', uuid: 'r1', attempt: 1, max_retries: 3, retry_delay_ms: 2000, error_status: 429, error: 'rate_limit',
  } as unknown as SDKMessage, 1500)!
  const { state } = stateFixture(retry)
  const first = await state({ sessionId: 'live' })
  const second = await state({ sessionId: 'live' })
  assert.equal(first.live, true)
  assert.equal(first.status, 'running')
  assert.equal(first.permissionMode, 'plan')
  assert.equal(first.turnProgress, retry)
  assert.equal(second.turnProgress, retry)
  assert.equal(second.turnProgress?.startedAt, 1000)
  assert.equal(second.turnProgress?.retry?.retryAt, 3500)
  assert.ok(second.serverNow! >= first.serverNow!)
  assert.equal(second.backlog.length, 1)
  assert.equal(second.turnProgress?.phase, 'retrying')
})

test('a pending question restores as running with the existing retry and permission request', async () => {
  const progress: TurnProgress = { startedAt: 1000, phase: 'retrying', retry: { uuid: 'r', attempt: 1, maxRetries: 2, retryAt: 0, errorStatus: null, error: 'unknown' } }
  const { runner, state } = stateFixture(progress)
  const request = { requestId: 'p', toolUseId: 't', toolName: 'AskUserQuestion', input: {} }
  runner.pendingPermissions = [request]
  const answer = await state({ sessionId: 'live' })
  assert.equal(answer.status, 'running')
  assert.equal(answer.turnProgress, progress)
  assert.deepEqual(answer.pendingPermissions, [request])
})

test('an idle live runner returns null progress, not a new clock', async () => {
  const { state } = stateFixture(null)
  const answer = await state({ sessionId: 'live' })
  assert.equal(answer.live, true)
  assert.equal(answer.status, 'idle')
  assert.equal(answer.turnProgress, null)
  assert.equal(typeof answer.serverNow, 'number')
})
