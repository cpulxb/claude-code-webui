import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyHistoryMessage, applyTurnTotals } from '../src/render/history.ts'
import { applyMessage, emptyTranscript, lastTurnStart } from '../src/render/nodes.ts'
import { turnReplyText } from '../src/utils/transcript-markdown.ts'

const entry = (type, uuid, message) => ({ type, uuid, session_id: 's', message, parent_tool_use_id: null, parent_agent_id: null })
const prompt = (uuid, text) => entry('user', uuid, { role: 'user', content: text })
const reply = (uuid, id, text) => entry('assistant', uuid, { id, role: 'assistant', content: [{ type: 'text', text }] })
const call = (uuid, id) => entry('assistant', uuid, { id, role: 'assistant', content: [{ type: 'tool_use', id: `${id}-t`, name: 'Bash', input: {} }] })

function result(numTurns, overrides = {}) {
  return {
    type: 'result', subtype: 'success', uuid: crypto.randomUUID(), session_id: 's',
    is_error: false, duration_ms: 1500, num_turns: numTurns, total_cost_usd: 0.42,
    usage: { input_tokens: 6, output_tokens: 153, cache_read_input_tokens: 64529 },
    ...overrides,
  }
}

test('a live result draws the turn\'s own figures, without the session\'s running cost', () => {
  const transcript = emptyTranscript()
  applyMessage(transcript, result(3))
  const [row] = transcript.nodes
  assert.deepEqual({ ...row, id: undefined }, {
    kind: 'result', id: undefined, isError: false, durationMs: 1500, numTurns: 3,
    inputTokens: 6, outputTokens: 153, cacheReadTokens: 64529,
  })
})

test('a slash command the CLI ran itself draws no row, as a reload would not either', () => {
  const transcript = emptyTranscript()
  applyMessage(transcript, result(0, { usage: { input_tokens: 0, output_tokens: 0 } }))
  assert.deepEqual(transcript.nodes, [])
})

test('a turn\'s totals from history become its row, and close the turn as a live result does', () => {
  const transcript = emptyTranscript()
  for (const message of [prompt('u0', 'go'), reply('a0', 'm0', 'done')]) applyHistoryMessage(transcript, message)
  applyTurnTotals(transcript, { after: 'a0', durationMs: 4000, numTurns: 1, inputTokens: 3, outputTokens: 5, cacheReadTokens: 0 })
  assert.deepEqual(transcript.nodes.map((node) => node.kind), ['user', 'assistant', 'result'])
  assert.equal(transcript.nodes[2].id, 'a0:result')
  assert.equal(lastTurnStart(transcript.nodes), 3)
})

test('copying from a row takes that turn\'s last reply, and never one from a turn before it', () => {
  const transcript = emptyTranscript()
  const totals = (after) => ({ after, durationMs: 1, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 })
  for (const message of [prompt('u0', 'one'), reply('a0', 'm0', 'first'), call('a1', 'm1'), reply('a2', 'm2', 'second')]) {
    applyHistoryMessage(transcript, message)
  }
  applyTurnTotals(transcript, totals('a2'))
  // A turn that ended on a tool call, with no words of its own.
  for (const message of [prompt('u1', 'two'), call('a3', 'm3')]) applyHistoryMessage(transcript, message)
  applyTurnTotals(transcript, totals('a3'))

  const rows = transcript.nodes.flatMap((node, index) => (node.kind === 'result' ? [index] : []))
  assert.equal(turnReplyText(transcript.nodes, rows[0]), 'second')
  assert.equal(turnReplyText(transcript.nodes, rows[1]), null)
})
