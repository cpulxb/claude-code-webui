import type { ChatNode } from './nodes.ts'
import { AGENT_TOOLS, rowKeys } from './nodes.ts'
import { WORKFLOW_TOOL } from './workflows.ts'

/**
 * The condensed chat layout: the same nodes as the detailed one, regrouped so
 * a long turn reads in a few lines. Two levels, after claude.ai and DeepSeek:
 * consecutive tool calls and thinking fold into one summary line, and a
 * finished turn folds everything before its reply under one more.
 */

type ToolNode = Extract<ChatNode, { kind: 'tool' }>

/** One line of a condensed run: a tool call, or a stretch of thinking. */
export type Step =
  | { kind: 'tool'; key: string; node: ToolNode; stale: boolean }
  | { kind: 'thinking'; key: string; text: string }

export type CondensedItem =
  /** Drawn as the detailed view draws it: prompts, notices, results, subagent and workflow cards. */
  | { type: 'node'; key: string; index: number }
  | { type: 'text'; key: string; text: string }
  | { type: 'steps'; key: string; steps: Step[] }
  | {
      type: 'fold'
      key: string
      /** From the turn's result row; `ended` when it has none — interrupted, or a subagent's. */
      outcome: 'done' | 'error' | 'ended'
      durationMs: number | null
      stepCount: number
      items: CondensedItem[]
    }

export type StepCategory = 'command' | 'read' | 'edit' | 'search' | 'web' | 'other'

const TOOL_VERBS: Record<string, [StepCategory, string]> = {
  Bash: ['command', '运行'],
  Read: ['read', '读取'],
  Edit: ['edit', '编辑'],
  Write: ['edit', '写入'],
  NotebookEdit: ['edit', '编辑'],
  Grep: ['search', '搜索'],
  Glob: ['search', '查找'],
  WebSearch: ['web', '搜索网页'],
  WebFetch: ['web', '访问'],
}

/**
 * What a step row says it did; a tool without a verb of its own goes by its
 * name — an MCP tool's without the `mcp__<server>__` in front.
 */
export function toolVerb(name: string): { category: StepCategory; verb: string } {
  const known = TOOL_VERBS[name]
  if (known) return { category: known[0], verb: known[1] }
  return { category: 'other', verb: /^mcp__.+?__(.+)$/.exec(name)?.[1] ?? name }
}

/**
 * Lays a node list out condensed. `newestTurn` and `settled` are the detailed
 * view's: a turn is over once a later boundary or the session says so.
 */
export function condense(nodes: ChatNode[], newestTurn: number, settled: boolean): CondensedItem[] {
  const keys = rowKeys(nodes)
  const out: CondensedItem[] = []
  let start = 0
  for (let index = 0; index <= nodes.length; index += 1) {
    if (index < nodes.length && nodes[index]!.kind !== 'user') continue
    out.push(...condenseTurn(nodes, keys, start, index, newestTurn, settled))
    if (index < nodes.length) out.push({ type: 'node', key: keys[index]!, index })
    start = index + 1
  }
  return out
}

/** One turn's output, `[start, end)`: everything after its prompt and before the next. */
function condenseTurn(
  nodes: ChatNode[],
  keys: string[],
  start: number,
  end: number,
  newestTurn: number,
  settled: boolean,
): CondensedItem[] {
  const runs = new Runs(nodes, keys, newestTurn, settled)
  let resultAt = -1
  for (let index = end - 1; index >= start; index -= 1) {
    if (nodes[index]!.kind === 'result') {
      resultAt = index
      break
    }
  }
  const bodyEnd = resultAt < 0 ? end : resultAt
  // A turn still running shows its steps as they come.
  if (!settled && bodyEnd >= newestTurn) {
    for (let index = start; index < end; index += 1) runs.add(index)
    return runs.items
  }

  // The reply is the assistant text after the last step; its thinking still
  // belongs to the process.
  let replyStart = bodyEnd
  while (replyStart > start && nodes[replyStart - 1]!.kind === 'assistant') replyStart -= 1
  for (let index = start; index < replyStart; index += 1) runs.add(index)
  const reply = new Runs(nodes, keys, newestTurn, settled)
  for (let index = replyStart; index < bodyEnd; index += 1) {
    const node = nodes[index] as Extract<ChatNode, { kind: 'assistant' }>
    node.blocks.forEach((block, at) => {
      const key = `${keys[index]}:${at}`
      if (block.type === 'thinking') runs.step({ kind: 'thinking', key, text: block.text })
      else reply.item({ type: 'text', key, text: block.text })
    })
  }
  for (let index = bodyEnd; index < end; index += 1) reply.item({ type: 'node', key: keys[index]!, index })

  // Nothing worth hiding — a slash command's output, a lone notice.
  if (runs.stepCount === 0) return [...runs.items, ...reply.items]
  const result = resultAt < 0 ? null : (nodes[resultAt] as Extract<ChatNode, { kind: 'result' }>)
  const fold: CondensedItem = {
    type: 'fold',
    key: `fold:${runs.items[0]!.key}`,
    outcome: result ? (result.isError ? 'error' : 'done') : 'ended',
    durationMs: result ? result.durationMs : null,
    stepCount: runs.stepCount,
    items: runs.items,
  }
  return [fold, ...reply.items]
}

/** Builds items in order, gathering consecutive steps into one run. */
class Runs {
  readonly items: CondensedItem[] = []
  /** Steps plus subagent and workflow cards: what a fold says it holds. */
  stepCount = 0
  private open: Step[] | null = null

  constructor(
    private readonly nodes: ChatNode[],
    private readonly keys: string[],
    private readonly newestTurn: number,
    private readonly settled: boolean,
  ) {}

  add(index: number): void {
    const node = this.nodes[index]!
    const key = this.keys[index]!
    if (node.kind === 'tool' && !AGENT_TOOLS.has(node.name) && node.name !== WORKFLOW_TOOL) {
      // The detailed view's rule: a call left running before the newest turn,
      // or once the session settled, lost its runner.
      const stale = node.status === 'running' && (this.settled || index < this.newestTurn)
      this.step({ kind: 'tool', key, node, stale })
    } else if (node.kind === 'assistant') {
      node.blocks.forEach((block, at) => {
        const blockKey = `${key}:${at}`
        if (block.type === 'thinking') this.step({ kind: 'thinking', key: blockKey, text: block.text })
        else this.item({ type: 'text', key: blockKey, text: block.text })
      })
    } else {
      if (node.kind === 'tool') this.stepCount += 1
      this.item({ type: 'node', key, index })
    }
  }

  step(step: Step): void {
    this.stepCount += 1
    if (!this.open) {
      this.open = []
      this.items.push({ type: 'steps', key: step.key, steps: this.open })
    }
    this.open.push(step)
  }

  item(item: CondensedItem): void {
    this.open = null
    this.items.push(item)
  }
}

/** A run's one-line summary, e.g. 运行了 3 条命令，读取了 2 个文件. */
export function summarizeSteps(steps: Step[]): string {
  let commands = 0
  const reads = new Set<string>()
  const edits = new Set<string>()
  let searches = 0
  let web = 0
  let other = 0
  for (const step of steps) {
    if (step.kind !== 'tool') continue
    const path = stringField(step.node.input, 'file_path') ?? stringField(step.node.input, 'notebook_path') ?? step.key
    switch (toolVerb(step.node.name).category) {
      case 'command':
        commands += 1
        break
      case 'read':
        reads.add(path)
        break
      case 'edit':
        edits.add(path)
        break
      case 'search':
        searches += 1
        break
      case 'web':
        web += 1
        break
      case 'other':
        other += 1
        break
    }
  }
  const parts = [
    commands > 0 ? `运行了 ${commands} 条命令` : '',
    reads.size > 0 ? `读取了 ${reads.size} 个文件` : '',
    edits.size > 0 ? `修改了 ${edits.size} 个文件` : '',
    searches > 0 ? `搜索了 ${searches} 次` : '',
    web > 0 ? `联网 ${web} 次` : '',
    other > 0 ? `调用了 ${other} 个工具` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join('，') : '思考'
}

/** The one field that says what a call was about, with paths inside `cwd` made relative. */
export function stepTarget(node: ToolNode, cwd?: string): string {
  const input = node.input
  const description = stringField(input, 'description')
  if (description) return description
  const path = stringField(input, 'file_path') ?? stringField(input, 'notebook_path')
  if (path) return relativeTo(path, cwd)
  const command = stringField(input, 'command')
  return (
    stringField(input, 'pattern') ??
    stringField(input, 'query') ??
    stringField(input, 'url') ??
    (command === null ? null : command.split('\n', 1)[0]!) ??
    stringField(input, 'path') ??
    ''
  )
}

/** Lines an Edit or Write adds and removes, as its diff draws them. */
export function editStats(node: ToolNode): { added: number; removed: number } | null {
  const lines = (text: string | null): number => (text ? text.split('\n').length : 0)
  if (node.name === 'Edit') {
    return { added: lines(stringField(node.input, 'new_string')), removed: lines(stringField(node.input, 'old_string')) }
  }
  if (node.name === 'Write') return { added: lines(stringField(node.input, 'content')), removed: 0 }
  return null
}

function relativeTo(path: string, cwd?: string): string {
  if (!cwd) return path
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' ? value : null
}
