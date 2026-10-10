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
