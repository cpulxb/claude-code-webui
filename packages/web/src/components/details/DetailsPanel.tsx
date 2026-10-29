import type { AccountInfo, ContextUsage, SessionStatus, TreeEntry } from '@ccw/shared'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type WheelEvent } from 'react'
import { useShallow } from 'zustand/shallow'

import { call } from '../../api/client.ts'
import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { SHOW_INFO_EVENT } from '../../utils/local-commands.ts'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import {
  CompassIcon,
  InfoIcon,
  MaximizeIcon,
  MinimizeIcon,
  PanelRightIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from '../Icons.tsx'
import styles from './DetailsPanel.module.css'
import { dirtyPaths, getDraft, putDraft, subscribeDrafts } from './drafts.ts'
import { ExplorerTree } from './ExplorerTree.tsx'
import { FileTypeIcon, WorkspaceFolderIcon } from './FileTypeIcon.tsx'
import { FileView } from './FileView.tsx'
import { McpSection } from './McpSection.tsx'
import { PluginsSection } from './PluginsSection.tsx'
import { ScmSection } from './ScmPanel.tsx'
import { SkillsSection } from './SkillsSection.tsx'
import { StartPage } from './StartPage.tsx'
import { TerminalView } from './TerminalView.tsx'

/**
 * One panel tab. Editor tabs are keyed by absolute path and terminals by a
 * generated id; the rest are singletons.
 */
type Tab =
  | { kind: 'start' }
  | { kind: 'files' }
  | { kind: 'info' }
  | { kind: 'file'; path: string; name: string }
  /** `cwd` is where the shell started; `title` is the shell's name once it is up. */
  | { kind: 'terminal'; id: string; cwd: string; title: string }

type TabSet = { tabs: Tab[]; active: string }

/** A workspace seen for the first time, or whose last tab was just closed. */
const INITIAL: TabSet = { tabs: [{ kind: 'start' }], active: 'start' }

/** Paths are absolute and terminal ids prefixed, so neither collides with a singleton id. */
function tabId(tab: Tab): string {
  return tab.kind === 'file' ? tab.path : tab.kind === 'terminal' ? tab.id : tab.kind
}

let terminalCount = 0

/** How long a section opened by a command is held at the top while the pane loads. */
const PIN_MS = 2000

/** Input that means the user is steering the panel themselves. */
const USER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/**
 * Brings a 详情 section to the top and holds it there while the sections
 * around it finish loading. They grow after the scroll has started: growth
 * below comes too late for the scroll to reach the top, growth above pushes
 * the section back down. Lets go after {@link PIN_MS}, or at the user's first
 * wheel, touch, click or key.
 */
function pinSection(id: string): () => void {
  const target = document.getElementById(id)
  const content = target?.parentElement
  if (!target || !content) return () => {}
  target.scrollIntoView({ block: 'start', behavior: 'smooth' })
  let first = true
  const observer = new ResizeObserver(() => {
    // The first call only reports the size the pane had when observed.
    if (first) first = false
    else target.scrollIntoView({ block: 'start' })
  })
  observer.observe(content)
  const release = (): void => {
    observer.disconnect()
    clearTimeout(timer)
    for (const type of USER_INPUT) window.removeEventListener(type, release, true)
  }
  const timer = setTimeout(release, PIN_MS)
  for (const type of USER_INPUT) window.addEventListener(type, release, { capture: true, passive: true })
  return release
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
  // `drafts` keeps it keyed by path, FileView restores it when the file is
  // shown again, and flags the conflict if the file changed on disk meanwhile.
  const [tabsByCwd, setTabsByCwd] = useState<Record<string, TabSet>>({})
  const { tabs, active } = (cwd !== undefined ? tabsByCwd[cwd] : undefined) ?? INITIAL
  const stripRef = useRef<HTMLDivElement>(null)
  const dirty = useSyncExternalStore(subscribeDrafts, dirtyPaths)
  /** The unsaved file tab whose close is waiting on 保存 / 不保存 / 取消. */
  const [closing, setClosing] = useState<{ id: string; path: string; name: string } | null>(null)

  // Drafts live in this page's memory only, so a reload or a closed browser
  // tab — the reload after an update included — would drop them unannounced.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (dirtyPaths().size === 0) return
      event.preventDefault()
      // What Chromium before 119 and older Safari go by instead.
      event.returnValue = true
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const update = useCallback(
    (change: (set: TabSet) => TabSet): void => {
      if (cwd === undefined) return
      setTabsByCwd((prev) => ({ ...prev, [cwd]: change(prev[cwd] ?? INITIAL) }))
    },
    [cwd],
  )

  const openTerminal = useCallback((): void => {
    if (cwd === undefined) return
    // Minted outside the updater, which StrictMode runs twice.
    const id = `terminal-${++terminalCount}`
    update((set) => openTab(set, { kind: 'terminal', id, cwd: initCwd ?? cwd, title: '终端' }))
  }, [cwd, initCwd, update])

  /** Names a terminal after its shell, in whichever workspace's set it lives. */
  const retitle = (scope: string, id: string, title: string): void => {
    setTabsByCwd((prev) => {
      const set = prev[scope]
      if (!set) return prev
      const tabs = set.tabs.map((tab) => (tab.kind === 'terminal' && tab.id === id ? { ...tab, title } : tab))
      return { ...prev, [scope]: { ...set, tabs } }
    })
  }

  // Ctrl+P opens the tree and Ctrl+` a terminal, from anywhere on the page.
  // Ctrl+P does take the browser's print dialog away, which this UI has no use
  // for; inside a terminal both keys reach the shell's own handling first
  // (see TerminalView), so readline's Ctrl+P still works there.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() === 'p') {
        event.preventDefault()
        onReveal()
        update((set) => openTab(set, { kind: 'files' }))
      } else if (event.code === 'Backquote' && event.ctrlKey) {
        event.preventDefault()
        onReveal()
        openTerminal()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onReveal, update, openTerminal])

  // `/mcp`, `/skills`, `/plugins` and `/status` from the composer: bring up 详情 at that section.
  useEffect(() => {
    let release = (): void => {}
    const onShow = (event: Event): void => {
      onReveal()
      update((set) => openTab(set, { kind: 'info' }))
      const section = (event as CustomEvent<string>).detail
      // Two frames: one for the tab to render, one for its layout to settle.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          release()
          release = pinSection(`ccw-info-${section}`)
        }),
      )
    }
    window.addEventListener(SHOW_INFO_EVENT, onShow)
    return () => {
      window.removeEventListener(SHOW_INFO_EVENT, onShow)
      release()
    }
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

  const close = (tab: Tab, id: string): void => {
    // A lone start page is what closing the last tab leaves behind, so
    // closing it as well puts the panel away.
    if (tabs.length === 1 && tab.kind === 'start') return onCollapse()
    // Once its tab is gone nothing shows a file's unsaved buffer any more, so
    // closing asks first, and the buffer is saved or goes with the tab.
    if (tab.kind === 'file' && dirty.has(tab.path)) return setClosing({ id, path: tab.path, name: tab.name })
    update((set) => closeTab(set, id))
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        {sessionId !== null && cwd !== undefined && (
          <div className={styles.strip} ref={stripRef} onWheel={scrollStrip}>
            {tabs.map((tab) => {
              const id = tabId(tab)
              const unsaved = tab.kind === 'file' && dirty.has(tab.path)
              return (
                <div
                  key={id}
                  className={`${styles.tab}${id === active ? ` ${styles.tabActive}` : ''}${unsaved ? ` ${styles.tabDirty}` : ''}`}
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
                    onClick={() => close(tab, id)}
                    type="button"
                    title={unsaved ? '关闭（有未保存的修改）' : '关闭'}
                  >
                    {unsaved && <span className={styles.tabDirtyDot} />}
                    <XIcon size={14} />
                  </button>
                </div>
              )
            })}
            <button
              className={styles.iconButton}
              onClick={() => update((set) => openTab(set, { kind: 'start' }))}
              // There is one start page, and it is already in front.
              disabled={active === 'start'}
              type="button"
              title="新标签页"
            >
              <PlusIcon size={15} />
            </button>
          </div>
        )}
        <button
          className={`${styles.iconButton} ${styles.maximize}`}
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
          <div className={styles.blank}>尚未选择会话</div>
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
                      onNewTerminal={openTerminal}
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
              case 'terminal':
                // Rendered below, outside this list.
                return null
            }
          })
        )}

        {/* Terminals of every workspace, in one list that never unmounts:
            unmounting kills the shell, so they stay running (hidden) while
            another workspace — or no session at all — is in front. */}
        {Object.entries(tabsByCwd).flatMap(([scope, set]) =>
          set.tabs.map((tab) => {
            if (tab.kind !== 'terminal') return null
            const shown = scope === cwd && sessionId !== null && set.active === tab.id
            return (
              <div key={tab.id} className={styles.fill} hidden={!shown}>
                <TerminalView cwd={tab.cwd} active={shown} onReady={(shell) => retitle(scope, tab.id, shell)} />
              </div>
            )
          }),
        )}
      </div>

      {closing && (
        <UnsavedDialog
          path={closing.path}
          name={closing.name}
          onSaved={() => {
            if (sessionId !== null) touchFs(sessionId)
          }}
          onClose={() => {
            setClosing(null)
            update((set) => closeTab(set, closing.id))
          }}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  )
}

/**
 * Asked before an unsaved file's tab closes, as an editor asks: save, drop
 * the edits, or keep the tab. Saving first checks the file still holds the
 * text the edits started from, as the editor's own save does, so closing
 * cannot write over what a turn changed meanwhile.
 */
function UnsavedDialog({
  path,
  name,
  onSaved,
  onClose,
  onCancel,
}: {
  path: string
  name: string
  onSaved: () => void
  onClose: () => void
  onCancel: () => void
}): JSX.Element {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const draft = getDraft(path)
    setSaving(true)
    setError(null)
    try {
      if (draft) {
        const { preview } = await call('files.read', { path })
        if (preview.kind !== 'text' || preview.content !== draft.base) {
          setError('文件在磁盘上已经变了，保存会盖掉那些变化。请先取消，回到编辑器里处理。')
          return
        }
        await call('files.write', { path, content: draft.text })
        putDraft(path, null)
        onSaved()
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ConfirmDialog
      title={`要保存对 ${name} 的修改吗？`}
      message="不保存的话，这些修改会丢失。"
      confirmLabel={saving ? '保存中…' : '保存'}
      busy={saving}
      error={error}
      alternative={{
        label: '不保存',
        onClick: () => {
          putDraft(path, null)
          onClose()
        },
      }}
      onConfirm={() => void save()}
      onCancel={onCancel}
    />
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
    case 'terminal':
      return tab.title
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
    case 'terminal':
      return <TerminalIcon size={14} />
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
  const attached = useActiveSessionValue((session) => session.attached) ?? false
  // `/status`'s account block. Asked of the runner, so only once one is up.
  const [account, setAccount] = useState<AccountInfo | null>(null)
  useEffect(() => {
    setAccount(null)
    if (!attached) return
    let stale = false
    call('session.account', { sessionId })
      .then((result) => {
        if (!stale) setAccount(result.account)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [sessionId, attached])

  return (
    <>
      <div className={styles.section} id="ccw-info-status">
        <div className={styles.sectionTitle}>运行时</div>
        <Field
          label="模型"
          value={activeModel?.resolvedModel ?? activeModel?.displayName ?? model ?? init?.model ?? '—'}
        />
        <Field label="目录" value={cwd} mono />
        {init && <Field label="CLI" value={init.version} />}
        <Field label="会话" value={sessionId} mono />
        {account?.email && <Field label="账号" value={account.email} />}
        {account?.organization && <Field label="组织" value={account.organization} />}
        {account?.subscriptionType && <Field label="订阅" value={account.subscriptionType} />}
        {(account?.apiKeySource ?? account?.tokenSource) && (
          <Field label="认证" value={(account.apiKeySource ?? account.tokenSource)!} />
        )}
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

      <McpSection sessionId={sessionId} attached={attached} snapshot={init?.mcpServers ?? null} />

      {/* Keyed by session: a list read for one must not show under another. */}
      <SkillsSection key={`skills-${sessionId}`} sessionId={sessionId} attached={attached} />
      <PluginsSection key={`plugins-${sessionId}`} sessionId={sessionId} attached={attached} />

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
