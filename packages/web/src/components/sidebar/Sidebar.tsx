import type { ProjectGroup } from '@ccw/shared'
import { useEffect, useState } from 'react'

import { useStore } from '../../store/session.ts'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import styles from './Sidebar.module.css'

/**
 * Project-grouped session list, read from the same JSONL transcripts the
 * terminal's `/resume` picker reads — a session started in the terminal shows
 * up here, and vice versa.
 */
export function Sidebar({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const projects = useStore((state) => state.projects)
  const activeId = useStore((state) => state.activeId)
  const sessions = useStore((state) => state.sessions)
  const connection = useStore((state) => state.connection)
  const defaultCwd = useStore((state) => state.defaultCwd)
  const createSession = useStore((state) => state.createSession)
  const openSession = useStore((state) => state.openSession)
  const closeSession = useStore((state) => state.closeSession)
  const refreshProjects = useStore((state) => state.refreshProjects)

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const activeCwd = activeId ? sessions[activeId]?.cwd : undefined

  const startSession = (cwd: string): void => {
    setPicking(false)
    void createSession(cwd).then(() => refreshProjects())
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.brand}>
          <span className={styles.brandMark}>✳</span> Claude Code
        </span>
        <span className={styles.spacer} />
        <button className={styles.iconButton} onClick={onCollapse} type="button" title="收起侧栏">
          ⊟
        </button>
      </div>

      <button className={styles.newButton} onClick={() => setPicking(true)} type="button">
        ⊕ 新会话
      </button>

      {picking && (
        <DirectoryPicker
          {...(activeCwd ?? defaultCwd ? { initialPath: activeCwd ?? defaultCwd } : {})}
          onPick={startSession}
          onCancel={() => setPicking(false)}
        />
      )}

      <div className={styles.list}>
        {projects.length === 0 && <div className={styles.empty}>还没有会话记录</div>}
        {projects.map((project) => (
          <ProjectRow
            key={project.cwd}
            project={project}
            collapsed={collapsedGroups[project.cwd] ?? false}
            activeId={activeId}
            onToggle={() =>
              setCollapsedGroups((current) => ({ ...current, [project.cwd]: !(current[project.cwd] ?? false) }))
            }
            onOpen={(sessionId) => void openSession(sessionId, project.cwd).then(() => refreshProjects())}
            onClose={(sessionId) => void closeSession(sessionId)}
          />
        ))}
      </div>

      <div className={styles.foot}>
        <span
          className={`${styles.statusDot} ${connection === 'open' ? styles.statusOpen : ''} ${
            connection === 'closed' ? styles.statusClosed : ''
          }`}
        />
        {connection === 'open' ? '已连接' : connection === 'connecting' ? '连接中…' : '连接断开，重试中'}
      </div>
    </div>
  )
}

function ProjectRow(props: {
  project: ProjectGroup
  collapsed: boolean
  activeId: string | null
  onToggle: () => void
  onOpen: (sessionId: string) => void
  onClose: (sessionId: string) => void
}): JSX.Element {
  return (
    <>
      <button className={styles.groupHead} onClick={props.onToggle} type="button">
        <span className={`${styles.caret} ${props.collapsed ? '' : styles.caretOpen}`}>▶</span>
        <span className={styles.groupName} title={props.project.cwd}>
          {basename(props.project.cwd)}
        </span>
      </button>
      {!props.collapsed &&
        props.project.sessions.map((session) => (
          <div
            key={session.sessionId}
            className={`${styles.item} ${session.sessionId === props.activeId ? styles.itemActive : ''}`}
          >
            <button
              className={styles.itemOpen}
              onClick={() => props.onOpen(session.sessionId)}
              type="button"
              title={session.summary}
            >
              {session.live && <span className={styles.liveDot} />}
              <span className={styles.itemTitle}>{session.summary || '(无标题)'}</span>
              <span className={styles.itemAge}>{age(session.lastModified)}</span>
            </button>
            {session.live && (
              <button
                className={styles.itemClose}
                onClick={() => props.onClose(session.sessionId)}
                type="button"
                title="关闭会话（结束它的 CLI 进程）"
                aria-label="关闭会话"
              >
                ×
              </button>
            )}
          </div>
        ))}
    </>
  )
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function age(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)}分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  return `${Math.floor(hours / 24)}天`
}
