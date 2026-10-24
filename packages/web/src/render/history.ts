import type { SDKMessage, SessionMessage } from '@ccw/shared'

import { bashEcho, parseBashInput, parseBashOutput } from './bash.ts'
import { applyMessage, findAgent, findAgentById, type Transcript } from './nodes.ts'
import { applyWorkflowEvent, parseTaskNotification, unframeWorkflowPrompt, type TaskNotice } from './workflows.ts'

/**
 * Folds one on-disk transcript message into the transcript.
 *
 * Resuming a session does NOT replay it: the CLI hands the JSONL to the model
 * and emits nothing, exactly as the terminal does — the TUI paints history by
 * reading the same file. So the browser has to read it too.
 *
 * The live path cannot be reused as-is for two reasons:
 *
 *  - `applyMessage`'s `user` branch only picks out `tool_result` blocks, because
 *    live user messages are echoed locally the moment they are sent. Replaying
 *    through it would drop every prompt the user actually typed.
 *  - `system` messages survive on disk as a bare envelope: `message` is null and
 *    there is no `subtype` to dispatch on, even with `includeSystemMessages`.
 *    Nothing can be rendered from them, so they are skipped.
 */
export function applyHistoryMessage(transcript: Transcript, entry: SessionMessage): void {
  if (entry.type === 'system') return

  if (entry.type === 'assistant') {
    // Shapes match field for field here; only `message` is untyped on disk.
    applyMessage(transcript, entry as unknown as SDKMessage)
    return
  }

  const content = (entry.message as { content?: unknown } | null)?.content
  if (typeof content === 'string') {
    applyUserText(transcript, entry.uuid, content, 0)
    return
  }
  if (!Array.isArray(content)) return

  const blocks = content as { type: string; text?: string }[]

  // Tool results ride in on user messages; the live renderer already knows how
  // to attach them to their card. Runs before the text render so the delegated
  // applyMessage sees this entry's uuid unrecorded — it only mutates existing
  // tool cards, so the visual order is unchanged.
  if (blocks.some((block) => block.type === 'tool_result')) {
    applyMessage(transcript, entry as unknown as SDKMessage)
  }

  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  const images = blocks.filter((block) => block.type === 'image' || block.type === 'document').length
  if (text || images) applyUserText(transcript, entry.uuid, text, images)
}

/** `<local-command-stdout>…</local-command-stdout>` — a slash command's output. */
const LOCAL_OUTPUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/
/** The envelope the CLI writes for a slash command the user ran. */
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/

function applyUserText(transcript: Transcript, uuid: string, raw: string, attachments: number): void {
  transcript.seen[uuid] = true
  const trimmed = raw.trim()

  const notification = parseTaskNotification(trimmed)
  if (notification) {
    if (!applyNotification(transcript, notification)) transcript.pendingNotices.push(notification)
    return
  }

  const output = LOCAL_OUTPUT.exec(trimmed)
  if (output) {
    transcript.nodes.push({ kind: 'localOutput', id: uuid, content: output[1] ?? '' })
    return
  }

  // `!` mode: the command and its output may share one entry (WebUI) or come
  // as two (terminal); see render/bash.ts.
  const command = parseBashInput(trimmed)
  const bashOutput = parseBashOutput(trimmed)
  if (command !== null) {
    transcript.nodes.push({ kind: 'user', id: uuid, text: bashEcho(command), attachments: 0 })
  }
  if (bashOutput !== null) {
    transcript.nodes.push({ kind: 'localOutput', id: command !== null ? `${uuid}:out` : uuid, content: bashOutput })
  }
  if (command !== null || bashOutput !== null) return

  // A slash command is stored as its XML envelope, which is noise on screen —
  // the terminal shows the command line itself, so show that.
  const name = COMMAND_NAME.exec(trimmed)
  if (name) {
    const args = COMMAND_ARGS.exec(trimmed)?.[1]?.trim()
    transcript.nodes.push({
      kind: 'user',
      id: uuid,
      text: `${name[1]}${args ? ` ${args}` : ''}`,
      attachments: 0,
    })
    return
  }

  // A workflow agent's task arrives wrapped in the harness's provenance frame.
  transcript.nodes.push({ kind: 'user', id: uuid, text: unframeWorkflowPrompt(raw), attachments })
}

/**
 * The uuids of entries that render as user bubbles, in transcript order.
 *
 * The rewind flow aligns these against the on-screen user nodes to recover a
 * real uuid for a locally-echoed message, so this must agree with
 * `applyHistoryMessage` on exactly which entries become user nodes.
 */
export function listUserPromptUuids(messages: SessionMessage[]): string[] {
  const uuids: string[] = []
  for (const entry of messages) {
    if (entry.type !== 'user') continue
    const content = (entry.message as { content?: unknown } | null)?.content

    let text = ''
    let media = 0
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      const blocks = content as { type: string; text?: string }[]
      text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
      media = blocks.filter((block) => block.type === 'image' || block.type === 'document').length
      if (!text && media === 0) continue
    } else {
      continue
    }

    if (LOCAL_OUTPUT.test(text.trim())) continue
    if (parseTaskNotification(text)) continue
    // A terminal-written output entry renders as an output row, not a bubble.
    if (parseBashInput(text.trim()) === null && parseBashOutput(text.trim()) !== null) continue
    uuids.push(entry.uuid)
  }
  return uuids
}

/**
 * A background task settled; history has no task_* events, only this message.
 * False when no card in this transcript is the task's — not necessarily an
 * error, since shell tasks have no card at all.
 */
function applyNotification(transcript: Transcript, notification: TaskNotice): boolean {
  const { taskId, toolUseId, status, summary } = notification
  if (!taskId) return true
  const event = {
    subtype: 'task_notification',
    task_id: taskId,
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
  }
  if (applyWorkflowEvent(transcript, event)) return true
  const agent = (toolUseId && findAgent(transcript, toolUseId)) || findAgentById(transcript, taskId)
  if (!agent) return false
  if (status === 'completed' || status === 'failed') agent.status = status
  else if (status === 'killed' || status === 'stopped') agent.status = 'stopped'
  return true
}

/**
 * Puts an older page of history in front of the transcript already shown.
 *
 * The server cuts pages where no tool call straddles them, so the only links
 * back into `older` are task notifications parked on the newer pages — the
 * task's launch was not on screen yet — and live output of a background
 * subagent launched there, which got a placeholder card.
 */
export function prependTranscript(transcript: Transcript, older: Transcript): void {
  const shift = older.nodes.length
  for (const id of Object.keys(transcript.toolIndex)) transcript.toolIndex[id]! += shift
  Object.assign(transcript.toolIndex, older.toolIndex)
  transcript.nodes = [...older.nodes, ...transcript.nodes]

  for (const id of older.agentOrder) {
    const agent = older.agents[id]!
    const placeholder = transcript.agents[id]
    if (!placeholder) {
      transcript.agents[id] = agent
      continue
    }
    // The placeholder holds the live run; the launch holds what it was asked.
    if (agent.description) placeholder.description = agent.description
    placeholder.prompt ||= agent.prompt
    placeholder.subagentType ??= agent.subagentType
  }
  transcript.agentOrder = [...older.agentOrder, ...transcript.agentOrder.filter((id) => !older.agents[id])]
  transcript.workflows = { ...older.workflows, ...transcript.workflows }
  Object.assign(transcript.seen, older.seen)

  const parked = transcript.pendingNotices.filter((notice) => !applyNotification(transcript, notice))
  transcript.pendingNotices = [...older.pendingNotices, ...parked]
}

/** Puts a newer page of history after the transcript shown: the same merge, with the page as the newer side. */
export function appendTranscript(transcript: Transcript, newer: Transcript): void {
  prependTranscript(newer, transcript)
  Object.assign(transcript, newer)
}
