import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { applyHistoryMessage, prependTranscript } from '../src/render/history.ts'
import { applyMessage, emptyTranscript, listAgents, parseHandBack } from '../src/render/nodes.ts'

// A real CLI 2.1.293 run: the main thread spawns two general-purpose
// subagents in parallel, each reads one file, and the main thread reports.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/two-subagents.json', import.meta.url), 'utf8'))
const messages = fixture.map((event) => event.message)

function replay(list) {
  const transcript = emptyTranscript()
  for (const message of list) applyMessage(transcript, message)
  return transcript
}

const kinds = (transcript) => transcript.nodes.map((node) => (node.kind === 'tool' ? `tool:${node.name}` : node.kind))

test('subagent output lands in its own transcript, not the main thread', () => {
  const transcript = replay(messages)
  assert.deepEqual(kinds(transcript), ['assistant', 'tool:Agent', 'tool:Agent', 'assistant', 'result'])

  const agents = listAgents(transcript)
  assert.deepEqual(agents.map((agent) => agent.description), ['Read alpha', 'Read beta'])
  for (const agent of agents) {
    assert.equal(agent.status, 'completed')
    assert.equal(agent.subagentType, 'general-purpose')
    assert.match(agent.agentId, /^a[0-9a-f]+$/)
    assert.equal(agent.toolUses, 1)
    assert.ok(agent.totalTokens > 0)
    assert.deepEqual(kinds(agent.transcript), ['user', 'tool:Read'])
    assert.equal(agent.transcript.nodes[1].status, 'done')
  }
  assert.equal(agents[0].summary, 'MANGO')
  assert.equal(agents[1].summary, 'TEAL')
  assert.match(agents[0].transcript.nodes[0].text, /alpha\.txt/)
  assert.match(agents[0].transcript.nodes[1].output, /MANGO/)
})

test('replaying the same stream twice changes nothing', () => {
  const transcript = replay([...messages, ...messages])
  assert.deepEqual(kinds(transcript), ['assistant', 'tool:Agent', 'tool:Agent', 'assistant', 'result'])
  for (const agent of listAgents(transcript)) assert.deepEqual(kinds(agent.transcript), ['user', 'tool:Read'])
})

test('a subagent mid-run shows as running with its current activity', () => {
  const cut = messages.findIndex((message) => message.subtype === 'task_progress')
  const transcript = replay(messages.slice(0, cut + 1))
  const [alpha, beta] = listAgents(transcript)
  assert.equal(alpha.status, 'running')
  assert.equal(alpha.activity, 'Reading alpha.txt')
  assert.equal(alpha.lastTool, 'Read')
  assert.equal(beta.status, 'running')
})

test('task_notification stopped marks the subagent stopped', () => {
  const cut = messages.findIndex((message) => message.subtype === 'task_progress')
  const transcript = replay(messages.slice(0, cut + 1))
  const [alpha] = listAgents(transcript)
  applyMessage(transcript, {
    type: 'system',
    subtype: 'task_notification',
    task_id: alpha.agentId,
    tool_use_id: alpha.toolUseId,
    status: 'stopped',
    output_file: '',
    summary: '',
    uuid: 'stop-1',
    session_id: 's',
  })
  assert.equal(alpha.status, 'stopped')
})

test('history replay rebuilds the cards from the model-facing hand-back text', () => {
  // On disk the tool_result keeps only its text, not the structured result.
  const history = messages
    .filter((message) => (message.type === 'assistant' || message.type === 'user') && message.parent_tool_use_id === null)
    .map(({ tool_use_result: _dropped, ...entry }) => entry)
  const transcript = emptyTranscript()
  for (const entry of history) applyHistoryMessage(transcript, entry)
  const agents = listAgents(transcript)
  assert.deepEqual(agents.map((agent) => agent.summary), ['MANGO', 'TEAL'])
  assert.deepEqual(agents.map((agent) => agent.status), ['completed', 'completed'])
  assert.ok(agents.every((agent) => /^a[0-9a-f]+$/.test(agent.agentId)))
})

test('parseHandBack strips the frame, the indent and the agentId trailer', () => {
  const output =
    '[Subagent hand-back] Frame text. The report follows:\n  line one\n    indented\nagentId: abc123 (use SendMessage …)'
  assert.equal(parseHandBack(output), 'line one\n  indented')
  assert.equal(parseHandBack('plain report'), 'plain report')
})

test("a main-thread tool's progress ticks time its card instead of conjuring a subagent", () => {
  // CLI 2.1.302: tool heartbeats (every 30s) and bash_progress (container
  // hosts only) carry an id of their own and name the timed tool as parent.
  const transcript = emptyTranscript()
  applyMessage(transcript, {
    type: 'assistant',
    message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'sleep 90' } }] },
    parent_tool_use_id: null,
    uuid: 'a-1',
    session_id: 's',
  })
  const tick = (toolUseId, seconds) =>
    applyMessage(transcript, {
      type: 'tool_progress',
      tool_use_id: toolUseId,
      tool_name: 'Bash',
      parent_tool_use_id: 'toolu_bash',
      elapsed_time_seconds: seconds,
      uuid: `p-${seconds}`,
      session_id: 's',
    })
  tick('bash-progress-0', 12)
  tick('toolu_bash-heartbeat-0', 30)
  assert.deepEqual(listAgents(transcript), [])
  assert.equal(transcript.nodes[0].elapsedSeconds, 30)
})

test('a subagent stopped from the UI reads as stopped, not failed', () => {
  // Real run: two foreground subagents sleeping; stopTask on the first after
  // 6s. The CLI sends task_notification(stopped) and then an error tool_result.
  const stopped = JSON.parse(readFileSync(new URL('./fixtures/stopped-subagent.json', import.meta.url), 'utf8'))
  const transcript = replay(stopped.map((event) => event.message))
  const [one, two] = listAgents(transcript)
  assert.equal(one.description, 'Slow one')
  assert.equal(one.status, 'stopped')
  assert.equal(two.status, 'running')
  assert.match(two.activity, /Sleep 25 seconds/)
  // The subagents' own Bash tasks share the task_* events but get no card.
  assert.equal(listAgents(transcript).length, 2)
})

test('history pages prepended newest first add up to the whole replay', () => {
  const entry = (type, uuid, content, id) => ({
    type,
    uuid,
    session_id: 's',
    parent_tool_use_id: null,
    message: type === 'assistant' ? { id, role: 'assistant', content } : { role: 'user', content },
  })
  // A background subagent launched on one page settles on the next: its
  // notification is replayed before the card it belongs to exists.
  const older = [
    entry('user', 'p0', 'scan the repo'),
    entry('assistant', 'a0', [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'Scan', prompt: 'scan', run_in_background: true } }], 'm1'),
    entry('user', 'r0', [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Agent is running in the background.\nagentId: abc123' }]),
  ]
  const newer = [
    entry('user', 'p1', 'status?'),
    entry('assistant', 'a1', [{ type: 'tool_use', id: 'toolu_sh', name: 'Bash', input: { command: 'ls' } }], 'm2'),
    entry('user', 'r1', [{ type: 'tool_result', tool_use_id: 'toolu_sh', content: 'ok' }]),
    entry('user', 'n0', '<task-notification><task-id>abc123</task-id><tool-use-id>toolu_bg</tool-use-id><status>completed</status></task-notification>'),
    entry('assistant', 'a2', [{ type: 'text', text: 'all done' }], 'm3'),
  ]
  const replay = (list) => {
    const transcript = emptyTranscript()
    for (const message of list) applyHistoryMessage(transcript, message)
    return transcript
  }

  const whole = replay([...older, ...newer])
  const paged = replay(newer)
  assert.equal(paged.pendingNotices.length, 1)
  prependTranscript(paged, replay(older))

  assert.deepEqual(kinds(paged), kinds(whole))
  assert.deepEqual(Object.keys(paged.toolIndex).sort(), Object.keys(whole.toolIndex).sort())
  for (const [id, index] of Object.entries(paged.toolIndex)) assert.equal(paged.nodes[index].toolUseId, id)
  assert.deepEqual(listAgents(paged).map((agent) => agent.status), ['completed'])
  assert.deepEqual(paged.pendingNotices, [])
  assert.deepEqual(Object.keys(paged.seen).sort(), Object.keys(whole.seen).sort())
})
