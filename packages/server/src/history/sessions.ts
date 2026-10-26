import { access, open, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  type SDKSessionInfo,
  type SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode, ProjectGroup, SessionMessage, SessionSummary, SubagentMeta, WorkflowRecord } from '@ccw/shared'
import { mergeProjectSessions } from '@ccw/shared'

import { listSavedSessions } from './session-list.ts'

/**
 * Reads the same on-disk transcripts the terminal's `/resume` picker reads
 * (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`), grouped by project.
 *
 * The list matches `/resume` plus this app's own sessions. `/resume` drops
 * every programmatic session, and that includes everything the WebUI starts
 * (`sdk-ts`), so `includeProgrammatic` stays true and only the headless runs
 * — `claude -p` and the like — are filtered out here.
 */
export async function listProjects(liveSessions: SessionSummary[] = []): Promise<ProjectGroup[]> {
  const [sessions, headless] = await Promise.all([listSavedSessions(), headlessSessionIds()])
  const kept = sessions.filter((session) => !headless.has(session.sessionId))
  // The SDK omits a new session until its transcript contains a user prompt.
  // Merge runner metadata so an empty or still-streaming session is visible.
  return mergeProjectSessions([], [...kept.map(toSummary), ...liveSessions])
}

/**
 * Programmatic entrypoints the sidebar hides. The SDK's own list also has
 * `sdk-ts`, which is left out on purpose: it is how this app's sessions are
 * recorded.
 */
const HEADLESS_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-py'])

/** The entrypoint sits in the first record, about 2 KB in; 8 KB leaves room. */
const HEAD_BYTES = 8 * 1024

/** Transcripts read at once — the first scan touches every one of them. */
const HEAD_BATCH = 64

/**
 * Verdict per session id. A session's entrypoint is fixed when it starts, so
 * only transcripts that appeared since the last scan cost a read.
 */
const headlessVerdicts = new Map<string, boolean>()

/**
 * Sessions started by `claude -p`, the Python SDK or a daemon. The SDK's
 * summaries do not carry the entrypoint, so each transcript's head is read.
 */
async function headlessSessionIds(): Promise<Set<string>> {
  const root = join(claudeConfigDir(), 'projects')
  let dirs
  try {
    dirs = await readdir(root, { withFileTypes: true })
  } catch {
    return new Set()
  }

  const unread: { sessionId: string; path: string }[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    let names: string[]
    try {
      names = await readdir(join(root, dir.name))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      if (!headlessVerdicts.has(sessionId)) unread.push({ sessionId, path: join(root, dir.name, name) })
    }
  }

  for (let i = 0; i < unread.length; i += HEAD_BATCH) {
    await Promise.all(
      unread.slice(i, i + HEAD_BATCH).map(async ({ sessionId, path }) => {
        const verdict = await readHeadless(path)
        if (verdict !== null) headlessVerdicts.set(sessionId, verdict)
      }),
    )
  }
  return new Set([...headlessVerdicts].filter(([, headless]) => headless).map(([sessionId]) => sessionId))
}

/**
 * Same test as the SDK's programmatic filter, minus `sdk-ts`. Null while the
 * head names no entrypoint yet — a transcript still being started — so it is
 * read again next time instead of being cached as visible.
 */
async function readHeadless(path: string): Promise<boolean | null> {
  let head: string
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
      head = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  if (head.includes('"sessionKind":"daemon')) return true
  const entrypoint = /"entrypoint":"([^"]*)"/.exec(head)?.[1]
  return entrypoint === undefined ? null : HEADLESS_ENTRYPOINTS.has(entrypoint)
}

/**
 * `/rename`. A live CLI keeps writing to the same file, which is fine: the
 * title is its own appended entry and the last one wins.
 */
export async function renameSavedSession(sessionId: string, title: string, cwd?: string): Promise<void> {
  const name = title.trim()
  if (!name) throw new Error('title must not be empty')
  await renameSession(sessionId, name, cwd ? { dir: cwd } : undefined)
}

/** `/branch`: a copy of the transcript as it is on disk now, under a fresh id. */
export async function forkSavedSession(sessionId: string, cwd?: string, title?: string): Promise<string> {
  const dir = cwd ? { dir: cwd } : {}
  // Left untitled, the copy would list under the very same summary as its
  // source; the terminal names an unnamed branch "<title> (Branch)".
  let name = title?.trim()
  if (!name) {
    const source = await getSessionInfo(sessionId, dir)
    const base = source?.customTitle ?? source?.summary
    if (base) name = `${base} (Branch)`
  }
  const forked = await forkSession(sessionId, { ...dir, ...(name ? { title: name } : {}) })
  return forked.sessionId
}

export async function readMessages(sessionId: string, cwd?: string): Promise<SessionMessage[]> {
  const messages = await getSessionMessages(sessionId, {
    ...(cwd ? { dir: cwd } : {}),
    // Compact boundaries and notices are rendered in the transcript, so the
    // replay must include them to match the live stream.
    includeSystemMessages: true,
  })
  for (const entry of messages) dropInlineMedia(entry.message)
  return messages
}

/**
 * Empties base64 image and document payloads in place, keeping the blocks.
 * The renderer only counts them (`[image]`, "附件 × n"), and on a
 * screenshot-heavy session they were 20.8 of the transcript's 23 MB.
 */
function dropInlineMedia(message: unknown): void {
  const content = (message as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return
  for (const block of content as { type?: unknown; source?: { type?: unknown; data?: unknown } }[]) {
    if ((block.type === 'image' || block.type === 'document') && block.source?.type === 'base64') block.source.data = ''
    // A tool result nests its own content blocks: a screenshot, a read image.
    else if (block.type === 'tool_result') dropInlineMedia(block)
  }
}

/**
 * The transcript the last page was cut from. The SDK parses the whole file on
 * every call — seconds for a 50 MB one on a loaded box — and scrolling asks
 * for page after page of the same transcript. The file only grows at its end,
 * so every entry the cached copy holds is still what is on disk, and a page
 * next to one of them can be cut from it — unless it reaches the copy's end,
 * where the file grows. The newest page and a page around an entry are where
 * a session is opened, and re-read. Dropped when unused for a while, as one
 * long text-only transcript can be large.
 */
let lastRead: (TranscriptRead & { sessionId: string; cwd: string | undefined; expiry: NodeJS.Timeout }) | null = null
const LAST_READ_TTL_MS = 5 * 60_000

/** A session's messages, and whether they include what came before its last compaction. */
type TranscriptRead = { messages: SessionMessage[]; complete: boolean }

/** Where a page sits: next to an entry already shown, or around one to open at. Without one, the newest page. */
export type PageCursor = { before?: string | undefined; after?: string | undefined; around?: string | undefined }

export type MessagePage = { messages: SessionMessage[]; hasMore: boolean; hasNewer: boolean }

/** `pageMessages` over the session's transcript, read once per run of pages. */
export async function readMessagePage(
  sessionId: string,
  cwd: string | undefined,
  limit: number,
  cursor: PageCursor = {},
): Promise<MessagePage> {
  const shown = cursor.before ?? cursor.after
  const cached =
    shown !== undefined && lastRead?.sessionId === sessionId && lastRead.cwd === cwd && lastRead.messages.some((entry) => entry.uuid === shown)
      ? lastRead
      : null
  let read: TranscriptRead = cached ?? (await readTranscriptAt(sessionId, cwd, cursor))
  let page = pageMessages(read.messages, limit, cursor)
  if (cached && !page.hasNewer && cursor.after !== undefined) {
    read = await readTranscriptAt(sessionId, cwd, cursor)
    page = pageMessages(read.messages, limit, cursor)
  }
  // The SDK's read ends at the last compaction. Reading on past it costs a
  // parse of the whole file, so a page only says there is more until the
  // reader scrolls back there.
  if (!page.hasMore && !read.complete && read.messages.some(isCompactSummary)) {
    if (cursor.before === undefined) {
      page.hasMore = true
    } else {
      read = { messages: await withEarlierMessages(sessionId, read.messages), complete: true }
      page = pageMessages(read.messages, limit, cursor)
    }
  }
  if (lastRead) clearTimeout(lastRead.expiry)
  lastRead = { sessionId, cwd, ...read, expiry: setTimeout(() => (lastRead = null), LAST_READ_TTL_MS).unref() }
  return page
}

/** The SDK's read, or the whole transcript when the cursor lies before the last compaction. */
async function readTranscriptAt(sessionId: string, cwd: string | undefined, cursor: PageCursor): Promise<TranscriptRead> {
  const messages = await readMessages(sessionId, cwd)
  const at = cursor.before ?? cursor.after ?? cursor.around
  if (at === undefined || messages.some((entry) => holds(entry, at)) || !messages.some(isCompactSummary)) {
    return { messages, complete: false }
  }
  return { messages: await withEarlierMessages(sessionId, messages), complete: true }
}

/**
 * `current` with the conversation before its compactions put back in front.
 *
 * `getSessionMessages` follows parent links back from the newest entry, and a
 * compaction's boundary has none, so the walk ends there. What came before is
 * still in the file. Handed only the entries written before a boundary, the
 * SDK reads the transcript as it stood when that compaction began — by the
 * same walk, so a branch rewound away stays out — and that read ends at the
 * compaction before, in turn.
 *
 * Messages a compaction kept are relinked after its summary as well. They stay
 * there, where the newest page — read without the rest — already showed them.
 */
async function withEarlierMessages(sessionId: string, current: SessionMessage[]): Promise<SessionMessage[]> {
  const path = await findTranscript(sessionId)
  if (!path) return current
  const entries: SessionStoreEntry[] = []
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as SessionStoreEntry)
    } catch {
      continue // a trailing line the CLI is still writing
    }
  }
  const boundaries = new Map<string, number>()
  entries.forEach((entry, index) => {
    if (entry.type === 'system' && entry['subtype'] === 'compact_boundary' && entry.uuid) boundaries.set(entry.uuid, index)
  })
  // A read holds one boundary: the one it starts from.
  const startOf = (messages: SessionMessage[]) => messages.map((entry) => boundaries.get(entry.uuid)).find((index) => index !== undefined)

  // Read newest first, so a kept message is placed by the newest read holding it.
  const placed = new Set(current.map((entry) => entry.uuid))
  const stretches: SessionMessage[][] = []
  let boundary = startOf(current)
  while (boundary !== undefined) {
    const before = entries.slice(0, boundary)
    const stretch = await getSessionMessages(sessionId, {
      includeSystemMessages: true,
      sessionStore: { append: async () => {}, load: async () => before },
    })
    stretches.push(stretch.filter((entry) => !placed.has(entry.uuid)))
    for (const entry of stretch) placed.add(entry.uuid)
    const next = startOf(stretch)
    boundary = next !== undefined && next < boundary ? next : undefined
  }
  const earlier = stretches.reverse().flat()
  for (const entry of earlier) dropInlineMedia(entry.message)
  return [...earlier, ...current]
}

/** `getSessionMessages` passes the flag through, though `SessionMessage` does not declare it. */
function isCompactSummary(entry: SessionMessage): boolean {
  return (entry as { isCompactSummary?: boolean }).isCompactSummary === true
}

/**
 * One page of a transcript, up to `limit` entries: just before the entry whose
 * uuid is `before`, just after the one that is `after`, around the one `around`
 * names, or the newest. `around` matches an entry's uuid or a tool call in it
 * (a subagent's), and gets the newest page when the transcript holds no such
 * entry — the caller sees its target is missing.
 *
 * Each edge moves outward past `limit` until no tool call straddles it and it
 * does not split one assistant message's blocks, so a page replays on its own
 * exactly as it would inside the whole transcript. A 52 MB transcript answered
 * in one piece came to 22 MB of JSON, which a tunnel dropped mid-body.
 */
export function pageMessages(messages: SessionMessage[], limit: number, cursor: PageCursor = {}): MessagePage {
  const cuts = cutPoints(messages)
  const target = cursor.around === undefined ? -1 : messages.findIndex((entry) => holds(entry, cursor.around!))
  let start: number
  let end: number
  if (cursor.after !== undefined) {
    start = positionOf(messages, cursor.after) + 1
    end = Math.min(messages.length, start + limit)
  } else if (target >= 0) {
    // Most of the page follows the target: what came of it is read next.
    start = Math.max(0, target - Math.floor(limit / 4))
    end = Math.min(messages.length, start + limit)
  } else {
    end = cursor.before === undefined ? messages.length : positionOf(messages, cursor.before)
    start = Math.max(0, end - limit)
  }
  while (!cuts(start)) start--
  while (!cuts(end)) end++
  return { messages: messages.slice(start, end), hasMore: start > 0, hasNewer: end < messages.length }
}

function positionOf(messages: SessionMessage[], uuid: string): number {
  const index = messages.findIndex((entry) => entry.uuid === uuid)
  if (index < 0) throw new Error(`history cursor ${uuid} is not in the transcript`)
  return index
}

function holds(entry: SessionMessage, id: string): boolean {
  if (entry.uuid === id) return true
  const content = (entry.message as { content?: unknown } | null)?.content
  return Array.isArray(content) && content.some((block: { type?: unknown; id?: unknown }) => block.type === 'tool_use' && block.id === id)
}

/** Whether a page may begin at an index — the one before it is where the previous page ends. */
function cutPoints(messages: SessionMessage[]): (index: number) => boolean {
  // `straddled[i] > 0`: some tool call sits before entry i and its result at
  // or after it. Built as a difference array over each call → result span.
  const straddled = new Array<number>(messages.length + 1).fill(0)
  const calledAt = new Map<string, number>()
  messages.forEach((entry, index) => {
    const content = (entry.message as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) return
    for (const block of content as { type?: unknown; id?: unknown; tool_use_id?: unknown }[]) {
      if (block.type === 'tool_use' && typeof block.id === 'string') calledAt.set(block.id, index)
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const call = calledAt.get(block.tool_use_id)
      if (call === undefined) continue
      straddled[call + 1]! += 1
      straddled[index + 1]! -= 1
    }
  })
  for (let i = 1; i <= messages.length; i++) straddled[i]! += straddled[i - 1]!
  return (index) =>
    index <= 0 ||
    index >= messages.length ||
    (straddled[index] === 0 && !continuesMessage(messages[index - 1]!, messages[index]!))
}

/** Both entries are blocks of one assistant message, which renders as one node. */
function continuesMessage(previous: SessionMessage, entry: SessionMessage): boolean {
  if (previous.type !== 'assistant' || entry.type !== 'assistant') return false
  const id = (entry.message as { id?: unknown } | null)?.id
  return id !== undefined && id === (previous.message as { id?: unknown } | null)?.id
}

/**
 * The permission mode a session was left in.
 *
 * Toggling the mode (shift+tab in the terminal) appends a bare
 * `{"type":"permission-mode","permissionMode":…}` line to the transcript, but
 * `getSessionMessages` filters those out — so the file is read directly. The
 * last such line wins; a session that was never toggled has none, and the
 * caller keeps its own default rather than being forced to `default`.
 *
 * Read backwards from the end so the common case — the mode was toggled during
 * the recent part of the conversation — costs one chunk instead of streaming
 * the whole file. When the last toggle sits near the front of the file, or
 * there is none at all, the file is read to its front: the same order of work
 * as a forward scan, plus one copy per chunk.
 */
export async function readPermissionMode(sessionId: string): Promise<PermissionMode | null> {
  const path = await findTranscript(sessionId)
  if (!path) return null

  const handle = await open(path, 'r')
  try {
    let end = (await handle.stat()).size
    // Bytes of the chunk's leading, still incomplete line.
    let carry = Buffer.alloc(0)
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK)
      const chunk = Buffer.alloc(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      const merged = Buffer.concat([chunk, carry])
      // Splitting on a line boundary keeps multi-byte characters intact.
      const boundary = start > 0 ? merged.indexOf(0x0a) : -1
      if (start > 0 && boundary < 0) {
        carry = merged
        end = start
        continue
      }
      carry = merged.subarray(0, boundary + 1)
      const lines = merged.subarray(boundary + 1).toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const mode = parsePermissionMode(lines[i]!)
        if (mode) return mode
      }
      end = start
    }
    return null
  } finally {
    await handle.close()
  }
}

/** Chunk size of the backwards read; larger transcripts take several chunks. */
const TAIL_CHUNK = 64 * 1024

function parsePermissionMode(line: string): PermissionMode | null {
  // Cheap prefilter: parsing every line of a multi-megabyte transcript to find
  // a handful of toggles is not worth it.
  if (!line.includes('"permission-mode"')) return null
  try {
    const entry = JSON.parse(line) as { type?: string; permissionMode?: PermissionMode }
    return entry.type === 'permission-mode' && entry.permissionMode ? entry.permissionMode : null
  } catch {
    // A partially flushed trailing line — the CLI may be mid-write.
    return null
  }
}

/** Whether the CLI has written this session's JSONL — it does so only with the first message. */
export async function hasTranscript(sessionId: string): Promise<boolean> {
  return (await findTranscript(sessionId)) !== null
}

/** The directory a saved session ran in, for opening it by id alone. Null for an unknown or malformed id. */
export async function locateSession(sessionId: string): Promise<string | null> {
  return (await getSessionInfo(sessionId))?.cwd ?? null
}

/**
 * Locates a session's JSONL. The SDK exposes neither the path nor the rule that
 * encodes a cwd into a directory name, so every project directory is probed —
 * a session id is a UUID, so at most one can match.
 */
async function findTranscript(sessionId: string): Promise<string | null> {
  const root = join(claudeConfigDir(), 'projects')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, `${sessionId}.jsonl`)
    try {
      await access(path)
      return path
    } catch {
      // Not in this project.
    }
  }
  return null
}

/** Where the CLI keeps its state — `CLAUDE_CONFIG_DIR` overrides `~/.claude`, as in the CLI. */
export function claudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
}

/** `<project>/<sessionId>/subagents`, next to the session's own JSONL. */
async function subagentDir(sessionId: string): Promise<string | null> {
  const transcript = await findTranscript(sessionId)
  return transcript ? join(transcript.slice(0, -'.jsonl'.length), 'subagents') : null
}

const AGENT_ID = /^[\w-]+$/

/**
 * The subagents a session spawned. Each has an `agent-<id>.meta.json` beside
 * its transcript naming the Agent tool_use that started it — the link the
 * main transcript needs to open the right conversation from a card, since the
 * on-disk tool_result does not keep the structured result that carries it.
 */
export async function listSubagentMeta(sessionId: string): Promise<SubagentMeta[]> {
  const dir = await subagentDir(sessionId)
  if (!dir) return []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const agents: SubagentMeta[] = []
  for (const name of names) {
    const match = /^agent-([\w-]+)\.jsonl$/.exec(name)
    if (!match) continue
    const agentId = match[1]!
    const meta: SubagentMeta = { agentId }
    try {
      const raw = JSON.parse(await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf8')) as {
        toolUseId?: string
        description?: string
        agentType?: string
      }
      if (raw.toolUseId) meta.toolUseId = raw.toolUseId
      if (raw.description) meta.description = raw.description
      if (raw.agentType) meta.agentType = raw.agentType
    } catch {
      // Older CLIs write no meta file; the id alone still opens the transcript.
    }
    agents.push(meta)
  }
  return agents
}

/**
 * One subagent's conversation. Read directly rather than through the SDK's
 * `getSubagentMessages`: on CLI 2.1.293 transcripts that helper rebuilds the
 * chain from the last leaf and drops the prompt and every tool result, which
 * is most of what a reader opens the subagent to see. A subagent transcript is
 * a straight line with no forks, so file order is conversation order.
 */
export async function readSubagentMessages(sessionId: string, agentId: string): Promise<SessionMessage[]> {
  if (!AGENT_ID.test(agentId)) throw new Error('invalid agent id')
  const dir = await subagentDir(sessionId)
  if (!dir) return []
  const raw = await readAgentTranscript(dir, agentId)
  if (raw === null) return []
  const messages: SessionMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: { type?: string; uuid?: string; message?: unknown; isMeta?: boolean; sessionId?: string }
    try {
      entry = JSON.parse(line)
    } catch {
      continue // a trailing line the CLI is still writing
    }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta || !entry.uuid || !entry.message) continue
    dropInlineMedia(entry.message)
    messages.push({
      type: entry.type,
      uuid: entry.uuid,
      session_id: entry.sessionId ?? sessionId,
      message: entry.message,
      parent_tool_use_id: null,
    } as SessionMessage)
  }
  return messages
}

/**
 * A subagent's JSONL sits directly in `subagents/`; a workflow agent's sits
 * in `subagents/workflows/<runId>/`. The id is unique across both.
 */
async function readAgentTranscript(dir: string, agentId: string): Promise<string | null> {
  const name = `agent-${agentId}.jsonl`
  try {
    return await readFile(join(dir, name), 'utf8')
  } catch {
    // fall through to workflow runs
  }
  let runs: string[]
  try {
    runs = await readdir(join(dir, 'workflows'))
  } catch {
    return null
  }
  for (const run of runs) {
    try {
      return await readFile(join(dir, 'workflows', run, name), 'utf8')
    } catch {
      continue
    }
  }
  return null
}

const RUN_ID = /^wf_[\w-]+$/

/**
 * One dynamic workflow run. A finished run is saved whole as
 * `<session>/workflows/<runId>.json`, including the last progress snapshot.
 * A run still going (or cut off by a crash) has only its journal and each
 * agent's meta file, which are enough for labels, phases and done-or-not.
 */
export async function readWorkflowRun(sessionId: string, runId: string): Promise<WorkflowRecord | null> {
  if (!RUN_ID.test(runId)) throw new Error('invalid run id')
  const transcript = await findTranscript(sessionId)
  if (!transcript) return null
  const sessionDir = transcript.slice(0, -'.jsonl'.length)
  try {
    const saved = JSON.parse(await readFile(join(sessionDir, 'workflows', `${runId}.json`), 'utf8')) as Record<string, unknown>
    return pickWorkflowRecord(runId, saved)
  } catch {
    // not finished yet — rebuild from the journal
  }
  const runDir = join(sessionDir, 'subagents', 'workflows', runId)
  let journal: string
  try {
    journal = await readFile(join(runDir, 'journal.jsonl'), 'utf8')
  } catch {
    return null
  }
  type Entry = { label: string; phase?: string; agentId: string; done: boolean; result?: unknown }
  const byAgent = new Map<string, Entry>()
  const phases: string[] = []
  for (const line of journal.split('\n')) {
    let event: { type?: string; agentId?: string; label?: string; phase?: string; result?: unknown }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event.agentId) continue
    if (event.type === 'started') {
      if (event.phase && !phases.includes(event.phase)) phases.push(event.phase)
      byAgent.set(event.agentId, {
        label: event.label ?? event.agentId,
        ...(event.phase ? { phase: event.phase } : {}),
        agentId: event.agentId,
        done: false,
      })
    } else if (event.type === 'result') {
      const entry = byAgent.get(event.agentId)
      if (entry) {
        entry.done = true
        entry.result = event.result
      }
    }
  }
  const progress: unknown[] = phases.map((title, at) => ({ type: 'workflow_phase', index: at + 1, title }))
  let index = 0
  for (const entry of byAgent.values()) {
    index += 1
    const phaseIndex = entry.phase ? phases.indexOf(entry.phase) + 1 : undefined
    progress.push({
      type: 'workflow_agent',
      index,
      label: entry.label,
      agentId: entry.agentId,
      ...(entry.phase ? { phaseTitle: entry.phase, phaseIndex } : {}),
      state: entry.done ? 'done' : 'progress',
      ...(entry.done ? { resultPreview: preview(entry.result) } : {}),
    })
  }
  return { runId, workflowProgress: progress }
}

function pickWorkflowRecord(runId: string, saved: Record<string, unknown>): WorkflowRecord {
  const record: WorkflowRecord = { runId }
  const text = (key: string): string | undefined => (typeof saved[key] === 'string' ? (saved[key] as string) : undefined)
  const count = (key: string): number | undefined => (typeof saved[key] === 'number' ? (saved[key] as number) : undefined)
  const taskId = text('taskId')
  if (taskId) record.taskId = taskId
  const workflowName = text('workflowName')
  if (workflowName) record.workflowName = workflowName
  const summary = text('summary')
  if (summary) record.summary = summary
  const status = text('status')
  if (status) record.status = status
  const script = text('script')
  if (script) record.script = script
  const scriptPath = text('scriptPath')
  if (scriptPath) record.scriptPath = scriptPath
  if (Array.isArray(saved['phases'])) record.phases = saved['phases'] as { title: string; detail?: string }[]
  if (Array.isArray(saved['workflowProgress'])) record.workflowProgress = saved['workflowProgress'] as unknown[]
  const totalTokens = count('totalTokens')
  if (totalTokens !== undefined) record.totalTokens = totalTokens
  const totalToolCalls = count('totalToolCalls')
  if (totalToolCalls !== undefined) record.totalToolCalls = totalToolCalls
  const durationMs = count('durationMs')
  if (durationMs !== undefined) record.durationMs = durationMs
  return record
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

/**
 * The SDK's `customTitle` is a `/rename` title or else the AI-generated one.
 * Untitled, a session is named by its first prompt, as claude.ai names a chat:
 * the SDK's own `summary` falls back to the latest prompt, which turns into
 * "继续吧" a turn later. A `firstPrompt` that is a bare command name is the
 * SDK's stand-in for a transcript with no prose in its head, so it gives way.
 */
function toSummary(info: SDKSessionInfo): SessionSummary {
  const prompt = info.firstPrompt && !/^\/[\w:-]+$/.test(info.firstPrompt) ? info.firstPrompt : undefined
  return {
    sessionId: info.sessionId,
    summary: info.customTitle ?? prompt ?? info.summary,
    lastModified: info.lastModified,
    ...(info.cwd ? { cwd: info.cwd } : {}),
    ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
    ...(info.customTitle ? { customTitle: info.customTitle } : {}),
    ...(info.firstPrompt ? { firstPrompt: info.firstPrompt } : {}),
  }
}
