import type { SessionMessage, TurnTotals } from '@ccw/shared'

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null }

/** The model the CLI names on messages it wrote itself — API errors, interruptions — rather than received. */
const SYNTHETIC_MODEL = '<synthetic>'

/**
 * Each finished turn's figures, as its `result` reported them live.
 *
 * The transcript keeps no `result` — an SDK session does not even write the
 * `turn_duration` entry the terminal does — but it keeps every model response
 * with its `usage`, and when each entry was written. Those add up to the
 * result's own figures: `num_turns` counts the responses and `usage` sums
 * theirs, main thread only both ways. The duration ends at the last response
 * rather than at the result, so it falls short by the Stop hooks' run.
 *
 * A turn runs from one prompt to the next. While `open`, the last one may
 * still be running and gets nothing yet. One whose prompt lies before the
 * read — that stops at the last compaction — gets nothing either: its figures
 * would cover only the part after it. Nor does one without a model response,
 * such as a slash command the CLI ran itself. Explicit synthetic API errors
 * still get a failed row, without being counted as model responses.
 */
export function turnTotals(messages: SessionMessage[], open: boolean): TurnTotals[] {
  const totals: TurnTotals[] = []
  let turn: { started: number; ended: number; after: string; responses: Map<string, Usage>; isError: boolean } | null = null
  const close = (): void => {
    if (!turn || (turn.responses.size === 0 && !turn.isError)) return
    const usage = [...turn.responses.values()]
    const sum = (pick: (usage: Usage) => number | null | undefined): number =>
      usage.reduce((total, entry) => total + (pick(entry) ?? 0), 0)
    totals.push({
      after: turn.after,
      durationMs: turn.ended - turn.started,
      numTurns: turn.responses.size,
      inputTokens: sum((entry) => entry.input_tokens),
      outputTokens: sum((entry) => entry.output_tokens),
      cacheReadTokens: sum((entry) => entry.cache_read_input_tokens),
      ...(turn.isError ? { isError: true } : {}),
    })
  }

  for (const entry of messages) {
    if (entry.parent_tool_use_id || entry.parent_agent_id) continue
    if (isPrompt(entry)) {
      close()
      turn = { started: writtenAt(entry), ended: writtenAt(entry), after: entry.uuid, responses: new Map(), isError: false }
      continue
    }
    if (!turn) continue
    turn.after = entry.uuid
    const message = entry.message as { id?: string; model?: string; usage?: Usage; content?: unknown } | null
    if (isApiError(entry, message)) {
      turn.isError = true
      turn.ended = writtenAt(entry)
      continue
    }
    if (entry.type !== 'assistant' || !message?.id || !message.usage || message.model === SYNTHETIC_MODEL) continue
    // A real response after a recoverable synthetic error is not a failed turn.
    turn.isError = false
    // One response is written as an entry per content block, each carrying its usage.
    turn.responses.set(message.id, message.usage)
    turn.ended = writtenAt(entry)
  }
  if (!open) close()
  return totals
}

/** Match only CLI-generated API errors, never ordinary prose mentioning one. */
function isApiError(entry: SessionMessage, message: { model?: string; content?: unknown } | null): boolean {
  if (entry.type !== 'assistant') return false
  const envelope = entry as SessionMessage & { isApiErrorMessage?: boolean; error?: string }
  if (envelope.isApiErrorMessage === true || (typeof envelope.error === 'string' && envelope.error.length > 0)) return true
  if (message?.model !== SYNTHETIC_MODEL || !Array.isArray(message.content)) return false
  return message.content.some((block: { type?: string; text?: unknown }) =>
    block.type === 'text' && typeof block.text === 'string' && /^API\s+Error:/i.test(block.text.trimStart()),
  )
}

/** Typed text or media. Tool results ride on user entries too, and a compaction's summary is one. */
function isPrompt(entry: SessionMessage): boolean {
  if (entry.type !== 'user' || (entry as { isCompactSummary?: boolean }).isCompactSummary) return false
  const content = (entry.message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return true
  return Array.isArray(content) && !content.some((block: { type?: unknown }) => block.type === 'tool_result')
}

/** `getSessionMessages` passes the jsonl timestamp through, though `SessionMessage` does not declare it. */
function writtenAt(entry: SessionMessage): number {
  return Date.parse((entry as { timestamp?: string }).timestamp ?? '')
}
