import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/** Actual main-thread activity, independent of whether the turn is still in flight. */
export type TurnProgress = {
  startedAt: number
  phase: 'running' | 'requesting' | 'thinking' | 'responding' | 'tool' | 'compacting' | 'retrying'
  toolName?: string
  retry?: {
    uuid: string
    attempt: number
    maxRetries: number
    /** Server-clock deadline; null when the producer supplied no usable delay. */
    retryAt: number | null
    errorStatus: number | null
    error: string
    noResponse?: { waitedMs: number; retryWaitMs: number }
  }
}

export function startTurnProgress(now: number): TurnProgress {
  return { startedAt: now, phase: 'running' }
}

/**
 * Consume the structured SDK stream, never stderr or elapsed-time heuristics.
 * Unchanged phases retain object identity so callers need not broadcast tokens.
 * A retry deadline expiring is not proof of a successful retry: only real main
 * thread output clears it. Older CLIs may emit none of these system events.
 */
export function applyTurnProgress(current: TurnProgress | null, message: SDKMessage, now: number): TurnProgress | null {
  const source = message as { parent_tool_use_id?: string | null; agent_id?: string }
  // A tool_progress parent can name the main thread's own tool, unlike
  // assistant/stream parents which always identify a subagent.
  if (source.agent_id || (message.type !== 'tool_progress' && source.parent_tool_use_id)) return current

  if (message.type === 'result') return null
  if (message.type === 'conversation_reset') return current ? startTurnProgress(current.startedAt) : null

  if (message.type === 'system') {
    switch (message.subtype) {
      case 'session_state_changed':
        if (message.state === 'idle') return null
        return current ?? startTurnProgress(now)
      case 'init':
        // Metadata also arrives at startup, before any prompt opens a turn.
        return current
      case 'api_retry': {
        if (current?.retry?.uuid === message.uuid) return current
        const delay = nonnegative(message.retry_delay_ms)
        const retryAt = delay !== null && Number.isFinite(now + delay) ? now + delay : null
        const waitedMs = nonnegative(message.no_response?.waited_ms)
        const retryWaitMs = nonnegative(message.no_response?.retry_wait_ms)
        return {
          startedAt: current?.startedAt ?? now,
          phase: 'retrying',
          retry: {
            uuid: message.uuid,
            attempt: message.attempt,
            maxRetries: message.max_retries,
            retryAt,
            errorStatus: typeof message.error_status === 'number' && Number.isFinite(message.error_status) ? message.error_status : null,
            error: typeof message.error === 'string' ? message.error : 'unknown',
            ...(waitedMs !== null && retryWaitMs !== null ? { noResponse: { waitedMs, retryWaitMs } } : {}),
          },
        }
      }
      case 'status':
        if (message.status === 'requesting' || message.status === 'compacting') return phase(current, message.status, now)
        return current
      case 'thinking_tokens':
        return message.estimated_tokens_delta > 0 ? phase(current, 'thinking', now, undefined, true) : current
      default:
        return current
    }
  }

  if (message.type === 'assistant') {
    // Synthetic API errors and aborted partial blocks are not resumed progress.
    if (message.error || message.aborted || message.message.model === '<synthetic>') return current
    // Apply the last real activity once: replaying a complete mixed-block
    // message must retain identity when its final phase is unchanged.
    for (let i = message.message.content.length - 1; i >= 0; i -= 1) {
      const block = message.message.content[i]!
      if (block.type === 'text' && block.text) return phase(current, 'responding', now, undefined, true)
      if (block.type === 'thinking' && block.thinking) return phase(current, 'thinking', now, undefined, true)
      if (block.type === 'tool_use') return phase(current, 'tool', now, block.name, true)
    }
    return current
  }

  if (message.type === 'stream_event') {
    const event = message.event
    if (event.type === 'message_start') return phase(current, 'requesting', now)
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block.type === 'tool_use') return phase(current, 'tool', now, block.name, true)
      if (block.type === 'text') return phase(current, 'responding', now, undefined, block.text.length > 0)
      if (block.type === 'thinking') return phase(current, 'thinking', now, undefined, block.thinking.length > 0)
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta.type === 'text_delta' && delta.text) return phase(current, 'responding', now, undefined, true)
      if (delta.type === 'thinking_delta') {
        const estimated = (delta as { estimated_tokens?: number }).estimated_tokens
        if (delta.thinking || (estimated !== undefined && estimated > 0)) return phase(current, 'thinking', now, undefined, true)
      }
    }
  }
  if (message.type === 'tool_progress') {
    // An Agent heartbeat/retry describes another thread even when its parent
    // is null. Only actual main-thread tool activity counts as recovery.
    if (message.heartbeat || message.subagent_retry || message.subagent_type) return current
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== message.tool_use_id) return current
    return phase(current, 'tool', now, message.tool_name, true)
  }
  // Task progress and user/permission messages cannot prove that the main
  // thread's failed API request has recovered.
  return current
}

function phase(
  current: TurnProgress | null,
  next: TurnProgress['phase'],
  now: number,
  toolName?: string,
  actualOutput = false,
): TurnProgress {
  if (current?.retry && !actualOutput) return current
  if (current?.phase === next && current.toolName === toolName && !current.retry) return current
  return { startedAt: current?.startedAt ?? now, phase: next, ...(toolName !== undefined ? { toolName } : {}) }
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
