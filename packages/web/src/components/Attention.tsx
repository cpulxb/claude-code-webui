import type { ProjectGroup } from '@ccw/shared'
import { useEffect } from 'react'

import { useStore } from '../store/session.ts'
import { sessionTitle } from '../utils/session-title.ts'

const BASE_TITLE = 'Claude Code'

const NEWS = { done: '已完成', error: '出错了', waiting: '等你确认' } as const

/**
 * What reaches the reader outside the page. The tab title counts the sessions
 * that want them — a turn finished out of sight, or one held on a prompt —
 * and, once turned on in settings, a desktop notification names each as it
 * happens while the page is not in front. Renders nothing.
 */
export function Attention(): null {
  const count = useStore((state) => Object.keys(state.unread).length + waitingIds(state.projects).length)

  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE
  }, [count])

  // Back in front, the open session's news has been seen.
  useEffect(() => {
    const seen = (): void => {
      if (document.hidden) return
      const { activeId, unread } = useStore.getState()
      if (!activeId || !unread[activeId]) return
      useStore.setState((draft) => {
        delete draft.unread[activeId]
      })
    }
    document.addEventListener('visibilitychange', seen)
    window.addEventListener('focus', seen)
    return () => {
      document.removeEventListener('visibilitychange', seen)
      window.removeEventListener('focus', seen)
    }
  }, [])

  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (!state.notify) return
        if (state.unread !== previous.unread) {
          for (const [sessionId, how] of Object.entries(state.unread)) {
            if (previous.unread[sessionId] !== how) notify(state.projects, sessionId, NEWS[how])
          }
        }
        // The first list read in is not news: those prompts were open before this page was.
        if (state.projects !== previous.projects && previous.projects.length > 0) {
          const before = new Set(waitingIds(previous.projects))
          for (const sessionId of waitingIds(state.projects)) {
            if (!before.has(sessionId)) notify(state.projects, sessionId, NEWS.waiting)
          }
        }
      }),
    [],
  )

  return null
}

function waitingIds(projects: ProjectGroup[]): string[] {
  return projects.flatMap((project) =>
    project.sessions.filter((session) => session.live && session.waiting).map((session) => session.sessionId),
  )
}

/** Desktop notifications need a secure page (HTTPS or localhost) and the browser's permission. */
export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined' && window.isSecureContext
}

/**
 * One notification per session — a newer one replaces it — and only while the
 * page is not in front: there the sidebar already says it. Clicking it brings
 * the page forward on that session.
 */
function notify(projects: ProjectGroup[], sessionId: string, news: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  if (!document.hidden && document.hasFocus()) return
  const project = projects.find((group) => group.sessions.some((session) => session.sessionId === sessionId))
  const session = project?.sessions.find((entry) => entry.sessionId === sessionId)
  const where = project?.cwd.split('/').filter(Boolean).at(-1)
  const notification = new Notification(session ? sessionTitle(session.summary) : BASE_TITLE, {
    body: where ? `${news} · ${where}` : news,
    tag: `ccw-${sessionId}`,
    icon: '/apple-touch-icon.png',
  })
  notification.onclick = () => {
    window.focus()
    void useStore.getState().openSession(sessionId)
    notification.close()
  }
}
