import type { ContextUsage, SessionStatus, TreeEntry } from '@ccw/shared'
import { useCallback, useEffect, useRef, useState, type ReactNode, type WheelEvent } from 'react'
import { useShallow } from 'zustand/shallow'

import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { CompassIcon, InfoIcon, MaximizeIcon, MinimizeIcon, PanelRightIcon, PlusIcon, XIcon } from '../Icons.tsx'
import styles from './DetailsPanel.module.css'
import { ExplorerTree } from './ExplorerTree.tsx'
import { FileTypeIcon, WorkspaceFolderIcon } from './FileTypeIcon.tsx'
import { FileView } from './FileView.tsx'
import { ScmSection } from './ScmPanel.tsx'
import { StartPage } from './StartPage.tsx'

/** One panel tab. Editor tabs are keyed by absolute path; the rest are singletons. */
type Tab = { kind: 'start' } | { kind: 'files' } | { kind: 'info' } | { kind: 'file'; path: string; name: string }

type TabSet = { tabs: Tab[]; active: string }

/** A workspace seen for the first time, or whose last tab was just closed. */
const INITIAL: TabSet = { tabs: [{ kind: 'start' }], active: 'start' }

/** Paths are absolute, so they can never collide with the singleton ids. */
function tabId(tab: Tab): string {
  return tab.kind === 'file' ? tab.path : tab.kind
}

/**
 * Focuses `tab`, adding it if needed. The start page behaves like a browser's
 * new-tab page: whatever is picked while it is in front takes its place.
 */
function openTab(set: TabSet, tab: Tab): TabSet {
  const id = tabId(tab)
  const fromStart = set.active === 'start' && id !== 'start'
  if (set.tabs.some((entry) => tabId(entry) === id)) {
    return { tabs: fromStart ? set.tabs.filter((entry) => entry.kind !== 'start') : set.tabs, active: id }
  }
  return {
    tabs: fromStart ? set.tabs.map((entry) => (entry.kind === 'start' ? tab : entry)) : [...set.tabs, tab],
    active: id,
  }
}

/** Closing the focused tab hands focus to its right-hand neighbour, else the left one. */
function closeTab(set: TabSet, id: string): TabSet {
  const index = set.tabs.findIndex((entry) => tabId(entry) === id)
  if (index === -1) return set
  const tabs = set.tabs.filter((_, position) => position !== index)
  if (tabs.length === 0) return INITIAL
  if (set.active !== id) return { tabs, active: set.active }
  return { tabs, active: tabId(tabs[Math.min(index, tabs.length - 1)]!) }
}

/**
 * The right-hand panel, laid out like dsh's: a strip of closable tabs (start
 * page, file tree, session details, one editor per open file) over the body
 * of whichever is in front.
 */
export function DetailsPanel({
  onCollapse,
  onReveal,
  maximized,
  onToggleMaximize,
}: {
  onCollapse: () => void
  /** Un-collapses the panel — a shortcut can open a tab while it is hidden. */
  onReveal: () => void
  maximized: boolean
  onToggleMaximize: () => void
}): JSX.Element {
  const touchFs = useStore((state) => state.touchFs)
  // Slices rather than the session object: immer replaces that object on every
  // streamed token, which would re-render this whole panel once per token.
  const sessionId = useActiveSessionValue((session) => session.sessionId) ?? null
  const cwd = useActiveSessionValue((session) => session.cwd)
  const initCwd = useActiveSessionValue((session) => session.init?.cwd)
  const status = useActiveSessionValue((session) => session.status) ?? 'idle'
  const fsVersion = useActiveSessionValue((session) => session.fsVersion) ?? 0
  // One panel instance serves every session, and editor tabs are absolute
  // paths, so tabs belong to the workspace and not the session: sibling
  // sessions in the same cwd share them, and switching to another cwd and back
  // finds that project's tabs as they were left. Only the active cwd's tabs
  // are mounted. Unmounting a FileView does not lose its unsaved buffer:
  // FileView keeps drafts keyed by path, restores them when the file is opened
  // again, and flags the conflict if the file changed on disk meanwhile.
  const [tabsByCwd, setTabsByCwd] = useState<Record<string, TabSet>>({})
  const { tabs, active } = (cwd !== undefined ? tabsByCwd[cwd] : undefined) ?? INITIAL
  const stripRef = useRef<HTMLDivElement>(null)

  const update = useCallback(
    (change: (set: TabSet) => TabSet): void => {
      if (cwd === undefined) return
      setTabsByCwd((prev) => ({ ...prev, [cwd]: change(prev[cwd] ?? INITIAL) }))
    },
    [cwd],
  )

  // Ctrl+P opens the tree from anywhere on the page. It does take the
  // browser's print dialog away, which this UI has no use for.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'p') return
      event.preventDefault()
      onReveal()
      update((set) => openTab(set, { kind: 'files' }))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onReveal, update])

  useEffect(() => {
    stripRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, cwd])

  // The strip only scrolls sideways; a plain mouse wheel only scrolls down.
  const scrollStrip = (event: WheelEvent<HTMLDivElement>): void => {
    if (event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY
  }

  const openFile = (entry: TreeEntry): void => {
    update((set) => openTab(set, { kind: 'file', path: entry.path, name: entry.name }))
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        {sessionId !== null && cwd !== undefined && (
          <div className={styles.strip} ref={stripRef} onWheel={scrollStrip}>
            {tabs.map((tab) => {
              const id = tabId(tab)
              return (
                <div
                  key={id}
                  className={id === active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
                  {...(id === active ? { 'data-active': '' } : {})}
                >
                  <button
                    className={styles.tabMain}
                    onClick={() => update((set) => ({ ...set, active: id }))}
                    type="button"
                    title={tab.kind === 'file' ? tab.path : undefined}
                  >
                    <span className={styles.tabIcon}>{tabIcon(tab)}</span>
                    <span className={styles.tabLabel}>{tabLabel(tab)}</span>
                  </button>
                  <button
                    className={styles.tabClose}
                    onClick={() => update((set) => closeTab(set, id))}
                    type="button"
                    title="关闭"
                  >
                    <XIcon size={14} />
                  </button>
                </div>
              )
            })}
            <button
              className={styles.iconButton}
              onClick={() => update((set) => openTab(set, { kind: 'start' }))}
              type="button"
              title="新标签页"
            >
              <PlusIcon size={15} />
            </button>
          </div>
        )}
        <button
          className={styles.iconButton}
          onClick={onToggleMaximize}
          type="button"
          title={maximized ? '退出全屏' : '全屏'}
        >
          {maximized ? <MinimizeIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
        <button className={styles.iconButton} onClick={onCollapse} type="button" title="收起面板">
          <PanelRightIcon />
        </button>
      </div>

      <div className={styles.body}>
        {sessionId === null || cwd === undefined ? (
          <div className={`${styles.pane} ${styles.empty}`}>尚未选择会话</div>
        ) : (
          // Hidden rather than unmounted: switching tabs must not drop the
          // tree's expansion state or an edit in progress in some file tab.
          tabs.map((tab) => {
            const id = tabId(tab)
            const hidden = id !== active
            switch (tab.kind) {
              case 'start':
                return (
                  <div key={id} className={styles.fill} hidden={hidden}>
                    <StartPage
                      onOpenFiles={() => update((set) => openTab(set, { kind: 'files' }))}
                      onOpenInfo={() => update((set) => openTab(set, { kind: 'info' }))}
                    />
                  </div>
                )
              case 'files':
                return (
                  <div key={id} className={styles.pane} hidden={hidden}>
                    <ExplorerTree
                      key={initCwd ?? cwd}
                      cwd={initCwd ?? cwd}
                      turnStatus={status}
                      fsVersion={fsVersion}
                      onOpenFile={openFile}
                    />
                  </div>
                )
              case 'info':
                return (
                  <div key={id} className={styles.pane} hidden={hidden}>
                    <InfoPane sessionId={sessionId} cwd={initCwd ?? cwd} status={status} fsVersion={fsVersion} />
                  </div>
                )
              case 'file':
                return (
                  // Full-height so the editor fills the panel and scrolls
                  // inside itself; the tree and details scroll the body.
                  <div key={id} className={styles.fill} hidden={hidden}>
                    <FileView
                      path={tab.path}
                      turnStatus={status}
                      fsVersion={fsVersion}
                      onSaved={() => touchFs(sessionId)}
                    />
                  </div>
                )
            }
          })
        )}
      </div>
    </div>
  )
}

function tabLabel(tab: Tab): string {
  switch (tab.kind) {
    case 'start':
      return '开始'
    case 'files':
      return '文件'
    case 'info':
      return '详情'
    case 'file':
      return tab.name
  }
}

function tabIcon(tab: Tab): ReactNode {
  switch (tab.kind) {
    case 'start':
      return <CompassIcon size={14} />
    case 'files':
      return <WorkspaceFolderIcon size={15} />
    case 'info':
      return <InfoIcon size={14} />
    case 'file':
      return <FileTypeIcon name={tab.name} size={14} />
  }
}

/** 详情 tab: session facts drawn from the CLI's own `init` message. */
function InfoPane({
  sessionId,
  cwd,
  status,
  fsVersion,
}: {
  sessionId: string
  cwd: string
  status: SessionStatus
  fsVersion: number
}): JSX.Element {
  const [showTools, setShowTools] = useState(false)
  // Slices again, for the same reason as the panel's. `models` goes through
  // useShallow because re-attaching refetches the list.
  const init = useActiveSessionValue((session) => session.init) ?? null
  const model = useActiveSessionValue((session) => session.model) ?? null
  const commandCount = useActiveSessionValue((session) => session.commands.length) ?? 0
  const contextUsage = useActiveSessionValue((session) => session.contextUsage) ?? null
  const models = useActiveSessionValue(useShallow((session) => session.models)) ?? []
  // `model` holds whatever was selected, which is often an alias like
  // `sonnet`; the model list is what maps it back to a real wire id.
  const activeModel = models.find((entry) => entry.value === model || entry.resolvedModel === model)

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>运行时</div>
        <Field
          label="模型"
          value={activeModel?.resolvedModel ?? activeModel?.displayName ?? model ?? init?.model ?? '—'}
        />
        <Field label="目录" value={cwd} mono />
        {init && <Field label="CLI" value={init.version} />}
        <Field label="会话" value={sessionId.slice(0, 8)} mono />
      </div>

      {/* Keyed by cwd: switching workspaces drops open diffs and pending confirms. */}
      <ScmSection key={cwd} cwd={cwd} turnStatus={status} fsVersion={fsVersion} />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>能力</div>
        <Field label="命令" value={String(commandCount || init?.slashCommands.length || 0)} />
        {init && (
          <>
            <Field label="工具" value={String(init.tools.length)} />
            <button className={styles.toggle} onClick={() => setShowTools(!showTools)} type="button">
              {showTools ? '收起工具列表' : '查看工具列表'}
            </button>
            {showTools && (
              <div className={styles.tags} style={{ marginTop: 8 }}>
                {init.tools.map((tool) => (
                  <span key={tool} className={styles.tag}>
                    {tool}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {init ? (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>MCP 服务器</div>
          {init.mcpServers.length === 0 ? (
            <div className={styles.empty}>未配置</div>
          ) : (
            init.mcpServers.map((server) => (
              <div key={server.name} className={styles.mcpRow}>
                <span
                  className={`${styles.mcpDot} ${server.status === 'connected' ? styles.mcpConnected : ''} ${
                    server.status === 'failed' ? styles.mcpFailed : ''
                  }`}
                />
                {server.name}
              </div>
            ))
          )}
        </div>
      ) : (
        // `init` opens a turn, so a freshly created session has none yet.
        <div className={styles.empty}>发送首条消息后显示工具与 MCP 详情</div>
      )}

      {contextUsage && <ContextSection usage={contextUsage} />}
    </>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${mono ? styles.mono : ''}`}>{value}</span>
    </div>
  )
}

/**
 * The CLI colours these rows with theme names rather than CSS values, so the
 * mapping lives here. An unrecognised name is a new theme slot, not an error.
 */
const CONTEXT_COLORS: Record<string, string> = {
  claude: 'var(--ccw-accent)',
  permission: 'var(--ccw-accent)',
  planMode: 'var(--ccw-accent)',
  autoAccept: 'var(--ccw-success)',
  success: 'var(--ccw-success)',
  warning: 'var(--ccw-warning)',
  error: 'var(--ccw-danger)',
  text: 'var(--ccw-text-primary)',
  secondaryText: 'var(--ccw-text-secondary)',
  promptBorder: 'var(--ccw-border-l2)',
}

function contextColor(name: string): string {
  return CONTEXT_COLORS[name] ?? 'var(--ccw-text-faint)'
}

/** The `/context` grid and category breakdown, in the terminal's own layout. */
function ContextSection({ usage }: { usage: ContextUsage }): JSX.Element {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>上下文</div>
      <Field label="占用" value={`${usage.percentage}% · ${tokens(usage.totalTokens)} / ${tokens(usage.rawMaxTokens)}`} />

      <div className={styles.grid}>
        {usage.gridRows.map((row, y) => (
          <div key={y} className={styles.gridRow}>
            {row.map((cell, x) => (
              <span
                key={x}
                className={styles.square}
                style={{ background: contextColor(cell.color), opacity: cell.isFilled ? 1 : 0.2 }}
                title={`${cell.categoryName} · ${tokens(cell.tokens)}`}
              />
            ))}
          </div>
        ))}
      </div>

      {usage.categories.map((category) => (
        <div key={category.name} className={styles.catRow}>
          <span className={styles.catDot} style={{ background: contextColor(category.color) }} />
          <span className={styles.catName}>{category.name}</span>
          <span className={styles.catTokens}>{tokens(category.tokens)}</span>
        </div>
      ))}
    </div>
  )
}

function tokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}
