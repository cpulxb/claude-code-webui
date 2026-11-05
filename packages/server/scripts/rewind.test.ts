import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RewindFilesResult, ServerEvent, SessionConfig } from '@ccw/shared'

import { pendingRewind, setPendingRewind } from '../src/history/rewinds.ts'
import { readMessagePage, readMessages, readPrompts, rewindPoint, rewoundAt } from '../src/history/sessions.ts'
import { createRpcHandlers } from '../src/rpc/routes.ts'
import type { SessionManager } from '../src/session/manager.ts'
import type { RunnerConfig } from '../src/session/runner.ts'
import type { Updater } from '../src/update/updater.ts'

// Both config dirs are scratch: the CLI's, where transcripts live, and this
// app's, where `rewinds.json` goes.
const root = await mkdtemp(join(tmpdir(), 'ccw-rewind-'))
process.env['CLAUDE_CONFIG_DIR'] = join(root, 'claude')
process.env['CCW_CONFIG_DIR'] = join(root, 'ccw')
const cwd = join(root, 'work')
const project = join(root, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
await mkdir(cwd, { recursive: true })
await mkdir(project, { recursive: true })
test.after(() => rm(root, { recursive: true, force: true }))

type Line = Record<string, unknown>
let clock = 0
function entry(sessionId: string, uuid: string, parent: string | null, type: string, body: Record<string, unknown>): Line {
  clock += 1
  return {
    uuid, parentUuid: parent, type, isSidechain: false, sessionId, cwd,
    timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, clock)).toISOString(), ...body,
  }
}
const ask = (sessionId: string, uuid: string, parent: string | null, text: string): Line =>
  entry(sessionId, uuid, parent, 'user', { message: { role: 'user', content: text } })
const answer = (sessionId: string, uuid: string, parent: string, text: string): Line =>
  entry(sessionId, uuid, parent, 'assistant', { message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'text', text }] } })
// What a SessionStart hook leaves ahead of the first prompt.
const hook = (sessionId: string, uuid: string): Line =>
  entry(sessionId, uuid, null, 'attachment', { attachment: { type: 'hook_additional_context', content: ['context'] } })

const path = (sessionId: string): string => join(project, `${sessionId}.jsonl`)
const write = (sessionId: string, lines: Line[]): Promise<void> =>
  writeFile(path(sessionId), lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
const append = (sessionId: string, lines: Line[]): Promise<void> =>
  appendFile(path(sessionId), lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
const uuids = (messages: { uuid: string }[]): string[] => messages.map((message) => message.uuid)

/** Two turns: `one` → `two`, then `three` → `four`. */
async function twoTurns(sessionId: string): Promise<void> {
  await write(sessionId, [
    ask(sessionId, 'p1', null, 'one'), answer(sessionId, 'r1', 'p1', 'two'),
    ask(sessionId, 'p2', 'r1', 'three'), answer(sessionId, 'r2', 'p2', 'four'),
  ])
}

test('until the next prompt is saved, every read stops short of the prompt rewound away', async () => {
  const sessionId = '00000000-0000-4000-8000-00000000b001'
  await twoTurns(sessionId)
  await setPendingRewind(sessionId, { at: 'r1', drop: 'p2' })

  assert.deepEqual(uuids(await readMessages(sessionId, cwd)), ['p1', 'r1'])
  assert.deepEqual(uuids((await readMessagePage(sessionId, cwd, 10)).messages), ['p1', 'r1'])
  assert.deepEqual(uuids(await readPrompts(sessionId, cwd)), ['p1'])
  // A runner resuming now — after a server restart, say — must stop there too.
  assert.equal(await rewoundAt(sessionId, cwd), 'r1')
  // Kept where it outlives the server.
  const saved = JSON.parse(await readFile(join(root, 'ccw', 'rewinds.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(saved[sessionId], { at: 'r1', drop: 'p2' })
})

test('once the next prompt is saved the transcript shows the rewind itself, and the record goes', async () => {
  const sessionId = '00000000-0000-4000-8000-00000000b002'
  await twoTurns(sessionId)
  await setPendingRewind(sessionId, { at: 'r1', drop: 'p2' })
  // As the CLI writes it: the new prompt hangs off the cut, after the old branch.
  await append(sessionId, [ask(sessionId, 'p3', 'r1', 'again'), answer(sessionId, 'r3', 'p3', 'five')])

  assert.deepEqual(uuids(await readMessages(sessionId, cwd)), ['p1', 'r1', 'p3', 'r3'])
  assert.equal(await pendingRewind(sessionId), undefined)
  // Resuming at the old cut would drop the turn just sent.
  assert.equal(await rewoundAt(sessionId, cwd), undefined)
  const saved = JSON.parse(await readFile(join(root, 'ccw', 'rewinds.json'), 'utf8')) as Record<string, unknown>
  assert.equal(saved[sessionId], undefined)
})

test('a resumed runner is told the cut only once its transcript has caught up, never by the browser', async () => {
  const sessionId = '00000000-0000-4000-8000-00000000b003'
  await twoTurns(sessionId)
  const started: RunnerConfig[] = []
  const manager = {
    create: (config: RunnerConfig) => {
      started.push(config)
      return { sessionId: config.resume }
    },
  } as unknown as SessionManager
  const create = createRpcHandlers(manager, {} as Updater)['session.create']

  await create({ cwd, resume: sessionId, resumeSessionAt: 'p1' } as SessionConfig)
  assert.equal(started[0]!.resumeSessionAt, undefined)

  await setPendingRewind(sessionId, { at: 'r1', drop: 'p2' })
  await create({ cwd, resume: sessionId } as SessionConfig)
  assert.equal(started[1]!.resumeSessionAt, 'r1')

  await append(sessionId, [ask(sessionId, 'p3', 'r1', 'again')])
  await create({ cwd, resume: sessionId } as SessionConfig)
  assert.equal(started[2]!.resumeSessionAt, undefined)
})

test('a conversation resumes at the entry its prompt was written after, a hook attachment included', async () => {
  const plain = '00000000-0000-4000-8000-00000000b004'
  await twoTurns(plain)
  assert.equal(await rewindPoint(plain, cwd, 'p2'), 'r1')
  // The first prompt of a session without hooks: nothing to resume at.
  assert.equal(await rewindPoint(plain, cwd, 'p1'), null)

  const hooked = '00000000-0000-4000-8000-00000000b005'
  await write(hooked, [hook(hooked, 'h1'), ask(hooked, 'p1', 'h1', 'one'), answer(hooked, 'r1', 'p1', 'two')])
  assert.equal(await rewindPoint(hooked, cwd, 'p1'), 'h1')
})

test('only a prompt still in the conversation can be rewound to', async () => {
  const sessionId = '00000000-0000-4000-8000-00000000b006'
  await twoTurns(sessionId)
  await assert.rejects(rewindPoint(sessionId, cwd, 'r1'), /不在当前的对话里/)
  await assert.rejects(rewindPoint(sessionId, cwd, 'nowhere'), /不在当前的对话里/)
  await setPendingRewind(sessionId, { at: 'r1', drop: 'p2' })
  await assert.rejects(rewindPoint(sessionId, cwd, 'p2'), /不在当前的对话里/)
})

// --- the route ----------------------------------------------------------------

type Calls = string[]

/** A manager around one idle runner, recording what the route asks of each. */
function fakeManager(
  calls: Calls,
  options: { status?: 'idle' | 'running'; files?: RewindFilesResult } = {},
): { manager: SessionManager; events: ServerEvent[]; restarted: RunnerConfig[] } {
  const events: ServerEvent[] = []
  const restarted: RunnerConfig[] = []
  const runner = {
    status: options.status ?? 'idle',
    pendingPermissions: [],
    config: { cwd, resume: 'x' } as RunnerConfig,
    rewindFiles: async (id: string, dryRun: boolean) => {
      calls.push(`files ${id} ${dryRun}`)
      return options.files ?? { canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 1 }
    },
    carryOver: async (): Promise<RunnerConfig> => ({ cwd, permissionMode: 'plan', model: 'haiku', effort: 'low' }),
  }
  const manager = {
    require: () => runner,
    restart: async (_id: string, config: RunnerConfig) => {
      calls.push('restart')
      restarted.push(config)
    },
    announce: (event: ServerEvent) => events.push(event),
  } as unknown as SessionManager
  return { manager, events, restarted }
}

test('rewinding code and conversation restores the files first, then restarts where the prompt began', async () => {
  const sessionId = '00000000-0000-4000-8000-00000000b007'
  await twoTurns(sessionId)
  const calls: Calls = []
  const { manager, events, restarted } = fakeManager(calls)
  const rewind = createRpcHandlers(manager, {} as Updater)['session.rewindConversation']

  const result = await rewind({ sessionId, userMessageId: 'p2', restoreFiles: true })
  assert.deepEqual(calls, ['files p2 false', 'restart'])
  assert.equal(result.fresh, false)
  assert.equal(result.files?.filesChanged?.length, 1)
  // The settings the session runs on now go with it.
  assert.deepEqual(restarted[0], { cwd, permissionMode: 'plan', model: 'haiku', effort: 'low', resume: sessionId, resumeSessionAt: 'r1' })
  assert.deepEqual(events, [{ type: 'session_rewound', sessionId, userMessageId: 'p2' }])
  assert.deepEqual(uuids(await readMessages(sessionId, cwd)), ['p1', 'r1'])
})

test('a file rewind that fails leaves the conversation as it was', async () => {
  const sessionId = '00000000-0000-4000-8000-00000000b008'
  await twoTurns(sessionId)
  const calls: Calls = []
  const { manager } = fakeManager(calls, { files: { canRewind: false, error: 'No checkpoint' } })
  const rewind = createRpcHandlers(manager, {} as Updater)['session.rewindConversation']

  await assert.rejects(rewind({ sessionId, userMessageId: 'p2', restoreFiles: true }), /代码没能回退.*No checkpoint/)
  assert.deepEqual(calls, ['files p2 false'])
  assert.equal(await pendingRewind(sessionId), undefined)
})

test('a running turn is not rewound under its feet', async () => {
  const sessionId = '00000000-0000-4000-8000-00000000b009'
  await twoTurns(sessionId)
  const calls: Calls = []
  const { manager } = fakeManager(calls, { status: 'running' })
  const rewind = createRpcHandlers(manager, {} as Updater)['session.rewindConversation']
  await assert.rejects(rewind({ sessionId, userMessageId: 'p2' }), /停止之后再回退/)
  assert.deepEqual(calls, [])
})

test('rewinding to the prompt that opened the transcript leaves the session alone for a fresh one', async () => {
  const sessionId = '00000000-0000-4000-8000-00000000b010'
  await twoTurns(sessionId)
  const calls: Calls = []
  const { manager, events } = fakeManager(calls)
  const rewind = createRpcHandlers(manager, {} as Updater)['session.rewindConversation']

  const result = await rewind({ sessionId, userMessageId: 'p1', restoreFiles: true })
  assert.equal(result.fresh, true)
  assert.deepEqual(calls, ['files p1 false'])
  assert.deepEqual(events, [])
  assert.equal(await pendingRewind(sessionId), undefined)
})
