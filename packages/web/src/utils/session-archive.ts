import type { SessionSummary } from '@ccw/shared'

import type { Unread } from './session-activity.ts'

/** 设置 → 通用's choices, in days without a message; 0 never folds a session away. */
export const ARCHIVE_AFTER_DAYS = [0, 1, 2, 7, 14] as const

export const DEFAULT_ARCHIVE_AFTER_DAYS = 14

const DAY = 24 * 60 * 60 * 1000

export type ArchiveContext = {
  /** Days without a message before a session folds under 已归档; 0 for never. */
  days: number
  now: number
  activeId: string | null
  unread: Record<string, Unread>
}

/**
 * Whether the sidebar lists `session` under 已归档. A mark on disk — set here,
 * in the terminal or in VS Code — decides outright, and `false` is a session
 * taken back out, which stays out. Unmarked, a session folds away once nothing
 * was said in it for `days`, unless it is open, shown or has news unread. That
 * folding is the view's alone: nothing is written, so changing `days` undoes it.
 */
export function isArchived(session: SessionSummary, context: ArchiveContext): boolean {
  if (session.archived !== undefined) return session.archived
  if (context.days === 0 || session.live || session.sessionId === context.activeId || context.unread[session.sessionId]) {
    return false
  }
  return context.now - session.lastModified >= context.days * DAY
}
