import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isArchived } from '../src/utils/session-archive.ts'

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 10, 17)
const context = { days: 14, now, activeId: null, unread: {} }
const session = (sessionId, daysAgo, fields = {}) => ({ sessionId, summary: 'x', lastModified: now - daysAgo * DAY, ...fields })

test('a session folds away once nothing was said in it for the chosen days', () => {
  assert.equal(isArchived(session('a', 13), context), false)
  assert.equal(isArchived(session('a', 14), context), true)
  assert.equal(isArchived(session('a', 2), { ...context, days: 1 }), true)
})

test('never means nothing folds on its own', () => {
  assert.equal(isArchived(session('a', 400), { ...context, days: 0 }), false)
})

test('an open, shown or unread session is never folded on its own', () => {
  assert.equal(isArchived(session('a', 30, { live: true }), context), false)
  assert.equal(isArchived(session('a', 30), { ...context, activeId: 'a' }), false)
  assert.equal(isArchived(session('a', 30), { ...context, unread: { a: 'done' } }), false)
})

test('a mark on disk decides, whatever the age', () => {
  assert.equal(isArchived(session('a', 0, { archived: true, live: true }), context), true)
  assert.equal(isArchived(session('a', 0, { archived: true }), { ...context, days: 0 }), true)
  // Taken back out, or prompted since it was put away.
  assert.equal(isArchived(session('a', 30, { archived: false }), context), false)
})
