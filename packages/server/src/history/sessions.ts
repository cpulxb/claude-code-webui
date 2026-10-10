import { access, open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getSessionMessages, listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode, ProjectGroup, SessionMessage, SessionSummary } from '@ccw/shared'
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
