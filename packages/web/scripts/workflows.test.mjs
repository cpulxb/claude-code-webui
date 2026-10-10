import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { applyHistoryMessage, listUserPromptUuids } from '../src/render/history.ts'
import { applyMessage, emptyTranscript, findAgent, listAgents } from '../src/render/nodes.ts'
import { applyWorkflowRecord, parseTaskNotification, unframeWorkflowPrompt, workflowAgentKey } from '../src/render/workflows.ts'

// A real CLI 2.1.296 run with ultracode on at xhigh: the model launches a
// three-agent Workflow in the background, it finishes, and the model reports.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/workflow-run.json', import.meta.url), 'utf8'))
const messages = fixture.map((event) => event.message)

function replay(list) {
  const transcript = emptyTranscript()
  for (const message of list) applyMessage(transcript, message)
  return transcript
}

const only = (transcript) => Object.values(transcript.workflows)

test('a Workflow call becomes a run with phases and every agent', () => {
  const transcript = replay(messages)
  const tools = transcript.nodes.filter((node) => node.kind === 'tool').map((node) => node.name)
  assert.deepEqual(tools, ['Workflow'])
  const [run] = only(transcript)
  assert.equal(run.name, 'count-lines')
  assert.equal(run.status, 'completed')
  assert.equal(run.taskId, 'wgxdi8dwg')
  assert.match(run.runId, /^wf_/)
  assert.deepEqual(run.phases.map((phase) => phase.title), ['Count'])
  assert.deepEqual(run.agents.map((agent) => [agent.label, agent.state, agent.phaseIndex]), [
    ['count:f1.txt', 'done', 1],
    ['count:f2.txt', 'done', 1],
    ['count:f3.txt', 'done', 1],
  ])
  assert.ok(run.agents.every((agent) => agent.tokens > 0 && agent.agentId))
  assert.match(run.agents[1].resultPreview, /"lines":14/)
  assert.ok(run.totalTokens > 0)
})

test('each workflow agent opens like a subagent, tagged with its run', () => {
  const transcript = replay(messages)
  const [run] = only(transcript)
  const mirrors = listAgents(transcript)
  assert.equal(mirrors.length, 3)
  for (const agent of run.agents) {
    const mirror = findAgent(transcript, workflowAgentKey(agent.agentId))
    assert.equal(mirror.workflow, run.toolUseId)
    assert.equal(mirror.status, 'completed')
    assert.equal(mirror.description, agent.label)
    assert.equal(mirror.agentId, agent.agentId)
  }
})

test('mid-run the card shows what is running', () => {
  const cut = messages.findIndex((message) => message.subtype === 'task_progress' && message.workflow_progress?.length > 2)
  const transcript = replay(messages.slice(0, cut + 1))
  const [run] = only(transcript)
  assert.equal(run.status, 'running')
  assert.ok(run.agents.some((agent) => agent.state !== 'done'))
  // The model's turn ending does not settle a background run.
  const turnEnd = messages.findIndex((message) => message.type === 'result')
  const atTurnEnd = replay(messages.slice(0, turnEnd + 1))
  assert.equal(only(atTurnEnd)[0].status, 'running')
  assert.ok(listAgents(atTurnEnd).every((agent) => agent.status === 'running' || agent.status === 'completed'))
})

test('a stopped run stops its unfinished agents', () => {
  const cut = messages.findIndex((message) => message.subtype === 'task_progress' && message.workflow_progress?.length > 2)
  const transcript = replay(messages.slice(0, cut + 1))
  const [run] = only(transcript)
  applyMessage(transcript, { type: 'system', subtype: 'task_updated', task_id: run.taskId, patch: { status: 'killed' }, uuid: 'k1', session_id: 's' })
  assert.equal(run.status, 'stopped')
  assert.ok(run.agents.every((agent) => agent.state === 'done' || agent.state === 'error'))
})

test('replaying the stream twice changes nothing', () => {
  const once = replay(messages)
  const twice = replay([...messages, ...messages])
  assert.equal(twice.nodes.length, once.nodes.length)
  assert.equal(only(twice)[0].agents.length, 3)
})

test('history: the task notification settles the card instead of drawing a bubble', () => {
  const launch = messages.find((message) => message.type === 'assistant' && message.message.content.some((block) => block.type === 'tool_use'))
  const receipt = messages.find((message) => message.type === 'user')
  const run = only(replay(messages))[0]
  const notification = {
    type: 'user',
    uuid: 'n1',
    session_id: 's',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${run.taskId}</task-id>\n<tool-use-id>${run.toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Dynamic workflow "x" completed</summary>\n</task-notification>`,
    },
  }
  const transcript = emptyTranscript()
  for (const entry of [launch, receipt, notification]) applyHistoryMessage(transcript, entry)
  assert.deepEqual(transcript.nodes.map((node) => node.kind), ['tool'])
  const [loaded] = only(transcript)
  assert.equal(loaded.status, 'completed')
  assert.equal(loaded.taskId, run.taskId)
  assert.equal(loaded.runId, run.runId)
  assert.deepEqual(listUserPromptUuids([notification]), [])

  // The saved record fills in the agents the stream would have.
  const last = messages.filter((message) => message.workflow_progress).at(-1)
  applyWorkflowRecord(transcript, loaded, { runId: run.runId, status: 'completed', workflowProgress: last.workflow_progress, totalTokens: 73174 })
  assert.equal(loaded.agents.length, 3)
  assert.equal(loaded.totalTokens, 73174)
  assert.equal(listAgents(transcript).length, 3)
})

test('parses task notifications and unframes harness prompts', () => {
  assert.equal(parseTaskNotification('hello'), null)
  assert.deepEqual(parseTaskNotification('<task-notification>\n<task-id>t1</task-id>\n<status>killed</status>\n</task-notification>'), {
    taskId: 't1',
    status: 'killed',
  })
  const framed = '[Workflow harness — computed task] The task text below was computed. The computed task text follows:\n  Count lines.\n  \n  Steps:\n    1. wc'
  assert.equal(unframeWorkflowPrompt(framed), 'Count lines.\n\nSteps:\n  1. wc')
  assert.equal(unframeWorkflowPrompt('plain'), 'plain')
})
