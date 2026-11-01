import assert from 'node:assert/strict'
import { test } from 'node:test'

import { activityOf, mostUrgent } from '../src/utils/session-activity.ts'

const session = (sessionId, fields = {}) => ({ sessionId, summary: '', lastModified: 0, ...fields })

test('a session says the most urgent thing about it', () => {
  assert.equal(activityOf(session('a', { live: true, running: true, waiting: true }), undefined), 'waiting')
  assert.equal(activityOf(session('a', { live: true, running: true }), 'done'), 'running')
  assert.equal(activityOf(session('a', { live: true }), 'error'), 'error')
  assert.equal(activityOf(session('a', { live: true }), undefined), 'idle')
  assert.equal(activityOf(session('a'), 'done'), 'done')
  assert.equal(activityOf(session('a'), undefined), null)
})

test('flags left on a session whose process is gone say nothing', () => {
  assert.equal(activityOf(session('a', { running: true, waiting: true }), undefined), null)
})

test('a project shows its most urgent session', () => {
  const sessions = [session('a', { live: true }), session('b'), session('c', { live: true, running: true })]
  assert.equal(mostUrgent(sessions, { b: 'done' }), 'running')
  assert.equal(mostUrgent(sessions.slice(0, 2), { b: 'done' }), 'done')
  assert.equal(mostUrgent([session('b')], {}), null)
})
