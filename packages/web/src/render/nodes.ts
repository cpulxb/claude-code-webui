import type { SDKMessage } from '@ccw/shared'

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
  | { kind: 'compact'; id: string; trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number }
  | {
      kind: 'result'
      id: string
      isError: boolean
      durationMs: number
      numTurns: number
      totalCostUsd: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
    }

/** Text still arriving for the block the model is mid-way through emitting. */
export type StreamingBlock = { type: 'text' | 'thinking'; text: string }

/** One Anthropic Messages API streaming event, as the SDK forwards it. */
type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event']

export type Transcript = {
  nodes: ChatNode[]
  streaming: StreamingBlock | null
  /** toolUseId → index into `nodes`, so tool results land on the right card. */
  toolIndex: Record<string, number>
  /**
   * Envelope uuids already folded in. The SDK treats the uuid as an idempotency
   * key and it is identical between the live stream and the jsonl history, so
   * history replay, backlog replay, and live events can overlap safely.
   */
  seen: Record<string, true>
}

export function emptyTranscript(): Transcript {
  return { nodes: [], streaming: null, toolIndex: {}, seen: {} }
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
        }
      }
      return
    }

    case 'user': {
      const content = message.message.content
      if (typeof content === 'string') return
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        const node = toolNode(transcript, block.tool_use_id)
        if (!node) continue
        node.status = block.is_error ? 'error' : 'done'
        node.output = flattenToolResult(block.content)
        if (message.tool_use_result !== undefined) node.structured = message.tool_use_result
      }
      return
    }

    case 'tool_progress': {
      const node = toolNode(transcript, message.tool_use_id)
      if (node) node.elapsedSeconds = message.elapsed_time_seconds
      return
    }

    case 'result':
      transcript.streaming = null
      transcript.nodes.push({
        kind: 'result',
        id: message.uuid,
        isError: message.is_error,
        durationMs: message.duration_ms,
        numTurns: message.num_turns,
        totalCostUsd: message.total_cost_usd,
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
