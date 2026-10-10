import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeProjectSessions, type SessionSummary } from '@ccw/shared'

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
