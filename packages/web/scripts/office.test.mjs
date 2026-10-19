import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bubbleFor, colorFor, layoutOffice, ROOM, stationFor } from '../src/render/office.ts'

const agent = (id, extra = {}) => ({
  toolUseId: id,
  description: id,
  prompt: '',
  status: 'running',
  backgrounded: false,
  toolUses: 0,
  totalTokens: 0,
  durationMs: 0,
  transcript: null,
  historyLoaded: false,
  ...extra,
})

test('each tool sends the agent to its station', () => {
  assert.equal(stationFor(agent('a', { lastTool: 'Read' })), 'shelf')
  assert.equal(stationFor(agent('a', { lastTool: 'Grep' })), 'shelf')
  assert.equal(stationFor(agent('a', { lastTool: 'Bash' })), 'terminal')
  assert.equal(stationFor(agent('a', { lastTool: 'WebSearch' })), 'window')
  assert.equal(stationFor(agent('a', { lastTool: 'mcp__github__get_issue' })), 'window')
  assert.equal(stationFor(agent('a', { lastTool: 'Edit' })), 'desk')
  assert.equal(stationFor(agent('a')), 'desk')
  assert.equal(stationFor(agent('a', { activity: 'Reading alpha.txt' })), 'shelf')
})

test('finished agents go for coffee, broken ones slump at their desk', () => {
  assert.equal(stationFor(agent('a', { status: 'completed', lastTool: 'Bash' })), 'lounge')
  const [failed] = layoutOffice([agent('a', { status: 'failed', lastTool: 'Read' })])
  assert.equal(failed.station, 'desk')
  assert.equal(failed.pose, 'slump')
  assert.equal(failed.y, ROOM.deskY)
})

test('agents get their own desk and never stand on each other', () => {
  const places = layoutOffice([
    agent('a', { lastTool: 'Read' }),
    agent('b', { lastTool: 'Read' }),
    agent('c', { lastTool: 'Read' }),
    agent('d', { lastTool: 'Edit' }),
  ])
  assert.equal(new Set(places.map((p) => p.deskX)).size, 4)
  const spots = places.map((p) => `${p.x},${p.y}`)
  assert.equal(new Set(spots).size, 4)
  for (const p of places) assert.ok(p.x >= 4 && p.x <= 96)
  assert.equal(places[3].x, places[3].deskX)
  assert.equal(places[3].pose, 'sit')
})

test('shirt colour is stable per agent', () => {
  assert.equal(colorFor('toolu_123'), colorFor('toolu_123'))
  assert.equal(layoutOffice([agent('toolu_123')])[0].color, colorFor('toolu_123'))
})

test('bubbles say what the agent is up to, briefly', () => {
  assert.equal(bubbleFor(agent('a', { activity: 'Reading alpha.txt' })), 'Reading alpha.txt')
  assert.equal(bubbleFor(agent('a', { lastTool: 'Bash' })), '正在 Bash')
  assert.equal(bubbleFor(agent('a', { status: 'completed' })), '☕ 完工')
  assert.ok(bubbleFor(agent('a', { activity: 'x'.repeat(60) })).length <= 22)
})
