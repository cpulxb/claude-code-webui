import { createReadStream } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { getSessionMessages, listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode, ProjectGroup, SessionMessage, SessionSummary } from '@ccw/shared'

/**
 * Reads the same on-disk transcripts the terminal's `/resume` picker reads
 * (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`), grouped by project.
 *
 * `includeProgrammatic` stays true even though IDE pickers pass false: every
 * session this WebUI starts goes through the SDK and is therefore programmatic,
 * so filtering them out would hide the app's own conversations from its own
 * sidebar.
 */
export async function listProjects(liveIds: Set<string>): Promise<ProjectGroup[]> {
  const sessions = await listSessions({ includeProgrammatic: true })

  const byCwd = new Map<string, SessionSummary[]>()
  for (const info of sessions) {
    const cwd = info.cwd ?? UNKNOWN_CWD
    const group = byCwd.get(cwd) ?? []
    group.push(toSummary(info, liveIds.has(info.sessionId)))
    byCwd.set(cwd, group)
  }

  return [...byCwd.entries()]
    .map(([cwd, group]) => ({
      cwd,
      sessions: group.sort((a, b) => b.lastModified - a.lastModified),
    }))
    .sort((a, b) => (b.sessions[0]?.lastModified ?? 0) - (a.sessions[0]?.lastModified ?? 0))
}

export async function readMessages(sessionId: string, cwd?: string): Promise<SessionMessage[]> {
  return getSessionMessages(sessionId, {
    ...(cwd ? { dir: cwd } : {}),
    // Compact boundaries and notices are rendered in the transcript, so the
    // replay must include them to match the live stream.
    includeSystemMessages: true,
  })
}

const UNKNOWN_CWD = '(unknown)'

/**
 * The permission mode a session was left in.
 *
 * Toggling the mode (shift+tab in the terminal) appends a bare
 * `{"type":"permission-mode","permissionMode":…}` line to the transcript, but
 * `getSessionMessages` filters those out — so the file is read directly. The
 * last such line wins; a session that was never toggled has none, and the
 * caller keeps its own default rather than being forced to `default`.
 */
export async function readPermissionMode(sessionId: string): Promise<PermissionMode | null> {
  const path = await findTranscript(sessionId)
  if (!path) return null

  let mode: PermissionMode | null = null
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // Cheap prefilter: parsing every line of a multi-megabyte transcript to
      // find a handful of toggles is not worth it.
      if (!line.includes('"permission-mode"')) continue
      try {
        const entry = JSON.parse(line) as { type?: string; permissionMode?: PermissionMode }
        if (entry.type === 'permission-mode' && entry.permissionMode) mode = entry.permissionMode
      } catch {
        // A partially flushed trailing line — the CLI may be mid-write.
      }
    }
  } finally {
    lines.close()
  }
  return mode
}

/**
 * Locates a session's JSONL. The SDK exposes neither the path nor the rule that
 * encodes a cwd into a directory name, so every project directory is probed —
 * a session id is a UUID, so at most one can match.
 */
async function findTranscript(sessionId: string): Promise<string | null> {
  const root = join(homedir(), '.claude', 'projects')
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

function toSummary(info: SDKSessionInfo, live: boolean): SessionSummary {
  return {
    sessionId: info.sessionId,
    summary: info.customTitle ?? info.summary,
    lastModified: info.lastModified,
    ...(info.cwd ? { cwd: info.cwd } : {}),
    ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
    ...(info.customTitle ? { customTitle: info.customTitle } : {}),
    ...(info.firstPrompt ? { firstPrompt: info.firstPrompt } : {}),
    ...(live ? { live: true } : {}),
  }
}
