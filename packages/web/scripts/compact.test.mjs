import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyHistoryMessage, listUserPromptUuids } from '../src/render/history.ts'
import { applyMessage, emptyTranscript } from '../src/render/nodes.ts'

const SUMMARY =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   - Reply with ok.'

// What CLI 2.1.302 streams for `/compact`, minus the hook and status events.
const live = [
  {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 's',
    uuid: 'boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 371300, post_tokens: 15100 },
    logical_parent_uuid: 'before',
  },
  {
    type: 'user',
    message: { role: 'user', content: SUMMARY },
    session_id: 's',
    parent_tool_use_id: null,
    uuid: 'summary',
    isReplay: true,
    isSynthetic: true,
  },
  {
    type: 'user',
    message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' },
    session_id: 's',
    parent_tool_use_id: null,
    uuid: 'stdout',
    isReplay: true,
  },
]

// The same compaction read back through getSessionMessages: the boundary is a
// bare envelope, and the summary is marked rather than synthetic.
const history = [
  { type: 'system', uuid: 'boundary', session_id: 's', parent_tool_use_id: null, parent_agent_id: null },
  {
    type: 'user',
    uuid: 'summary',
    session_id: 's',
    message: { role: 'user', content: SUMMARY },
    parent_tool_use_id: null,
    parent_agent_id: null,
    isCompactSummary: true,
    is_meta: true,
  },
  {
    type: 'user',
    uuid: 'next',
    session_id: 's',
    message: { role: 'user', content: 'carry on' },
    parent_tool_use_id: null,
    parent_agent_id: null,
  },
]

test('a live compaction keeps its summary on the divider', () => {
  const transcript = emptyTranscript()
  for (const message of live) applyMessage(transcript, message)
  assert.deepEqual(transcript.nodes, [
    { kind: 'compact', id: 'boundary', trigger: 'manual', preTokens: 371300, postTokens: 15100, summary: SUMMARY },
  ])
})

test('a synthetic message not right after a boundary is not taken for a summary', () => {
  const transcript = emptyTranscript()
  applyMessage(transcript, live[0])
  applyMessage(transcript, { type: 'assistant', uuid: 'a', session_id: 's', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'text', text: 'hi' }] } })
  applyMessage(transcript, live[1])
  assert.equal(transcript.nodes[0].summary, undefined)
})

test('a compaction read from history is a divider with its summary, not a prompt', () => {
  const transcript = emptyTranscript()
  for (const entry of history) applyHistoryMessage(transcript, entry)
  assert.deepEqual(
    transcript.nodes.map((node) => node.kind),
    ['compact', 'user'],
  )
  assert.equal(transcript.nodes[0].summary, SUMMARY)
  assert.deepEqual(listUserPromptUuids(history), ['next'])
})
