import type { AuthStatus, ProjectGroup } from '@ccw/shared'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import { fetchAuthStatus, onUnauthorized } from './api/client.ts'
import styles from './App.module.css'
import { AppFrame } from './components/AppFrame.tsx'
import { PairingScreen } from './components/auth/PairingScreen.tsx'
import { ChatView } from './components/chat/ChatView.tsx'
import { Composer } from './components/composer/Composer.tsx'
import { DetailsPanel } from './components/details/DetailsPanel.tsx'
import { BrandMark, MoonIcon, PanelLeftIcon, PanelRightIcon, SunIcon } from './components/Icons.tsx'
import { SettingsDialog } from './components/settings/SettingsDialog.tsx'
import { Sidebar } from './components/sidebar/Sidebar.tsx'
import { followAddressBar, useActiveSessionValue, useStore } from './store/session.ts'
import { sessionTitle } from './utils/session-title.ts'

/** Phone widths, where the side panels become drawers. Matches the 640px media queries in the CSS modules. */
const NARROW = window.matchMedia('(max-width: 640px)')

function subscribeNarrow(onChange: () => void): () => void {
  NARROW.addEventListener('change', onChange)
  return () => NARROW.removeEventListener('change', onChange)
}

function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => NARROW.matches)
}

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
  const closed = useActiveSessionValue((session) => session.closed)
  const activeId = useStore((state) => state.activeId)
  const summary = useStore(activeSummary)
  const settingsOpen = useStore((state) => state.settingsOpen)
  const setSettingsOpen = useStore((state) => state.setSettingsOpen)
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

  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), [])
  const collapseDetails = useCallback(() => {
    setDetailsCollapsed(true)
    setDetailsMaximized(false)
  }, [])
  const revealDetails = useCallback(() => setDetailsCollapsed(false), [])
  const toggleMaximized = useCallback(() => setDetailsMaximized((maximized) => !maximized), [])

  // Drawers cover the conversation, so they close on shrinking into the phone
  // layout and once a session has been picked from them.
  useEffect(() => {
    if (!narrow) return
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
        sidebar={<Sidebar onCollapse={collapseSidebar} />}
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
                <button className={styles.iconButton} onClick={() => setSidebarCollapsed(false)} type="button" title="展开侧栏">
                  <PanelLeftIcon />
                </button>
              )}
              <span className={styles.title} title={cwd !== undefined ? `${summary || '新会话'}\n${shortCwd(cwd)}` : undefined}>
                {cwd !== undefined ? sessionTitle(summary) : 'Claude Code'}
              </span>
              {running && <span className={styles.subtitle}>运行中…</span>}
              {closed && <span className={styles.subtitle}>会话已结束</span>}
              <span className={styles.spacer} />
              <button
                className={styles.iconButton}
                onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                type="button"
                title="切换主题"
              >
                {theme === 'light' ? <MoonIcon /> : <SunIcon />}
              </button>
              <button
                className={styles.iconButton}
                onClick={() => setDetailsCollapsed(!detailsCollapsed)}
                type="button"
                title="会话详情"
              >
                <PanelRightIcon />
              </button>
            </div>

            {cwd !== undefined ? (
              <ActiveConversation />
            ) : (
              <div className={styles.blank}>
                <span className={styles.blankMark}>
                  <BrandMark size={28} />
                </span>
                <span>从左侧选择一个会话，或新建一个</span>
              </div>
            )}
          </div>
        }
      />
      {/* Outside the frame: a drawer's stacking context would cap the dialog on phones. */}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
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
 * The active session's title, from its sidebar entry. Runs on every store
 * change — every streamed token — so it walks the list instead of copying it.
 */
function activeSummary(state: { projects: ProjectGroup[]; activeId: string | null }): string | undefined {
  for (const project of state.projects) {
    for (const entry of project.sessions) if (entry.sessionId === state.activeId) return entry.summary
  }
  return undefined
}

function shortCwd(cwd: string): string {
  return cwd.replace(/^\/root/, '~')
}
