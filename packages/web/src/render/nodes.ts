import type { SDKMessage } from '@ccw/shared'

import {
  applyWorkflowEvent,
  registerWorkflow,
  settleWorkflowLaunch,
  unframeWorkflowPrompt,
  WORKFLOW_TOOL,
  type TaskNotice,
  type WorkflowRun,
} from './workflows.ts'

/** A finalized piece of assistant output. Tool calls become their own node. */
export type AssistantBlock = { type: 'text' | 'thinking'; text: string }

export type ToolStatus = 'running' | 'done' | 'error'

export type ChatNode =
  | { kind: 'user'; id: string; text: string; attachments: number }
  | { kind: 'assistant'; id: string; blocks: AssistantBlock[] }
  | {
      kind: 'tool'
      id: string
      toolUseId: string
      name: string
      input: Record<string, unknown>
      status: ToolStatus
      output?: string
      /** The tool's full Output object — richer than the model-facing text. */
      structured?: unknown
      elapsedSeconds?: number
    }
  | { kind: 'localOutput'; id: string; content: string }
  | { kind: 'notice'; id: string; level: 'info' | 'notice' | 'suggestion' | 'warning' | 'error'; text: string }
  | {
      kind: 'compact'
      id: string
      /** Absent when read from history: the boundary survives on disk as a bare envelope. */
      trigger?: 'manual' | 'auto'
      preTokens?: number
      postTokens?: number
      /** What the model carries on from in place of the conversation before it. */
      summary?: string
    }
  | {
      kind: 'result'
      id: string
      isError: boolean
      durationMs: number
      numTurns: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
    }

/** Text still arriving for the block the model is mid-way through emitting. */
export type StreamingBlock = { type: 'text' | 'thinking'; text: string }

/** One Anthropic Messages API streaming event, as the SDK forwards it. */
type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event']

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * One subagent spawned by an `Agent` (formerly `Task`) tool call, keyed by
 * that tool_use id — the id every message the subagent emits carries as its
 * `parent_tool_use_id`, and the one `task_*` system events point back at.
 */
export type AgentRun = {
  toolUseId: string
  /** The CLI's task id, which is also the subagent transcript's file name. */
  agentId?: string
  description: string
  subagentType?: string
  prompt: string
  status: AgentStatus
  backgrounded: boolean
  /** Latest `task_progress` description, e.g. "Reading alpha.txt". */
  activity?: string
  lastTool?: string
  toolUses: number
  totalTokens: number
  durationMs: number
  /** The report the subagent handed back to its parent. */
  summary?: string
  model?: string
  /** Its own conversation, rendered when the user opens the subagent. */
  transcript: Transcript
  /** Whether the on-disk subagent transcript has been folded in. */
  historyLoaded: boolean
  /** Set when this is one agent of a dynamic workflow: that run's toolUseId. */
  workflow?: string
}

export type Transcript = {
  nodes: ChatNode[]
  /** Subagents spawned from this transcript's tool calls. */
  agents: Record<string, AgentRun>
  /** toolUseIds in spawn order, for the agent strip. */
  agentOrder: string[]
  /** Dynamic workflows launched from this transcript, keyed by Workflow tool_use id. */
  workflows: Record<string, WorkflowRun>
  streaming: StreamingBlock | null
  /** toolUseId → index into `nodes`, so tool results land on the right card. */
  toolIndex: Record<string, number>
  /**
   * Envelope uuids already folded in. The SDK treats the uuid as an idempotency
   * key and it is identical between the live stream and the jsonl history, so
   * history replay, backlog replay, and live events can overlap safely.
   */
  seen: Record<string, true>
  /**
   * Replayed task notifications whose card was not found — on a history page
   * newer than the one that launched the task. Retried as older pages land.
   */
  pendingNotices: TaskNotice[]
}

export function emptyTranscript(): Transcript {
  return { nodes: [], agents: {}, agentOrder: [], workflows: {}, streaming: null, toolIndex: {}, seen: {}, pendingNotices: [] }
}

/**
 * Index of the first node of the newest turn.
 *
 * A tool call cannot outlive the turn that made it, so a card still marked
 * `running` *before* this point lost its runner — a crashed CLI never sends
 * the tool_result that would settle it — no matter what the session is doing
 * now. Without that, sending a follow-up after a crash would put 执行中 back
 * on the cards the crash already ended.
 *
 * A `result` row closes a turn, and a prompt opens the next; a turn without a
 * model call has no result row, and history rebuilds none for a turn still
 * running, so a prompt can be the only boundary. The newest turn has no
 * boundary after it yet — whether its calls are still alive is the session's
 * state to answer, not the transcript's.
 */
export function lastTurnStart(nodes: ChatNode[]): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const kind = nodes[index]!.kind
    if (kind === 'user' || kind === 'result') return index + 1
  }
  return 0
}

/**
 * Folds one SDK message into the transcript. Mutates in place — callers run it
 * inside Immer's draft.
 *
 * Streaming and finalization are deliberately split: `stream_event` only feeds
 * the transient tail preview, while `assistant` messages are the source of
 * truth for structure. The CLI delivers one finalized block per `assistant`
 * message when partial messages are on, so the preview is cleared each time one
 * lands.
 *
 * `SDKMessage` is an open union — unrecognized variants must be ignored, not
 * thrown on, or a newer CLI would break the transcript.
 */
export function applyMessage(transcript: Transcript, message: SDKMessage): void {
  // Subagent output carries the spawning tool_use id. Folding it into the
  // parent's node list (as this renderer once did) shows a subagent's Read as
  // if the main thread made it, and the cards vanish on reload because the
  // main JSONL never contains them — so route it into the subagent's own
  // transcript instead.
  if (message.type === 'system') {
    if (transcript.seen[message.uuid]) return
    applyTaskEvent(transcript, message)
  }
  const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id
  if (parent && message.type !== 'system' && message.type !== 'result') {
    // A tool_progress parent is usually the tool being timed — a main-thread
    // Bash's heartbeat points at that Bash — so it never conjures a subagent.
    const agent =
      findAgent(transcript, parent) ?? (message.type === 'tool_progress' ? null : placeholderAgent(transcript, parent))
    if (agent) {
      applyLocal(agent.transcript, message, true)
      return
    }
  }
  applyLocal(transcript, message, false)
}

function applyLocal(transcript: Transcript, message: SDKMessage, inAgent: boolean): void {
  // stream_event and tool_progress are exempt from dedup: both fire at high
  // frequency with per-event uuids, reapplying them is harmless, and recording
  // each one would only bloat the seen map.
  if (message.type !== 'stream_event' && message.type !== 'tool_progress') {
    const uuid = (message as { uuid?: string }).uuid
    if (uuid) {
      if (transcript.seen[uuid]) return
      transcript.seen[uuid] = true
    }
  }
  switch (message.type) {
    case 'stream_event':
      applyStreamEvent(transcript, message.event)
      return

    case 'assistant': {
      transcript.streaming = null
      const messageId = message.message.id
      for (const block of message.message.content) {
        if (block.type === 'text') {
          appendAssistantBlock(transcript, messageId, { type: 'text', text: block.text })
        } else if (block.type === 'thinking') {
          if (block.thinking) appendAssistantBlock(transcript, messageId, { type: 'thinking', text: block.thinking })
        } else if (block.type === 'tool_use') {
          transcript.toolIndex[block.id] = transcript.nodes.length
          transcript.nodes.push({
            kind: 'tool',
            id: block.id,
            toolUseId: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
            status: 'running',
          })
          if (AGENT_TOOLS.has(block.name)) registerAgent(transcript, block.id, (block.input ?? {}) as Record<string, unknown>)
          if (block.name === WORKFLOW_TOOL) registerWorkflow(transcript, block.id, (block.input ?? {}) as Record<string, unknown>)
        }
      }
      return
    }

    case 'user': {
      const content = message.message.content
      // A compaction's summary follows its boundary as a synthetic prompt.
      const last = transcript.nodes.at(-1)
      if (message.isSynthetic && last?.kind === 'compact' && last.summary === undefined) {
        last.summary = dropToolsUsedLine(userText(content))
        return
      }
      // The parent's prompt arrives as the subagent's first user message; it
      // is the only place the conversation is told what it was asked to do.
      if (inAgent) {
        const text = userText(content)
        if (text) {
          transcript.nodes.push({
            kind: 'user',
            id: message.uuid ?? `u${transcript.nodes.length}`,
            text: unframeWorkflowPrompt(text),
            attachments: 0,
          })
        }
      }
      if (typeof content === 'string') return
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        const agent = transcript.agents[block.tool_use_id]
        if (agent) settleAgent(agent, block.is_error === true, flattenToolResult(block.content), message.tool_use_result)
        const workflow = transcript.workflows[block.tool_use_id]
        if (workflow) settleWorkflowLaunch(workflow, block.is_error === true, flattenToolResult(block.content))
        const node = toolNode(transcript, block.tool_use_id)
        if (!node) continue
        node.status = block.is_error ? 'error' : 'done'
        node.output = flattenToolResult(block.content)
        if (message.tool_use_result !== undefined) node.structured = message.tool_use_result
      }
      return
    }

    case 'tool_progress': {
      // Heartbeats and bash_progress carry an id of their own (`bash-progress-3`)
      // and name the timed tool as their parent.
      const node =
        toolNode(transcript, message.tool_use_id) ??
        (message.parent_tool_use_id ? toolNode(transcript, message.parent_tool_use_id) : null)
      if (node) node.elapsedSeconds = message.elapsed_time_seconds
      return
    }

    case 'result':
      transcript.streaming = null
      // A finished turn leaves no foreground subagent running; a stale badge
      // would otherwise outlive a missed task_notification.
      for (const agent of Object.values(transcript.agents)) {
        if (agent.status === 'running' && !agent.backgrounded) agent.status = 'completed'
      }
      // A slash command the CLI ran itself made no model call — nothing to
      // report, and nothing a reload could rebuild the row from.
      if (message.num_turns === 0) return
      // `total_cost_usd` is left out: it is the session's running total, not
      // this turn's, and the transcript keeps no cost to rebuild it from.
      transcript.nodes.push({
        kind: 'result',
        id: message.uuid,
        isError: message.is_error,
        durationMs: message.duration_ms,
        numTurns: message.num_turns,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      })
      return

    case 'system':
      applySystem(transcript, message)
      return

    default:
      return
  }
}

function applySystem(transcript: Transcript, message: Extract<SDKMessage, { type: 'system' }>): void {
  switch (message.subtype) {
    case 'local_command_output':
      transcript.nodes.push({ kind: 'localOutput', id: message.uuid, content: message.content })
      return

    case 'informational':
      transcript.nodes.push({ kind: 'notice', id: message.uuid, level: message.level, text: message.content })
      return

    case 'permission_denied':
      transcript.nodes.push({
        kind: 'notice',
        id: message.uuid,
        level: 'warning',
        text: `${message.tool_name} 被拒绝：${message.decision_reason ?? message.message}`,
      })
      return

    case 'compact_boundary':
      transcript.nodes.push({
        kind: 'compact',
        id: message.uuid,
        trigger: message.compact_metadata.trigger,
        preTokens: message.compact_metadata.pre_tokens,
        ...(message.compact_metadata.post_tokens !== undefined
          ? { postTokens: message.compact_metadata.post_tokens }
          : {}),
      })
      return

    default:
      return
  }
}

function applyStreamEvent(transcript: Transcript, event: StreamEvent): void {
  switch (event.type) {
    case 'message_start':
      transcript.streaming = null
      return

    case 'content_block_start': {
      const block = event.content_block
      transcript.streaming =
        block.type === 'thinking'
          ? { type: 'thinking', text: '' }
          : block.type === 'text'
            ? { type: 'text', text: '' }
            : // tool_use arguments stream as partial JSON; the card renders
              // once the finalized assistant message carries parsed input.
              null
      return
    }

    case 'content_block_delta': {
      if (!transcript.streaming) return
      const delta = event.delta
      if (delta.type === 'text_delta') transcript.streaming.text += delta.text
      else if (delta.type === 'thinking_delta') transcript.streaming.text += delta.thinking
      return
    }

    default:
      return
  }
}

/** Appends to the trailing assistant node when it belongs to the same message. */
function appendAssistantBlock(transcript: Transcript, messageId: string, block: AssistantBlock): void {
  const last = transcript.nodes.at(-1)
  if (last?.kind === 'assistant' && last.id.startsWith(`${messageId}#`)) {
    const tail = last.blocks.at(-1)
    // Consecutive same-type blocks are one visual paragraph run.
    if (tail && tail.type === block.type) tail.text += block.text
    else last.blocks.push(block)
    return
  }
  transcript.nodes.push({ kind: 'assistant', id: `${messageId}#${transcript.nodes.length}`, blocks: [block] })
}

function toolNode(transcript: Transcript, toolUseId: string): Extract<ChatNode, { kind: 'tool' }> | null {
  const index = transcript.toolIndex[toolUseId]
  if (index === undefined) return null
  const node = transcript.nodes[index]
  return node?.kind === 'tool' ? node : null
}

/** A user message's text, whether it came as a string or as blocks. */
export function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

/**
 * A line the CLI writes for the model, naming tools it has not seen used: it
 * opens a subagent's hand-back (2.1.312) and sits in a compaction summary,
 * bare on 2.1.310 and alone in a reminder on 2.1.312. The CLI escapes the tag
 * anywhere else, so such a line is always this one.
 */
const TOOLS_USED = String.raw`<tools-used-before-summary>[^<\n]*</tools-used-before-summary>`
const TOOLS_USED_LINE = new RegExp(
  String.raw`^[ \t]*(?:<system-reminder>\n[ \t]*${TOOLS_USED}[ \t]*\n</system-reminder>|${TOOLS_USED})[ \t]*\n?`,
  'gm',
)

export function dropToolsUsedLine(text: string): string {
  return text.replace(TOOLS_USED_LINE, '')
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const typed = block as { type?: string; text?: string }
      if (typed.type === 'text') return typed.text ?? ''
      if (typed.type === 'image') return '[image]'
      return ''
    })
    .join('')
}

/** Tool names that spawn a subagent: `Agent` today, `Task` on older CLIs. */
export const AGENT_TOOLS = new Set(['Agent', 'Task'])

/** Finds a subagent anywhere in the tree — subagents can spawn subagents. */
export function findAgent(transcript: Transcript, toolUseId: string): AgentRun | null {
  const direct = transcript.agents[toolUseId]
  if (direct) return direct
  for (const id of transcript.agentOrder) {
    const nested = transcript.agents[id] && findAgent(transcript.agents[id]!.transcript, toolUseId)
    if (nested) return nested
  }
  return null
}

/** Every subagent in the tree, parents before their children. */
export function listAgents(transcript: Transcript): AgentRun[] {
  const out: AgentRun[] = []
  for (const id of transcript.agentOrder) {
    const agent = transcript.agents[id]
    if (!agent) continue
    out.push(agent, ...listAgents(agent.transcript))
  }
  return out
}

export function findAgentById(transcript: Transcript, agentId: string): AgentRun | null {
  return listAgents(transcript).find((agent) => agent.agentId === agentId) ?? null
}

function registerAgent(transcript: Transcript, toolUseId: string, input: Record<string, unknown>): AgentRun {
  const existing = transcript.agents[toolUseId]
  const description = typeof input['description'] === 'string' ? input['description'] : ''
  const prompt = typeof input['prompt'] === 'string' ? input['prompt'] : ''
  const subagentType = typeof input['subagent_type'] === 'string' ? input['subagent_type'] : undefined
  if (existing) {
    if (description) existing.description = description
    if (prompt) existing.prompt = prompt
    if (subagentType) existing.subagentType = subagentType
    return existing
  }
  const agent: AgentRun = {
    toolUseId,
    description,
    prompt,
    ...(subagentType ? { subagentType } : {}),
    status: 'running',
    backgrounded: input['run_in_background'] === true,
    toolUses: 0,
    totalTokens: 0,
    durationMs: 0,
    transcript: emptyTranscript(),
    historyLoaded: false,
  }
  transcript.agents[toolUseId] = agent
  transcript.agentOrder.push(toolUseId)
  return agent
}

/**
 * Output for a subagent whose Agent call this transcript never saw — a reload
 * that replays the backlog of a turn whose spawning message the history read
 * did not include yet. Kept rather than dropped, so nothing it did is lost.
 */
function placeholderAgent(transcript: Transcript, toolUseId: string): AgentRun {
  return registerAgent(transcript, toolUseId, { description: '子代理' })
}

type SystemMessage = Extract<SDKMessage, { type: 'system' }>

/** `task_started` / `task_progress` / `task_updated` / `task_notification`. */
function applyTaskEvent(transcript: Transcript, message: SystemMessage): void {
  const event = message as unknown as {
    subtype: string
    task_id?: string
    tool_use_id?: string
    task_type?: string
    description?: string
    subagent_type?: string
    is_backgrounded?: boolean
    last_tool_name?: string
    summary?: string
    status?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
    patch?: { status?: string; is_backgrounded?: boolean }
  }
  if (!event.subtype?.startsWith('task_') || !event.task_id) return
  if (applyWorkflowEvent(transcript, message as never)) return
  let agent = event.tool_use_id ? findAgent(transcript, event.tool_use_id) : null
  agent ??= findAgentById(transcript, event.task_id)
  if (!agent) {
    // Shell tasks and workflows share the event family; only subagents get a card.
    if (event.subtype !== 'task_started' || event.task_type !== 'local_agent' || !event.tool_use_id) return
    agent = registerAgent(transcript, event.tool_use_id, { description: event.description ?? '子代理' })
  }
  agent.agentId = event.task_id
  if (event.subagent_type) agent.subagentType = event.subagent_type
  if (event.usage) {
    agent.totalTokens = event.usage.total_tokens
    agent.toolUses = event.usage.tool_uses
    agent.durationMs = event.usage.duration_ms
  }
  switch (event.subtype) {
    case 'task_started':
      if (!agent.description && event.description) agent.description = event.description
      agent.backgrounded = event.is_backgrounded === true
      if (agent.status !== 'running' && !agent.summary) agent.status = 'running'
      return
    case 'task_progress':
      if (event.description) agent.activity = event.description
      if (event.last_tool_name) agent.lastTool = event.last_tool_name
      if (event.summary) agent.activity = event.summary
      return
    case 'task_updated':
      if (event.patch?.is_backgrounded !== undefined) agent.backgrounded = event.patch.is_backgrounded
      if (event.patch?.status && isAgentStatus(event.patch.status)) agent.status = event.patch.status
      return
    case 'task_notification':
      if (event.status && isAgentStatus(event.status)) agent.status = event.status
      if (event.summary && !agent.summary) agent.summary = event.summary
      agent.activity = undefined
      return
  }
}

function isAgentStatus(value: string): value is AgentStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'stopped'
}

/** The Agent call's tool_result: the hand-back report plus its run totals. */
function settleAgent(agent: AgentRun, isError: boolean, output: string, structured: unknown): void {
  const result = (structured ?? {}) as {
    status?: string
    agentId?: string
    content?: { type: string; text?: string }[]
    totalTokens?: number
    totalToolUseCount?: number
    totalDurationMs?: number
    resolvedModel?: string
  }
  // A backgrounded agent's call returns at once with a launch receipt; the
  // run itself is settled later by task_notification.
  const launched = result.status === 'async_launched' || /running in the background/i.test(output.slice(0, 400))
  if (launched) {
    agent.backgrounded = true
  } else {
    // A stop lands as task_notification first and an error tool_result
    // after it; the user asked for the stop, so it is not a failure.
    agent.status = agent.status === 'stopped' ? 'stopped' : isError ? 'failed' : 'completed'
    agent.activity = undefined
  }
  if (result.agentId) agent.agentId = result.agentId
  if (result.totalTokens !== undefined) agent.totalTokens = result.totalTokens
  if (result.totalToolUseCount !== undefined) agent.toolUses = result.totalToolUseCount
  if (result.totalDurationMs !== undefined) agent.durationMs = result.totalDurationMs
  if (result.resolvedModel) agent.model = result.resolvedModel
  const text = result.content
    ?.filter((block) => block.type === 'text')
    .map((block) => dropToolsUsedLine(block.text ?? ''))
    .filter(Boolean)
    .join('\n')
  if (!launched) {
    const report = text || parseHandBack(output)
    if (report) agent.summary = report
  }
  agent.agentId ??= /\bagentId: ([\w-]+)/.exec(output)?.[1]
}

/**
 * History carries only the model-facing text of the Agent result: a framing
 * paragraph, the indented report, then an `agentId:` trailer.
 */
export function parseHandBack(output: string): string {
  const marker = output.indexOf('The report follows:\n')
  if (marker < 0) return output.trim()
  let body = output.slice(marker + 'The report follows:\n'.length)
  const trailer = body.search(/\nagentId: /)
  if (trailer >= 0) body = body.slice(0, trailer)
  return body
    .split('\n')
    .map((line) => line.replace(/^  /, ''))
    .join('\n')
    .trim()
}
