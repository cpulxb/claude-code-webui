import { fuzzyFilter, type ProjectGroup, type SessionSummary, type UpdateProgress } from '@ccw/shared'
import { useEffect, useMemo, useRef, useState } from 'react'

import { call } from '../../api/client.ts'
import { sessionHref, useStore } from '../../store/session.ts'
import { sessionTitle } from '../../utils/session-title.ts'
import { DevicesDialog } from '../auth/DevicesDialog.tsx'
import {
  BrandMark,
  ChevronsUpDownIcon,
  CircleArrowUpIcon,
  FolderIcon,
  GitBranchIcon,
  PanelLeftIcon,
  PencilIcon,
  SquarePenIcon,
  XIcon,
} from '../Icons.tsx'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import styles from './Sidebar.module.css'
import { UpdateDialog } from './UpdateDialog.tsx'

/** The project the list shows survives a reload, even with no session open. */
const SELECTED_KEY = 'ccw.selectedProject'
/** How long the check button says "已是最新" before offering itself again. */
const UP_TO_DATE_MS = 3_000

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
  const update = useStore((state) => state.update)
  const defaultCwd = useStore((state) => state.defaultCwd)
  const createSession = useStore((state) => state.createSession)
  const openSession = useStore((state) => state.openSession)
  const closeSession = useStore((state) => state.closeSession)
  const renameSavedSession = useStore((state) => state.renameSavedSession)
  const refreshProjects = useStore((state) => state.refreshProjects)
  const checkUpdate = useStore((state) => state.checkUpdate)
  const setSettingsOpen = useStore((state) => state.setSettingsOpen)

  const [selectedCwd, setSelectedCwd] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY))
  const [picking, setPicking] = useState(false)
  const [showDevices, setShowDevices] = useState(false)
  const [showUpdate, setShowUpdate] = useState(false)
  const [updateCheck, setUpdateCheck] = useState<'idle' | 'running' | 'upToDate'>('idle')
  const [query, setQuery] = useState('')
  const [hitIndex, setHitIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // The terminal's `/resume` ctrl+b: off by default, offered once the
  // project's branch is known.
  const [onlyBranch, setOnlyBranch] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)

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
  const projectSessions = projects.find((project) => project.cwd === currentCwd)?.sessions ?? []
  // Only worth offering when the sessions span branches.
  const branched = new Set(projectSessions.map((session) => session.gitBranch).filter(Boolean)).size > 1

  useEffect(() => {
    setBranch(null)
    if (!currentCwd || !branched) return
    let stale = false
    call('scm.status', { cwd: currentCwd })
      .then(({ status }) => {
        if (!stale && status.kind === 'git' && status.branch) setBranch(status.branch)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [currentCwd, branched])

  const currentSessions =
    onlyBranch && branch ? projectSessions.filter((session) => session.gitBranch === branch) : projectSessions

  const hits: SearchHit[] = useMemo(() => {
    if (query.trim() === '') return []
    const all = projects.flatMap((project) =>
      project.sessions.map((session) => ({ ...session, cwd: project.cwd })),
    )
    return fuzzyFilter(query.trim(), all, (hit) => `${hit.summary} ${hit.firstPrompt ?? ''} ${basename(hit.cwd)}`)
  }, [projects, query])

  const searching = query.trim() !== ''

  useEffect(() => setHitIndex(0), [query])

  useEffect(() => {
    if (updateCheck !== 'upToDate') return
    const timer = setTimeout(() => setUpdateCheck('idle'), UP_TO_DATE_MS)
    return () => clearTimeout(timer)
  }, [updateCheck])

  const run = (action: Promise<unknown>, failure: string): void => {
    setError(null)
    void action
      .then(() => refreshProjects())
      .catch((cause: unknown) => setError(`${failure}：${cause instanceof Error ? cause.message : String(cause)}`))
  }

  // A release it finds shows up as the card above the footer; only "nothing
  // new" needs saying here.
  const checkForUpdate = (): void => {
    setError(null)
    setUpdateCheck('running')
    checkUpdate()
      .then((status) => setUpdateCheck(status.latest ? 'idle' : 'upToDate'))
      .catch((cause: unknown) => {
        setUpdateCheck('idle')
        setError(`检查更新失败：${cause instanceof Error ? cause.message : String(cause)}`)
      })
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
          <span className={styles.brandMark}>
            <BrandMark size={15} />
          </span>
          Claude Code
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
        <SquarePenIcon size={14} />
        新会话
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
          <>
            {branch && (
              <button
                className={`${styles.branchFilter} ${onlyBranch ? styles.branchFilterOn : ''}`}
                onClick={() => setOnlyBranch(!onlyBranch)}
                type="button"
                aria-pressed={onlyBranch}
                title={onlyBranch ? '显示所有分支的会话' : `只显示在 ${branch} 分支上的会话`}
              >
                <GitBranchIcon size={12} />
                <span className={styles.branchName}>{onlyBranch ? `只看 ${branch}` : '所有分支'}</span>
              </button>
            )}
            <SessionList
              sessions={currentSessions}
              emptyText={onlyBranch && branch ? `${branch} 分支上还没有会话` : '这个项目还没有会话'}
              activeId={activeId}
              onOpen={(sessionId) => {
                if (currentCwd) run(openSession(sessionId, currentCwd), '打开会话失败')
              }}
              onClose={(sessionId) => void closeSession(sessionId)}
              onRename={(session, title) => {
                const cwd = session.cwd ?? currentCwd
                if (cwd) run(renameSavedSession(session.sessionId, cwd, title), '重命名失败')
              }}
            />
          </>
        )}
      </div>

      {update?.latest && (
        <button className={styles.update} onClick={() => setShowUpdate(true)} type="button">
          <span className={styles.updateMark}>
            <CircleArrowUpIcon size={14} />
          </span>
          <span className={styles.updateText}>新版本 v{update.latest}</span>
          <span className={styles.updateAction}>{updateAction(update.progress)}</span>
        </button>
      )}

      <div className={styles.foot}>
        <span
          className={`${styles.statusDot} ${connection === 'open' ? styles.statusOpen : ''} ${
            connection === 'closed' ? styles.statusClosed : ''
          }`}
        />
        <span className={styles.footStatus}>
          {connection === 'open' ? '已连接' : connection === 'connecting' ? '连接中…' : '连接断开，重试中'}
        </span>
        <span className={styles.spacer} />
        {update && (
          <>
            <span title="Claude Code WebUI 版本">v{update.current}</span>
            <button
              className={styles.footButton}
              onClick={checkForUpdate}
              disabled={updateCheck === 'running'}
              type="button"
              title="立即检查有没有新版本"
            >
              {updateCheck === 'running' ? '检查中…' : updateCheck === 'upToDate' ? '已是最新' : '检查更新'}
            </button>
          </>
        )}
        <button className={styles.footButton} onClick={() => setSettingsOpen(true)} type="button" title="渠道、模型和 settings.json">
          设置
        </button>
        <button className={styles.footButton} onClick={() => setShowDevices(true)} type="button" title="已配对的设备">
          设备
        </button>
      </div>

      {showDevices && <DevicesDialog onClose={() => setShowDevices(false)} />}
      {showUpdate && <UpdateDialog onClose={() => setShowUpdate(false)} />}
    </div>
  )
}

function updateAction(progress: UpdateProgress | null): string {
  switch (progress?.state) {
    case undefined:
      return '更新'
    case 'running':
      return '更新中…'
    case 'restarting':
      return '重启中…'
    case 'restartRequired':
      return '待重启'
    case 'failed':
      return '失败'
  }
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
        <span className={styles.switcherCaret}>
          <ChevronsUpDownIcon size={14} />
        </span>
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
  emptyText: string
  activeId: string | null
  onOpen: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onRename: (session: SessionSummary, title: string) => void
}): JSX.Element {
  const activeRef = useRef<HTMLDivElement>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  // `containsActive` re-runs this once the history arrives after the list
  // first rendered empty.
  const containsActive = props.sessions.some((session) => session.sessionId === props.activeId)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [props.activeId, containsActive])

  if (props.sessions.length === 0) return <div className={styles.empty}>{props.emptyText}</div>

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
              {renaming === session.sessionId ? (
                <RenameInput
                  title={session.summary}
                  onDone={(title) => {
                    setRenaming(null)
                    if (title !== null) props.onRename(session, title)
                  }}
                />
              ) : (
                <a
                  className={styles.itemOpen}
                  href={sessionHref(session.sessionId)}
                  onClick={(event) => openInPlace(event, () => props.onOpen(session.sessionId))}
                  title={session.summary || '新会话'}
                  aria-current={session.sessionId === props.activeId ? 'page' : undefined}
                >
                  {session.live && <span className={styles.liveDot} />}
                  <span className={styles.itemTitle}>{sessionTitle(session.summary)}</span>
                  <span className={styles.itemAge}>{age(session.lastModified)}</span>
                </a>
              )}
              {/* A session nobody has written to yet has no transcript to retitle. */}
              {renaming !== session.sessionId && session.summary && (
                <button
                  className={styles.itemAction}
                  onClick={() => setRenaming(session.sessionId)}
                  type="button"
                  title="重命名"
                  aria-label="重命名会话"
                >
                  <PencilIcon size={12} />
                </button>
              )}
              {session.live && (
                <button
                  className={styles.itemAction}
                  onClick={() => props.onClose(session.sessionId)}
                  type="button"
                  title="关闭会话（结束它的 CLI 进程）"
                  aria-label="关闭会话"
                >
                  <XIcon size={12} />
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
          <a
            className={styles.hitOpen}
            href={sessionHref(hit.sessionId)}
            onClick={(event) => openInPlace(event, () => props.onOpen(hit))}
            title={hit.summary}
          >
            <span className={styles.hitTitleLine}>
              {hit.live && <span className={styles.liveDot} />}
              <span className={styles.itemTitle}>{sessionTitle(hit.summary)}</span>
              <span className={styles.itemAge}>{age(hit.lastModified)}</span>
            </span>
            <span className={styles.hitMeta}>
              {basename(hit.cwd)}
              {hit.gitBranch ? ` · ${hit.gitBranch}` : ''}
            </span>
          </a>
          {hit.live && (
            <button
              className={styles.itemAction}
              onClick={() => props.onClose(hit.sessionId)}
              type="button"
              title="关闭会话（结束它的 CLI 进程）"
              aria-label="关闭会话"
            >
              <XIcon size={12} />
            </button>
          )}
        </div>
      ))}
    </>
  )
}

/**
 * The row's title, editable in place — `/resume`'s ctrl+r. Enter or leaving
 * the field keeps the new name; Escape, or a name left blank or unchanged,
 * keeps the old one (`null`).
 */
function RenameInput(props: { title: string; onDone: (title: string | null) => void }): JSX.Element {
  const [draft, setDraft] = useState(props.title)
  // Escape unmounts the field, and the blur that follows must not save it.
  const doneRef = useRef(false)

  const finish = (title: string | null): void => {
    if (doneRef.current) return
    doneRef.current = true
    const name = title?.trim()
    props.onDone(name && name !== props.title ? name : null)
  }

  return (
    <input
      className={styles.renameInput}
      value={draft}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(draft)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') finish(draft)
        else if (event.key === 'Escape') finish(null)
      }}
      aria-label="会话名称"
    />
  )
}

/** A plain click opens the session here; a modified one (new tab, new window) is the browser's. */
function openInPlace(event: React.MouseEvent, open: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  open()
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
