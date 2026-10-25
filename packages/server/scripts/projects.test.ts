import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { mergeProjectSessions, type SessionSummary } from '@ccw/shared'

import { listProjects } from '../src/history/sessions.ts'

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
