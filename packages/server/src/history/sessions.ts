import { getSessionMessages, listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectGroup, SessionMessage, SessionSummary } from '@ccw/shared'

/**
 * Reads the same on-disk transcripts the terminal's `/resume` picker reads
 * (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`), grouped by project.
 *
 * `includeProgrammatic: false` matches what IDE session pickers pass — it hides
 * headless/daemon sessions that were never a human conversation.
 */
export async function listProjects(liveIds: Set<string>): Promise<ProjectGroup[]> {
  const sessions = await listSessions({ includeProgrammatic: false })

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
