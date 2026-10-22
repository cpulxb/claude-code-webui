import { access, open, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode, ProjectGroup, SessionMessage, SessionSummary, SubagentMeta, WorkflowRecord } from '@ccw/shared'
import { mergeProjectSessions } from '@ccw/shared'

/**
 * Reads the same on-disk transcripts the terminal's `/resume` picker reads
 * (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`), grouped by project.
 *
 * `includeProgrammatic` stays true even though IDE pickers pass false: every
 * session this WebUI starts goes through the SDK and is therefore programmatic,
 * so filtering them out would hide the app's own conversations from its own
 * sidebar.
 */
export async function listProjects(liveSessions: SessionSummary[] = []): Promise<ProjectGroup[]> {
  const sessions = await listSessions({ includeProgrammatic: true })
  // The SDK omits a new session until its transcript contains a user prompt.
  // Merge runner metadata so an empty or still-streaming session is visible.
  return mergeProjectSessions([], [...sessions.map(toSummary), ...liveSessions])
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
  return getSessionMessages(sessionId, {
    ...(cwd ? { dir: cwd } : {}),
    // Compact boundaries and notices are rendered in the transcript, so the
    // replay must include them to match the live stream.
    includeSystemMessages: true,
  })
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
function claudeConfigDir(): string {
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

function toSummary(info: SDKSessionInfo): SessionSummary {
  return {
    sessionId: info.sessionId,
    summary: info.customTitle ?? info.summary,
    lastModified: info.lastModified,
    ...(info.cwd ? { cwd: info.cwd } : {}),
    ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
    ...(info.customTitle ? { customTitle: info.customTitle } : {}),
    ...(info.firstPrompt ? { firstPrompt: info.firstPrompt } : {}),
  }
}
