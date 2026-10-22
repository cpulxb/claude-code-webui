import { fuzzyFilter, type ProjectGroup, type SessionSummary } from '@ccw/shared'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useStore } from '../../store/session.ts'
import { FolderIcon, PanelLeftIcon } from '../Icons.tsx'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import styles from './Sidebar.module.css'

/** The project the list shows survives a reload, even with no session open. */
const SELECTED_KEY = 'ccw.selectedProject'

/** A search hit needs its project attached — the flat list loses the grouping. */
type SearchHit = SessionSummary & { cwd: string }

/**
 * One project's sessions at a time, picked from a switcher at the top — the
 * VS Code layout, since dozens of projects as one tree buried the one in use.
 * The sessions come from the same JSONL transcripts the terminal's `/resume`
 * picker reads. Typing in the filter box swaps the list for one flat
 * fuzzy-ranked list across every project, so other projects stay one search
 * away.
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

  const [selectedCwd, setSelectedCwd] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY))
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  // The list follows the open session, so one opened from search or another
  // tab brings its project along.
  useEffect(() => {
    if (activeCwd) setSelectedCwd(activeCwd)
  }, [activeCwd])

  useEffect(() => {
    if (selectedCwd) localStorage.setItem(SELECTED_KEY, selectedCwd)
  }, [selectedCwd])

  const currentCwd = selectedCwd ?? activeCwd ?? defaultCwd ?? projects[0]?.cwd ?? null
  const currentSessions = projects.find((project) => project.cwd === currentCwd)?.sessions ?? []

  const hits: SearchHit[] = useMemo(() => {
    if (query.trim() === '') return []
    const all = projects.flatMap((project) =>
      project.sessions.map((session) => ({ ...session, cwd: project.cwd })),
    )
    return fuzzyFilter(query.trim(), all, (hit) => `${hit.summary} ${hit.firstPrompt ?? ''} ${basename(hit.cwd)}`)
  }, [projects, query])

  const searching = query.trim() !== ''

  useEffect(() => setHitIndex(0), [query])

  const run = (action: Promise<unknown>, failure: string): void => {
    setError(null)
    void action
      .then(() => refreshProjects())
      .catch((cause: unknown) => setError(`${failure}：${cause instanceof Error ? cause.message : String(cause)}`))
  }

  const startSession = (cwd: string): void => {
    setPicking(false)
    setQuery('')
    setSelectedCwd(cwd)
    run(createSession(cwd), '新建会话失败')
  }

  const openHit = (hit: SearchHit): void => {
    run(openSession(hit.sessionId, hit.cwd), '打开会话失败')
  }

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

      <ProjectSwitcher
        projects={projects}
        cwd={currentCwd}
        onSelect={(cwd) => {
          setQuery('')
          setSelectedCwd(cwd)
        }}
        onBrowse={() => setPicking(true)}
      />

      {/* With a project chosen, a new session needs no directory dialog; the
          switcher's "其他目录" is the way to start one anywhere else. */}
      <button
        className={styles.newButton}
        onClick={() => (currentCwd ? startSession(currentCwd) : setPicking(true))}
        type="button"
        title={currentCwd ? `在 ${basename(currentCwd)} 新建会话` : '选择目录并新建会话'}
      >
        ⊕ 新会话
      </button>

      <input
        className={styles.search}
        value={query}
        placeholder="搜索所有项目的会话…"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onSearchKeyDown}
        aria-label="搜索会话"
      />

      {picking && (
        <DirectoryPicker
          {...(currentCwd ? { initialPath: currentCwd } : {})}
          onPick={startSession}
          onCancel={() => setPicking(false)}
        />
      )}

      {/* The eager attach behind an open runs after `openSession` resolves, so
          its failure only reaches here through the session's own error. */}
      {(error ?? sessionError) && <div className={styles.error}>{error ?? sessionError}</div>}

      {/* Keyed so switching projects starts the new list at its top, not at
          the scroll offset a long one like ~ was left at. */}
      <div className={styles.list} key={searching ? 'search' : `project:${currentCwd ?? ''}`}>
        {searching ? (
          <SearchResults
            hits={hits}
            hitIndex={hitIndex}
            activeId={activeId}
            onHover={setHitIndex}
            onOpen={openHit}
            onClose={(sessionId) => void closeSession(sessionId)}
          />
        ) : projects.length === 0 ? (
          <div className={styles.empty}>还没有会话记录</div>
        ) : (
          <SessionList
            sessions={currentSessions}
            activeId={activeId}
            onOpen={(sessionId) => {
              if (currentCwd) run(openSession(sessionId, currentCwd), '打开会话失败')
            }}
            onClose={(sessionId) => void closeSession(sessionId)}
          />
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
 * The project the list below shows. The menu is ordered by last activity and
 * filters by name or path, which matters once there are dozens of projects.
 */
function ProjectSwitcher(props: {
  projects: ProjectGroup[]
  cwd: string | null
  onSelect: (cwd: string) => void
  onBrowse: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLButtonElement>(null)

  const matches = useMemo(() => {
    if (filter.trim() === '') return props.projects
    return fuzzyFilter(filter.trim(), props.projects, (project) => `${basename(project.cwd)} ${project.cwd}`)
  }, [props.projects, filter])

  useEffect(() => setCursor(0), [filter, open])

  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const close = (): void => {
    setOpen(false)
    setFilter('')
  }

  const choose = (cwd: string): void => {
    close()
    props.onSelect(cwd)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      close()
      return
    }
    if (matches.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((index) => (index + 1) % matches.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((index) => (index - 1 + matches.length) % matches.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const project = matches[cursor]
      if (project) choose(project.cwd)
    }
  }

  return (
    <div className={styles.switcher} ref={rootRef}>
      <button
        className={styles.switcherButton}
        onClick={() => (open ? close() : setOpen(true))}
        type="button"
        title={props.cwd ?? undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <FolderIcon size={14} />
        <span className={styles.switcherName}>{props.cwd ? basename(props.cwd) : '选择项目'}</span>
        <span className={styles.switcherCaret}>▾</span>
      </button>

      {open && (
        <div className={styles.switcherPopover}>
          <input
            className={styles.switcherFilter}
            value={filter}
            autoFocus
            placeholder="筛选项目…"
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="筛选项目"
          />
          <div className={styles.switcherList} role="listbox">
            {matches.length === 0 && <div className={styles.empty}>没有匹配的项目</div>}
            {matches.map((project, index) => (
              <button
                key={project.cwd}
                ref={index === cursor ? cursorRef : null}
                className={`${styles.switcherRow} ${index === cursor ? styles.itemActive : ''}`}
                onClick={() => choose(project.cwd)}
                onMouseEnter={() => setCursor(index)}
                type="button"
                role="option"
                aria-selected={project.cwd === props.cwd}
              >
                <span className={styles.hitTitleLine}>
                  {project.sessions.some((session) => session.live) && <span className={styles.liveDot} />}
                  <span className={`${styles.itemTitle} ${project.cwd === props.cwd ? styles.switcherCurrent : ''}`}>
                    {basename(project.cwd)}
                  </span>
                  {project.sessions[0] && <span className={styles.itemAge}>{age(project.sessions[0].lastModified)}</span>}
                </span>
                <span className={styles.hitMeta}>{project.cwd}</span>
              </button>
            ))}
          </div>
          <button
            className={styles.switcherBrowse}
            onClick={() => {
              close()
              props.onBrowse()
            }}
            type="button"
          >
            在其他目录新建会话…
          </button>
        </div>
      )}
    </div>
  )
}

/** The current project's sessions, newest first, under 今天 / 昨天 / … headings. */
function SessionList(props: {
  sessions: SessionSummary[]
  activeId: string | null
  onOpen: (sessionId: string) => void
  onClose: (sessionId: string) => void
}): JSX.Element {
  const activeRef = useRef<HTMLDivElement>(null)
  // `containsActive` re-runs this once the history arrives after the list
  // first rendered empty.
  const containsActive = props.sessions.some((session) => session.sessionId === props.activeId)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [props.activeId, containsActive])

  if (props.sessions.length === 0) return <div className={styles.empty}>这个项目还没有会话</div>

  return (
    <>
      {bucketByAge(props.sessions).map((bucket) => (
        <div key={bucket.label}>
          <div className={styles.bucket}>{bucket.label}</div>
          {bucket.sessions.map((session) => (
            <div
              key={session.sessionId}
              ref={session.sessionId === props.activeId ? activeRef : null}
              className={`${styles.item} ${session.sessionId === props.activeId ? styles.itemActive : ''}`}
            >
              <button
                className={styles.itemOpen}
                onClick={() => props.onOpen(session.sessionId)}
                type="button"
                title={session.summary || '新会话'}
                aria-current={session.sessionId === props.activeId ? 'page' : undefined}
              >
                {session.live && <span className={styles.liveDot} />}
                <span className={styles.itemTitle}>{session.summary || '新会话'}</span>
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
        </div>
      ))}
    </>
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
              <span className={styles.itemTitle}>{hit.summary || '新会话'}</span>
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

const DAY = 24 * 60 * 60 * 1000

/** Splits a newest-first list at local midnight boundaries; empty buckets are dropped. */
function bucketByAge(sessions: SessionSummary[]): { label: string; sessions: SessionSummary[] }[] {
  const today = new Date().setHours(0, 0, 0, 0)
  const buckets = [
    { label: '今天', from: today, sessions: [] as SessionSummary[] },
    { label: '昨天', from: today - DAY, sessions: [] as SessionSummary[] },
    { label: '7 天内', from: today - 6 * DAY, sessions: [] as SessionSummary[] },
    { label: '30 天内', from: today - 29 * DAY, sessions: [] as SessionSummary[] },
    { label: '更早', from: -Infinity, sessions: [] as SessionSummary[] },
  ]
  for (const session of sessions) buckets.find((bucket) => session.lastModified >= bucket.from)!.sessions.push(session)
  return buckets.filter((bucket) => bucket.sessions.length > 0)
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
