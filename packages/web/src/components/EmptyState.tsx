import { UNKNOWN_CWD } from '@ccw/shared'
import { useState } from 'react'

import { sessionHref, useProjectCwd, useStore } from '../store/session.ts'
import { activityOf } from '../utils/session-activity.ts'
import { sessionTitle } from '../utils/session-title.ts'
import styles from './EmptyState.module.css'
import { BrandMark, SquarePenIcon } from './Icons.tsx'
import { ActivityDot, age, openInPlace } from './sidebar/Sidebar.tsx'

/** How many of the project's sessions the empty state offers to pick up again. */
const RECENT = 5

/**
 * With no session open: the next things to do, rather than a pointer to the
 * sidebar, which on a phone is out of sight. Its latest sessions are the
 * sidebar's own list, cut short.
 */
export function EmptyState({ narrow, onShowSessions }: { narrow: boolean; onShowSessions: () => void }): JSX.Element {
  const projects = useStore((state) => state.projects)
  const unread = useStore((state) => state.unread)
  const createSession = useStore((state) => state.createSession)
  const openSession = useStore((state) => state.openSession)
  const refreshProjects = useStore((state) => state.refreshProjects)
  const cwd = useProjectCwd()
  const [error, setError] = useState<string | null>(null)

  const recent = (projects.find((project) => project.cwd === cwd)?.sessions ?? []).slice(0, RECENT)
  // The placeholder group is not a directory, so no session can start in it.
  const canStart = cwd !== null && cwd !== UNKNOWN_CWD

  const run = (action: Promise<unknown>, failure: string): void => {
    setError(null)
    void action
      .then(() => refreshProjects())
      .catch((cause: unknown) => setError(`${failure}：${cause instanceof Error ? cause.message : String(cause)}`))
  }

  return (
    <div className={styles.root}>
      <div className={styles.inner}>
        <span className={styles.mark}>
          <BrandMark size={30} />
        </span>
        <h1 className={styles.title}>{recent.length > 0 ? '接着上次的工作，或者开一个新会话' : '开始一个新会话'}</h1>
        {!canStart && <p className={styles.hint}>先在{narrow ? '会话列表' : '左侧'}顶部选择一个项目</p>}
        <div className={styles.actions}>
          {canStart && (
            <button className={styles.primary} onClick={() => run(createSession(cwd), '新建会话失败')} type="button">
              <SquarePenIcon size={15} />
              新会话
            </button>
          )}
          {narrow && (
            <button className={styles.secondary} onClick={onShowSessions} type="button">
              全部会话
            </button>
          )}
        </div>
        {error && <div className={styles.error}>{error}</div>}
        {cwd && recent.length > 0 && (
          <div className={styles.recent}>
            <div className={styles.recentLabel}>最近 · {basename(cwd)}</div>
            {recent.map((session) => (
              <a
                key={session.sessionId}
                className={styles.recentRow}
                href={sessionHref(session.sessionId)}
                onClick={(event) => openInPlace(event, () => run(openSession(session.sessionId, cwd), '打开会话失败'))}
                title={session.summary || '新会话'}
              >
                <span className={styles.lead}>
                  <ActivityDot activity={activityOf(session, unread[session.sessionId])} />
                </span>
                <span className={styles.recentTitle}>{sessionTitle(session.summary)}</span>
                <span className={styles.recentAge}>{age(session.lastModified)}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}
