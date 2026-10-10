import type { ProjectGroup, SessionSummary } from './index.ts'

/** Merge live activity with saved history, keeping one row per session. */
export function mergeProjectSessions(projects: ProjectGroup[], updates: SessionSummary[]): ProjectGroup[] {
  const sessions = new Map(projects.flatMap((project) =>
    project.sessions.map((session) => [session.sessionId, { ...session, cwd: project.cwd }] as const),
  ))
  for (const update of updates) {
    const saved = sessions.get(update.sessionId)
    sessions.set(update.sessionId, {
      ...saved,
      ...update,
      cwd: update.cwd ?? saved?.cwd ?? '(unknown)',
      // Live entries start with an empty title, then the first prompt. Saved
      // custom titles and summaries remain authoritative after persistence.
      summary: update.customTitle ?? saved?.customTitle ?? (saved?.summary || update.summary),
      firstPrompt: saved?.firstPrompt ?? update.firstPrompt,
      lastModified: Math.max(saved?.lastModified ?? 0, update.lastModified),
    })
  }

  const groups = new Map<string, SessionSummary[]>()
  for (const session of sessions.values()) {
    const group = groups.get(session.cwd) ?? []
    group.push(session)
    groups.set(session.cwd, group)
  }
  return [...groups].map(([cwd, group]) => ({
    cwd,
    sessions: group.sort((a, b) => b.lastModified - a.lastModified),
  })).sort((a, b) => (b.sessions[0]?.lastModified ?? 0) - (a.sessions[0]?.lastModified ?? 0))
}
