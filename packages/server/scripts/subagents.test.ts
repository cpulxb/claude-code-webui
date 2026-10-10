import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const root = await mkdtemp(join(tmpdir(), 'ccw-subagents-'))
process.env['CLAUDE_CONFIG_DIR'] = root
const { listSubagentMeta, readSubagentMessages } = await import('../src/history/sessions.ts')

const sessionId = '11111111-2222-3333-4444-555555555555'
const project = join(root, 'projects', '-work-demo')
const dir = join(project, sessionId, 'subagents')
await mkdir(dir, { recursive: true })
await writeFile(join(project, `${sessionId}.jsonl`), '')

const lines = [
  { type: 'user', uuid: 'u1', isSidechain: true, message: { role: 'user', content: 'Read alpha.txt' } },
  { type: 'attachment', uuid: 'x1', attachment: { type: 'environment' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
  { type: 'user', uuid: 'u2', isMeta: true, message: { role: 'user', content: 'reminder' } },
  { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'MANGO' }] } },
]
await writeFile(join(dir, 'agent-aaa111.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n{"type":"assist`)
await writeFile(join(dir, 'agent-aaa111.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Read alpha', toolUseId: 'toolu_1' }))
await writeFile(join(dir, 'agent-bbb222.jsonl'), '')

test('lists subagents with the tool_use that spawned them', async () => {
  const agents = await listSubagentMeta(sessionId)
  agents.sort((a, b) => a.agentId.localeCompare(b.agentId))
  assert.deepEqual(agents, [
    { agentId: 'aaa111', toolUseId: 'toolu_1', description: 'Read alpha', agentType: 'general-purpose' },
    { agentId: 'bbb222' },
  ])
})

test('reads the whole subagent conversation in file order, skipping meta and attachments', async () => {
  const messages = await readSubagentMessages(sessionId, 'aaa111')
  assert.deepEqual(messages.map((message) => message.uuid), ['u1', 'a1', 'u3'])
  assert.ok(messages.every((message) => message.parent_tool_use_id === null))
})

test('unknown sessions and agents read as empty; path tricks are refused', async () => {
  assert.deepEqual(await listSubagentMeta('00000000-0000-0000-0000-000000000000'), [])
  assert.deepEqual(await readSubagentMessages(sessionId, 'nope'), [])
  await assert.rejects(readSubagentMessages(sessionId, '../../etc'))
})

// Dynamic workflows keep agents under subagents/workflows/<runId>/ and the
// finished run record under <session>/workflows/<runId>.json.
const { readWorkflowRun } = await import('../src/history/sessions.ts')
const runDir = join(dir, 'workflows', 'wf_abc-123')
await mkdir(runDir, { recursive: true })
await writeFile(join(runDir, 'agent-wwf111.jsonl'), `${JSON.stringify(lines[0])}\n`)
await writeFile(
  join(runDir, 'journal.jsonl'),
  [
    { type: 'launched' },
    { type: 'started', key: 'k1', agentId: 'wwf111', label: 'count:a', phase: 'Count' },
    { type: 'started', key: 'k2', agentId: 'wwf222', label: 'count:b', phase: 'Count' },
    { type: 'result', key: 'k1', agentId: 'wwf111', result: { lines: 7 } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n'),
)

test('opens a workflow agent from its run directory', async () => {
  const messages = await readSubagentMessages(sessionId, 'wwf111')
  assert.deepEqual(messages.map((message) => message.uuid), ['u1'])
})

test('rebuilds an unfinished workflow run from its journal', async () => {
  const run = await readWorkflowRun(sessionId, 'wf_abc-123')
  assert.deepEqual(run, {
    runId: 'wf_abc-123',
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Count' },
      { type: 'workflow_agent', index: 1, label: 'count:a', agentId: 'wwf111', phaseTitle: 'Count', phaseIndex: 1, state: 'done', resultPreview: '{"lines":7}' },
      { type: 'workflow_agent', index: 2, label: 'count:b', agentId: 'wwf222', phaseTitle: 'Count', phaseIndex: 1, state: 'progress' },
    ],
  })
})

test('prefers the saved run record once the run finished', async () => {
  await mkdir(join(project, sessionId, 'workflows'), { recursive: true })
  await writeFile(
    join(project, sessionId, 'workflows', 'wf_abc-123.json'),
    JSON.stringify({ runId: 'wf_abc-123', taskId: 't9', workflowName: 'count', status: 'completed', totalTokens: 10, workflowProgress: [], logs: 'x' }),
  )
  const run = await readWorkflowRun(sessionId, 'wf_abc-123')
  assert.deepEqual(run, { runId: 'wf_abc-123', taskId: 't9', workflowName: 'count', status: 'completed', workflowProgress: [], totalTokens: 10 })
  await assert.rejects(readWorkflowRun(sessionId, '../x'))
})
