import type { AuthStatus } from '@ccw/shared'
import { useCallback, useEffect, useState } from 'react'

import { fetchAuthStatus, onUnauthorized } from './api/client.ts'
import styles from './App.module.css'
import { AppFrame } from './components/AppFrame.tsx'
import { PairingScreen } from './components/auth/PairingScreen.tsx'
import { ChatView } from './components/chat/ChatView.tsx'
import { Composer } from './components/composer/Composer.tsx'
import { DetailsPanel } from './components/details/DetailsPanel.tsx'
import { BrandMark, MoonIcon, PanelLeftIcon, PanelRightIcon, SunIcon } from './components/Icons.tsx'
import { Sidebar } from './components/sidebar/Sidebar.tsx'
import { useActiveSessionValue, useStore } from './store/session.ts'

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
  const restoreActive = useStore((state) => state.restoreActive)
  // Primitive slices only — the details panel and the composer subscribe to
  // their own slices too. Subscribing to the session object anywhere in here
  // would re-render that subtree once per streamed token, because immer
  // replaces the object on every transcript mutation.
  const cwd = useActiveSessionValue((session) => session.cwd)
  const running = useActiveSessionValue((session) => session.status === 'running')
  const closed = useActiveSessionValue((session) => session.closed)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [detailsCollapsed, setDetailsCollapsed] = useState(true)
  const [detailsMaximized, setDetailsMaximized] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => connect(), [connect])
  useEffect(() => void restoreActive(), [restoreActive])

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

  return (
    <AppFrame
      sidebarCollapsed={sidebarCollapsed}
      detailsCollapsed={detailsCollapsed}
      detailsMaximized={detailsMaximized}
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
            <span className={styles.title}>{cwd !== undefined ? shortCwd(cwd) : 'Claude Code'}</span>
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

function shortCwd(cwd: string): string {
  return cwd.replace(/^\/root/, '~')
}
