import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { mergeProjectSessions, type SessionSummary } from '@ccw/shared'

import { coalesce } from '../src/history/session-list.ts'
import { listProjects, locateSession } from '../src/history/sessions.ts'

const summary = (sessionId: string, cwd: string, lastModified: number, title = ''): SessionSummary => ({
  sessionId, cwd, lastModified, summary: title,
})

test('an empty live session is included before its transcript exists and puts its project first', () => {
  const projects = mergeProjectSessions([], [
    summary('old', '/tmp', 10, 'Earlier conversation'),
    summary('other', '/project', 20, 'Another project'),
    { ...summary('new', '/tmp', 30), live: true },
  ])
  assert.deepEqual(projects.map((project) => project.cwd), ['/tmp', '/project'])
  assert.deepEqual(projects[0]?.sessions.map((session) => session.sessionId), ['new', 'old'])
  assert.equal(projects[0]?.sessions[0]?.live, true)
})

test('a live session merges into saved history without duplicate rows or losing its custom title', () => {
  const saved = { ...summary('session', '/tmp', 10, 'Original prompt'), customTitle: 'My title', firstPrompt: 'Original prompt', gitBranch: 'main' }
  const projects = mergeProjectSessions([], [saved, { ...summary('session', '/tmp', 30, 'Next prompt'), live: true }])
  assert.equal(projects.length, 1)
  assert.equal(projects[0]?.sessions.length, 1)
  assert.deepEqual(projects[0]?.sessions[0], {
    ...saved, summary: 'My title', lastModified: 30, live: true,
  })
})

test('the first prompt replaces an empty title and an old session is not promoted just by reopening it', () => {
  const initial = mergeProjectSessions([], [summary('recent', '/tmp', 20, 'Recent'), summary('old', '/tmp', 10, 'Old')])
  const reopened = mergeProjectSessions(initial, [{ ...summary('old', '/tmp', 0), live: true }])
  assert.deepEqual(reopened[0]?.sessions.map((session) => session.sessionId), ['recent', 'old'])
  assert.equal(reopened[0]?.sessions[1]?.summary, 'Old')
  const empty = mergeProjectSessions(reopened, [{ ...summary('new', '/tmp', 30), live: true }])
  const prompted = mergeProjectSessions(empty, [{ ...summary('new', '/tmp', 40, 'First message'), firstPrompt: 'First message', live: true }])
  assert.equal(prompted[0]?.sessions[0]?.summary, 'First message')
  assert.equal(prompted[0]?.sessions.filter((session) => session.sessionId === 'new').length, 1)
})

// Ids unlike the next test's: the headless verdicts are cached per session id for the whole process.
test('a session is named by its title, else by its first prompt rather than its latest', async () => {
  const config = await mkdtemp(join(tmpdir(), 'ccw-projects-'))
  const previous = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = config
  try {
    const project = join(config, 'projects', '-work-app')
    await mkdir(project, { recursive: true })
    const prompt = (sessionId: string, uuid: string, content: string): object => ({
      parentUuid: null, isSidechain: false, type: 'user', uuid, message: { role: 'user', content },
      timestamp: '2026-10-01T00:00:00.000Z', userType: 'external', entrypoint: 'sdk-ts', cwd: '/work/app', sessionId,
    })
    const command = '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'
    const transcripts: Record<string, object[]> = {
      '10000000-0000-4000-8000-000000000001': [],
      '10000000-0000-4000-8000-000000000002': [{ type: 'ai-title', aiTitle: 'Three.js shooter' }],
      '10000000-0000-4000-8000-000000000003': [{ type: 'ai-title', aiTitle: 'Three.js shooter' }, { type: 'custom-title', customTitle: 'My game' }],
    }
    for (const [sessionId, titles] of Object.entries(transcripts)) {
      const lines = [
        prompt(sessionId, `${sessionId.slice(0, -1)}a`, '做一个 three.js 射击游戏'),
        prompt(sessionId, `${sessionId.slice(0, -1)}b`, '继续吧'),
        { type: 'last-prompt', lastPrompt: '继续吧', sessionId },
        ...titles.map((title) => ({ ...title, sessionId })),
      ]
      await writeFile(join(project, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    }
    const commandOnly = '10000000-0000-4000-8000-000000000004'
    await writeFile(
      join(project, `${commandOnly}.jsonl`),
      `${[prompt(commandOnly, `${commandOnly.slice(0, -1)}a`, command), { type: 'last-prompt', lastPrompt: '现在的时间', sessionId: commandOnly }]
        .map((line) => JSON.stringify(line)).join('\n')}\n`,
    )

    const titles = Object.fromEntries((await listProjects())[0]?.sessions.map((session) => [session.sessionId.at(-1), session.summary]) ?? [])
    assert.deepEqual(titles, { 1: '做一个 three.js 射击游戏', 2: 'Three.js shooter', 3: 'My game', 4: '现在的时间' })
  } finally {
    if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = previous
    await rm(config, { recursive: true, force: true })
  }
})

test('the list keeps terminal and WebUI sessions but drops claude -p and other headless runs', async () => {
  const config = await mkdtemp(join(tmpdir(), 'ccw-projects-'))
  const previous = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = config
  try {
    const project = join(config, 'projects', '-work-app')
    await mkdir(project, { recursive: true })
    const transcripts = {
      '00000000-0000-4000-8000-000000000001': 'cli',
      '00000000-0000-4000-8000-000000000002': 'sdk-ts',
      '00000000-0000-4000-8000-000000000003': 'sdk-cli',
      '00000000-0000-4000-8000-000000000004': 'sdk-py',
    }
    for (const [sessionId, entrypoint] of Object.entries(transcripts)) {
      const record = {
        parentUuid: null, isSidechain: false, type: 'user', uuid: sessionId,
        message: { role: 'user', content: `hello from ${entrypoint}` },
        timestamp: '2026-10-01T00:00:00.000Z', userType: 'external', entrypoint, cwd: '/work/app', sessionId,
      }
      await writeFile(join(project, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`)
    }

    const projects = await listProjects()
    assert.deepEqual(projects.map((group) => group.cwd), ['/work/app'])
    assert.deepEqual(
      projects[0]?.sessions.map((session) => session.summary).sort(),
      ['hello from cli', 'hello from sdk-ts'],
    )
  } finally {
    if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = previous
    await rm(config, { recursive: true, force: true })
  }
})

test('a session whose first prompt carries a screenshot still lists under its project and locates there', async () => {
  const config = await mkdtemp(join(tmpdir(), 'ccw-projects-'))
  const previous = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = config
  try {
    const project = join(config, 'projects', '-work-app')
    await mkdir(project, { recursive: true })
    const sessionId = '40000000-0000-4000-8000-000000000001'
    // The SDK reads a session's cwd from the first 64 KB only, and this image pushes the first `cwd` past it.
    const screenshot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200_000) } }
    const lines = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-01T00:00:00.000Z', sessionId },
      {
        parentUuid: null, isSidechain: false, type: 'user', uuid: 'u1',
        message: { role: 'user', content: [screenshot, { type: 'text', text: '新建一个项目文件夹' }] },
        timestamp: '2026-10-01T00:00:01.000Z', userType: 'external', entrypoint: 'sdk-ts', cwd: '/work/app', sessionId,
      },
      { parentUuid: 'u1', isSidechain: false, type: 'attachment', attachment: { type: 'environment' }, cwd: '/work/app', sessionId },
    ]
    await writeFile(join(project, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    const projects = await listProjects()
    assert.deepEqual(projects.map((group) => group.cwd), ['/work/app'])
    assert.equal(await locateSession(sessionId), '/work/app')
  } finally {
    if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = previous
    await rm(config, { recursive: true, force: true })
  }
})

/** A run per call, each settled from the test. */
function controlledRuns(): { run: () => Promise<number>; started: { resolve: (value: number) => void; reject: (error: Error) => void }[] } {
  const started: { resolve: (value: number) => void; reject: (error: Error) => void }[] = []
  const run = (): Promise<number> => new Promise((resolve, reject) => started.push({ resolve, reject }))
  return { run, started }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('calls made while the list is read share one read started after it', async () => {
  const { run, started } = controlledRuns()
  const read = coalesce(run)
  const first = read()
  const second = read()
  const third = read()
  assert.equal(started.length, 1)

  started[0]?.resolve(1)
  assert.equal(await first, 1)
  await settle()
  // The first read may predate what the later calls ask about: they get a fresh one.
  assert.equal(started.length, 2)
  started[1]?.resolve(2)
  assert.deepEqual(await Promise.all([second, third]), [2, 2])

  const fourth = read()
  assert.equal(started.length, 3)
  started[2]?.resolve(3)
  assert.equal(await fourth, 3)
})

test('a failed read reaches its callers and does not stall the next', async () => {
  const { run, started } = controlledRuns()
  const read = coalesce(run)
  const failing = read()
  const queued = read()
  started[0]?.reject(new Error('disk gone'))
  await assert.rejects(failing, /disk gone/)
  await settle()
  started[1]?.resolve(7)
  assert.equal(await queued, 7)
})
