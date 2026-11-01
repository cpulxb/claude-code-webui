import type { SessionSummary } from '@ccw/shared'

/** How a turn ended out of sight, kept until the session is opened. */
export type Unread = 'done' | 'error'

/** What a sidebar row says about its session, most urgent first. */
export type Activity = 'waiting' | 'running' | 'error' | 'done' | 'idle'

const RANK: Record<Activity, number> = { waiting: 0, running: 1, error: 2, done: 3, idle: 4 }

export const ACTIVITY_LABEL: Record<Activity, string> = {
  waiting: '等你确认',
  running: '运行中',
  error: '出错了，还没查看',
  done: '已完成，还没查看',
  idle: '进程空闲',
}

/**
 * A prompt held for the user outranks a turn still working, which outranks
 * news of one finished; a live process with none of these is just idle.
 * Null for a session with no process and nothing unread.
 */
export function activityOf(session: SessionSummary, unread: Unread | undefined): Activity | null {
  if (session.live && session.waiting) return 'waiting'
  if (session.live && session.running) return 'running'
  if (unread) return unread
  return session.live ? 'idle' : null
}

/** The most urgent activity among `sessions`, for a project as a whole. */
export function mostUrgent(sessions: SessionSummary[], unread: Record<string, Unread>): Activity | null {
  let best: Activity | null = null
  for (const session of sessions) {
    const activity = activityOf(session, unread[session.sessionId])
    if (activity && (best === null || RANK[activity] < RANK[best])) best = activity
  }
  return best
}
