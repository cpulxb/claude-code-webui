import type { AuthStatus, ProjectGroup, SessionSummary } from '@ccw/shared'
import { useCallback, useEffect, useState } from 'react'

import { fetchAuthStatus, onUnauthorized } from './api/client.ts'
import styles from './App.module.css'
import { AppFrame } from './components/AppFrame.tsx'
import { Attention } from './components/Attention.tsx'
import { PairingScreen } from './components/auth/PairingScreen.tsx'
import { ChatView } from './components/chat/ChatView.tsx'
import { Composer } from './components/composer/Composer.tsx'
import { DetailsPanel } from './components/details/DetailsPanel.tsx'
import { EmptyState } from './components/EmptyState.tsx'
import { GitBranchIcon, MenuIcon, PanelLeftIcon, PanelRightIcon } from './components/Icons.tsx'
import { SettingsPage } from './components/settings/SettingsPage.tsx'
import { Sidebar } from './components/sidebar/Sidebar.tsx'
import { followAddressBar, leaveSettings, useActiveSessionValue, useStore } from './store/session.ts'
import { NARROW, useNarrow } from './utils/narrow.ts'
import { sessionTitle } from './utils/session-title.ts'

/**
 * Pairing gate. Off this machine the server answers nothing but the pairing
 * screen until this browser holds a device cookie, so the workspace — and with
 * it the event socket — mounts only once authenticated, and unmounts again if
 * the device is revoked while open.
 */
export function App(): JSX.Element | null {
  // 'unknown' when the server could not be asked: the workspace's own
  // reconnect loop takes over and re-checks once the server answers.
  const [auth, setAuth] = useState<AuthStatus | 'unknown' | null>(null)

  const check = useCallback(() => {
    fetchAuthStatus()
      .then(setAuth)
      .catch(() => setAuth('unknown'))
  }, [])

  useEffect(check, [check])
  useEffect(() => onUnauthorized(() => setAuth({ authenticated: false, local: false })), [])

  if (auth === null) return null
  if (auth !== 'unknown' && !auth.authenticated) return <PairingScreen onPaired={check} />
  return <Workspace />
}

function Workspace(): JSX.Element {
  const connect = useStore((state) => state.connect)
  // Primitive slices only — the details panel and the composer subscribe to
  // their own slices too. Subscribing to the session object anywhere in here
  // would re-render that subtree once per streamed token, because immer
  // replaces the object on every transcript mutation.
  const cwd = useActiveSessionValue((session) => session.cwd)
  const running = useActiveSessionValue((session) => session.status === 'running')
  const waiting = useActiveSessionValue((session) => session.pendingPermissions.length > 0)
  const closed = useActiveSessionValue((session) => session.closed)
  const activeId = useStore((state) => state.activeId)
  const summary = useStore((state) => activeEntry(state)?.summary)
  const branch = useStore((state) => activeEntry(state)?.gitBranch)
  const settingsSection = useStore((state) => state.settingsSection)
  const narrow = useNarrow()

  // A phone opens on the conversation; the session list is a drawer away.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => NARROW.matches)
  const [detailsCollapsed, setDetailsCollapsed] = useState(true)
  const [detailsMaximized, setDetailsMaximized] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => connect(), [connect])
  useEffect(() => followAddressBar(), [])

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  const toggleTheme = useCallback(() => setTheme((current) => (current === 'light' ? 'dark' : 'light')), [])
  const status = waiting ? 'waiting' : running ? 'running' : null

  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), [])
  const collapseDetails = useCallback(() => {
    setDetailsCollapsed(true)
    setDetailsMaximized(false)
  }, [])
  const revealDetails = useCallback(() => setDetailsCollapsed(false), [])
  const toggleMaximized = useCallback(() => setDetailsMaximized((maximized) => !maximized), [])

  // Drawers cover the conversation, so they close on shrinking into the phone
  // layout and once a session has been picked from them. With none open there
  // is no conversation to uncover: switching projects keeps the list up.
  useEffect(() => {
    if (!narrow || activeId === null) return
    collapseSidebar()
    collapseDetails()
  }, [narrow, activeId, collapseSidebar, collapseDetails])

  return (
    <>
      <AppFrame
        sidebarCollapsed={sidebarCollapsed}
        detailsCollapsed={detailsCollapsed}
        detailsMaximized={detailsMaximized}
        narrow={narrow}
        onCollapseSidebar={collapseSidebar}
        onCollapseDetails={collapseDetails}
        sidebar={<Sidebar onCollapse={collapseSidebar} theme={theme} onToggleTheme={toggleTheme} />}
        details={
          <DetailsPanel
            onCollapse={collapseDetails}
            onReveal={revealDetails}
            maximized={detailsMaximized}
            onToggleMaximize={toggleMaximized}
          />
        }
        main={
          <div className={styles.main}>
            <div className={styles.header}>
              {sidebarCollapsed && (
                <button
                  className={styles.iconButton}
                  onClick={() => setSidebarCollapsed(false)}
                  type="button"
                  title={narrow ? '会话列表' : '展开侧栏'}
                  aria-label={narrow ? '会话列表' : '展开侧栏'}
                >
                  {narrow ? <MenuIcon size={20} /> : <PanelLeftIcon />}
                </button>
              )}
              {/* Which project and branch the conversation works in, under its title:
                  on a phone the sidebar that says so is out of sight. */}
              <div className={styles.titles} title={cwd !== undefined ? `${summary || '新会话'}\n${shortCwd(cwd)}` : undefined}>
                <span className={styles.title}>{cwd !== undefined ? sessionTitle(summary) : 'Claude Code'}</span>
                {cwd !== undefined && (
                  <span className={styles.sub}>
                    {narrow && status && <span className={`${styles.dot} ${styles[`dot-${status}`]}`} />}
                    <span className={styles.subText}>{basename(cwd)}</span>
                    {branch && (
                      <>
                        <span className={styles.sep}>/</span>
                        <GitBranchIcon size={11} />
                        <span className={styles.subText}>{branch}</span>
                      </>
                    )}
                    {narrow && closed && <span className={styles.subText}>· 已结束</span>}
                  </span>
                )}
              </div>
              {!narrow && status && (
                <span className={`${styles.status} ${status === 'waiting' ? styles.statusWaiting : ''}`}>
                  <span className={`${styles.dot} ${styles[`dot-${status}`]}`} />
                  {status === 'waiting' ? '等你确认' : '运行中'}
                </span>
              )}
              {!narrow && closed && <span className={`${styles.status} ${styles.statusClosed}`}>会话已结束</span>}
              <span className={styles.spacer} />
              <button
                className={styles.iconButton}
                onClick={() => setDetailsCollapsed(!detailsCollapsed)}
                type="button"
                title="会话详情"
                aria-label="会话详情"
                aria-pressed={!detailsCollapsed}
              >
                <PanelRightIcon />
              </button>
            </div>

            {cwd !== undefined ? (
              <ActiveConversation />
            ) : (
              <EmptyState narrow={narrow} onShowSessions={() => setSidebarCollapsed(false)} />
            )}
          </div>
        }
      />
      {/* Over the frame, which stays mounted beneath so its sessions keep running; outside it, as a drawer's stacking context would cap the page on phones. */}
      {settingsSection && <SettingsPage section={settingsSection} onLeave={leaveSettings} />}
      <Attention />
    </>
  )
}

function ActiveConversation(): JSX.Element {
  return (
    <>
      <ChatView />
      <Composer />
    </>
  )
}

/**
 * The active session's sidebar entry, for its title and branch. Runs on every
 * store change — every streamed token — so it walks the list instead of
 * copying it, and callers select a primitive field off it.
 */
function activeEntry(state: { projects: ProjectGroup[]; activeId: string | null }): SessionSummary | undefined {
  for (const project of state.projects) {
    for (const entry of project.sessions) if (entry.sessionId === state.activeId) return entry
  }
  return undefined
}

function shortCwd(cwd: string): string {
  return cwd.replace(/^\/root/, '~')
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}
