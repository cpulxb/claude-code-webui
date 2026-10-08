import { fuzzyFilter, type ProjectGroup, type SessionSummary } from '@ccw/shared'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useStore } from '../../store/session.ts'
import { PanelLeftIcon } from '../Icons.tsx'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import styles from './Sidebar.module.css'

/** Folded groups survive a reload; a long project list is folded on purpose. */
const COLLAPSED_KEY = 'ccw.collapsedGroups'

/** A search hit needs its project attached — the flat list loses the grouping. */
type SearchHit = SessionSummary & { cwd: string }

/**
 * Project-grouped session list, read from the same JSONL transcripts the
 * terminal's `/resume` picker reads — a session started in the terminal shows
 * up here, and vice versa. Typing in the filter box swaps the groups for one
 * flat fuzzy-ranked list across every project.
 */
export function Sidebar({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const projects = useStore((state) => state.projects)
  const activeId = useStore((state) => state.activeId)
  // Two string slices rather than the whole `sessions` record: immer replaces
  // that object on every streamed token, which re-ran the fuzzy filter and the
  // whole project list once per token.
  const activeCwd = useStore((state) => (state.activeId ? state.sessions[state.activeId]?.cwd : undefined))
  const sessionError = useStore((state) => (state.activeId ? state.sessions[state.activeId]?.error : null))

  const connection = useStore((state) => state.connection)
  const defaultCwd = useStore((state) => state.defaultCwd)
  const createSession = useStore((state) => state.createSession)
  const openSession = useStore((state) => state.openSession)
  const closeSession = useStore((state) => state.closeSession)
  const refreshProjects = useStore((state) => state.refreshProjects)

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const hits: SearchHit[] = useMemo(() => {
    if (query.trim() === '') return []
    const all = projects.flatMap((project) =>
      project.sessions.map((session) => ({ ...session, cwd: project.cwd })),
    )
    return fuzzyFilter(query.trim(), all, (hit) => `${hit.summary} ${hit.firstPrompt ?? ''} ${basename(hit.cwd)}`)
  }, [projects, query])

  const searching = query.trim() !== ''

  useEffect(() => setHitIndex(0), [query])

  const activeCwdOrDefault = activeCwd ?? defaultCwd

  const run = (action: Promise<unknown>, failure: string): void => {
    setError(null)
    void action
      .then(() => refreshProjects())
      .catch((cause: unknown) => setError(`${failure}：${cause instanceof Error ? cause.message : String(cause)}`))
  }

  const startSession = (cwd: string): void => {
    setPicking(false)
    run(createSession(cwd), '新建会话失败')
  }

  const openHit = (hit: SearchHit): void => {
    run(openSession(hit.sessionId, hit.cwd), '打开会话失败')
  }

  const toggleGroup = (cwd: string): void => {
    setCollapsedGroups((current) => ({ ...current, [cwd]: !(current[cwd] ?? false) }))
  }

  // Persisted from an effect, not from the updater above: StrictMode calls
  // updaters twice, and a write belongs outside a pure state transition.
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedGroups))
  }, [collapsedGroups])

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // Enter, arrows and Escape belong to the IME while choosing a candidate.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      setQuery('')
      return
    }
    if (hits.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHitIndex((index) => (index + 1) % hits.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHitIndex((index) => (index - 1 + hits.length) % hits.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const hit = hits[hitIndex]
      if (hit) openHit(hit)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.brand}>
          <span className={styles.brandMark}>✳</span> Claude Code
        </span>
        <span className={styles.spacer} />
        <button className={styles.iconButton} onClick={onCollapse} type="button" title="收起侧栏">
          <PanelLeftIcon />
        </button>
      </div>

      <button className={styles.newButton} onClick={() => setPicking(true)} type="button">
        ⊕ 新会话
      </button>

      <input
        className={styles.search}
        value={query}
        placeholder="搜索会话…"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onSearchKeyDown}
        aria-label="搜索会话"
      />

      {picking && (
        <DirectoryPicker
          {...(activeCwdOrDefault ? { initialPath: activeCwdOrDefault } : {})}
          onPick={startSession}
          onCancel={() => setPicking(false)}
        />
      )}

      {/* The eager attach behind an open runs after `openSession` resolves, so
          its failure only reaches here through the session's own error. */}
      {(error ?? sessionError) && <div className={styles.error}>{error ?? sessionError}</div>}

      <div className={styles.list}>
        {searching ? (
          <SearchResults
            hits={hits}
            hitIndex={hitIndex}
            activeId={activeId}
            onHover={setHitIndex}
            onOpen={openHit}
            onClose={(sessionId) => void closeSession(sessionId)}
          />
        ) : (
          <>
            {projects.length === 0 && <div className={styles.empty}>还没有会话记录</div>}
            {projects.map((project) => (
              <ProjectRow
                key={project.cwd}
                project={project}
                collapsed={collapsedGroups[project.cwd] ?? false}
                activeId={activeId}
                onToggle={() => toggleGroup(project.cwd)}
                onNew={() => startSession(project.cwd)}
                onOpen={(sessionId) => run(openSession(sessionId, project.cwd), '打开会话失败')}
                onClose={(sessionId) => void closeSession(sessionId)}
              />
            ))}
          </>
        )}
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

/**
 * The flat cross-project result list while filtering. The keyboard cursor
 * lives in the search input, so rows highlight via `hitIndex`, not focus.
 */
function SearchResults(props: {
  hits: SearchHit[]
  hitIndex: number
  activeId: string | null
  onHover: (index: number) => void
  onOpen: (hit: SearchHit) => void
  onClose: (sessionId: string) => void
}): JSX.Element {
  const cursorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [props.hitIndex])

  if (props.hits.length === 0) return <div className={styles.empty}>没有匹配的会话</div>

  return (
    <>
      {props.hits.map((hit, index) => (
        <div
          key={hit.sessionId}
          ref={index === props.hitIndex ? cursorRef : null}
          className={`${styles.hitRow} ${
            index === props.hitIndex || hit.sessionId === props.activeId ? styles.itemActive : ''
          }`}
          onMouseEnter={() => props.onHover(index)}
        >
          <button className={styles.hitOpen} onClick={() => props.onOpen(hit)} type="button" title={hit.summary}>
            <span className={styles.hitTitleLine}>
              {hit.live && <span className={styles.liveDot} />}
              <span className={styles.itemTitle}>{hit.summary || '(无标题)'}</span>
              <span className={styles.itemAge}>{age(hit.lastModified)}</span>
            </span>
            <span className={styles.hitMeta}>
              {basename(hit.cwd)}
              {hit.gitBranch ? ` · ${hit.gitBranch}` : ''}
            </span>
          </button>
          {hit.live && (
            <button
              className={styles.itemClose}
              onClick={() => props.onClose(hit.sessionId)}
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

function ProjectRow(props: {
  project: ProjectGroup
  collapsed: boolean
  activeId: string | null
  onToggle: () => void
  onNew: () => void
  onOpen: (sessionId: string) => void
  onClose: (sessionId: string) => void
}): JSX.Element {
  return (
    <>
      <div className={styles.groupHead}>
        <button className={styles.groupToggle} onClick={props.onToggle} type="button">
          <span className={`${styles.caret} ${props.collapsed ? '' : styles.caretOpen}`}>▶</span>
          <span className={styles.groupName} title={props.project.cwd}>
            {basename(props.project.cwd)}
          </span>
        </button>
        <button
          className={styles.groupAdd}
          onClick={props.onNew}
          type="button"
          title={`在 ${basename(props.project.cwd)} 新建会话`}
          aria-label="在此项目新建会话"
        >
          ＋
        </button>
      </div>
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
