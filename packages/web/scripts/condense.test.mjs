import assert from 'node:assert/strict'
import { test } from 'node:test'

import { condense, editStats, stepTarget, summarizeSteps, toolVerb } from '../src/render/condense.ts'
import { lastTurnStart } from '../src/render/nodes.ts'

const user = (id) => ({ kind: 'user', id, text: 'go', attachments: 0 })
const text = (id, body) => ({ kind: 'assistant', id, blocks: [{ type: 'text', text: body }] })
const think = (id, body, reply) => ({
  kind: 'assistant',
  id,
  blocks: [{ type: 'thinking', text: body }, ...(reply ? [{ type: 'text', text: reply }] : [])],
})
const tool = (id, name, input = {}, status = 'done') => ({ kind: 'tool', id, toolUseId: id, name, input, status })
const result = (id, durationMs = 1000) => ({
  kind: 'result', id, isError: false, durationMs, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
})

const layout = (nodes, settled = false) => condense(nodes, lastTurnStart(nodes), settled)
/** The shape alone: steps by key, folds with what they hold. */
const shape = (items) =>
  items.map((item) =>
    item.type === 'steps'
      ? item.steps.map((step) => step.key)
      : item.type === 'fold'
        ? { fold: item.outcome, steps: item.stepCount, items: shape(item.items) }
        : item.key,
  )

test('a running turn shows consecutive steps as one run, broken by the text between them', () => {
  const nodes = [
    user('u'),
    tool('t1', 'Bash'),
    tool('t2', 'Read'),
    text('a1', 'now the frontend'),
    tool('t3', 'Grep', {}, 'running'),
  ]
  assert.deepEqual(shape(layout(nodes)), ['u', ['t1', 't2'], 'a1:0', ['t3']])
})

test('a finished turn folds its process and keeps the reply and result outside', () => {
  const nodes = [
    user('u'),
    tool('t1', 'Bash'),
    text('a1', 'halfway'),
    tool('t2', 'Edit'),
    think('a2', 'done?', 'All done.'),
    result('r', 107_000),
  ]
  const items = layout(nodes)
  assert.deepEqual(shape(items), [
    'u',
    { fold: 'done', steps: 3, items: [['t1'], 'a1:0', ['t2', 'a2:0']] },
    'a2:1',
    'r',
  ])
  assert.equal(items[1].durationMs, 107_000)
})

test('an earlier turn without a result row folds as ended once the next prompt opens a turn', () => {
  const nodes = [user('u1'), tool('t1', 'Bash', {}, 'running'), user('u2'), tool('t2', 'Bash', {}, 'running')]
  const items = layout(nodes)
  assert.deepEqual(shape(items), ['u1', { fold: 'ended', steps: 1, items: [['t1']] }, 'u2', ['t2']])
  // The call the first turn left running lost its runner; the newest one has not.
  assert.equal(items[1].items[0].steps[0].stale, true)
  assert.equal(items[3].steps[0].stale, false)
})

test('a settled session folds its newest turn too', () => {
  const nodes = [user('u'), tool('t1', 'Read'), text('a', 'here')]
  assert.deepEqual(shape(layout(nodes, true)), ['u', { fold: 'ended', steps: 1, items: [['t1']] }, 'a:0'])
})

test('a turn with nothing but text, or a slash command\'s output, is not folded', () => {
  const nodes = [
    user('u1'), text('a', 'hi'), result('r'),
    user('u2'), { kind: 'localOutput', id: 'lo', content: 'ctx' },
    user('u3'),
  ]
  assert.deepEqual(shape(layout(nodes)), ['u1', 'a:0', 'r', 'u2', 'lo', 'u3'])
})

test('subagent cards stay whole cards, and count towards the fold', () => {
  const nodes = [user('u'), tool('t1', 'Read'), tool('ag', 'Agent'), tool('t2', 'Read'), text('a', 'ok'), result('r')]
  assert.deepEqual(shape(layout(nodes)), [
    'u',
    { fold: 'done', steps: 3, items: [['t1'], 'ag', ['t2']] },
    'a:0',
    'r',
  ])
})

test('repeated node ids still get distinct keys', () => {
  const nodes = [user('u'), tool('call_0', 'Bash'), text('a', 'x'), tool('call_0', 'Bash', {}, 'running')]
  assert.deepEqual(shape(layout(nodes)), ['u', ['call_0'], 'a:0', ['call_0#1']])
})

test('a run is summarized by kind, counting files once however often they were touched', () => {
  const step = (name, input) => ({ kind: 'tool', key: name + JSON.stringify(input), node: tool('x', name, input), stale: false })
  const steps = [
    step('Bash', { command: 'ls' }),
    step('Bash', { command: 'pwd' }),
    step('Read', { file_path: '/a' }),
    step('Read', { file_path: '/a', offset: 10 }),
    step('Edit', { file_path: '/b' }),
    step('Grep', { pattern: 'x' }),
    step('TodoWrite', {}),
  ]
  assert.equal(summarizeSteps(steps), '运行了 2 条命令，读取了 1 个文件，修改了 1 个文件，搜索了 1 次，调用了 1 个工具')
  assert.equal(summarizeSteps([{ kind: 'thinking', key: 'k', text: 'hmm' }]), '思考')
})

test('a step names its call by description, then path relative to the session, then pattern', () => {
  assert.equal(stepTarget(tool('x', 'Bash', { command: 'pnpm test', description: 'Run tests' })), 'Run tests')
  assert.equal(stepTarget(tool('x', 'Bash', { command: 'a\nb' })), 'a')
  assert.equal(stepTarget(tool('x', 'Read', { file_path: '/repo/src/a.ts' }), '/repo'), 'src/a.ts')
  assert.equal(stepTarget(tool('x', 'Read', { file_path: '/elsewhere/a.ts' }), '/repo'), '/elsewhere/a.ts')
  assert.equal(stepTarget(tool('x', 'Grep', { pattern: 'useStore', path: 'src' })), 'useStore')
})

test('an MCP tool goes by its own name, without the server prefix', () => {
  assert.deepEqual(toolVerb('mcp__chrome-devtools__list_pages'), { category: 'other', verb: 'list_pages' })
  assert.deepEqual(toolVerb('TodoWrite'), { category: 'other', verb: 'TodoWrite' })
  assert.deepEqual(toolVerb('Write'), { category: 'edit', verb: '写入' })
})

test('edit stats count the lines the diff draws', () => {
  assert.deepEqual(editStats(tool('x', 'Edit', { old_string: 'a', new_string: 'a\nb\nc' })), { added: 3, removed: 1 })
  assert.deepEqual(editStats(tool('x', 'Write', { content: 'x\ny' })), { added: 2, removed: 0 })
  assert.equal(editStats(tool('x', 'Read', {})), null)
})
