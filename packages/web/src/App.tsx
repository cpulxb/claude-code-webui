import { useEffect, useState } from 'react'

import styles from './App.module.css'
import { AppFrame } from './components/AppFrame.tsx'
import { ChatView } from './components/chat/ChatView.tsx'
import { Composer } from './components/composer/Composer.tsx'
import { DetailsPanel } from './components/details/DetailsPanel.tsx'
import { Sidebar } from './components/sidebar/Sidebar.tsx'
import { useActiveSession, useStore } from './store/session.ts'

export function App(): JSX.Element {
  const connect = useStore((state) => state.connect)
  const restoreActive = useStore((state) => state.restoreActive)
  const session = useActiveSession()

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [detailsCollapsed, setDetailsCollapsed] = useState(true)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => connect(), [connect])
  useEffect(() => void restoreActive(), [restoreActive])

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  return (
    <AppFrame
      sidebarCollapsed={sidebarCollapsed}
      detailsCollapsed={detailsCollapsed}
      sidebar={<Sidebar onCollapse={() => setSidebarCollapsed(true)} />}
      details={<DetailsPanel session={session} onCollapse={() => setDetailsCollapsed(true)} />}
      main={
        <div className={styles.main}>
          <div className={styles.header}>
            {sidebarCollapsed && (
              <button className={styles.iconButton} onClick={() => setSidebarCollapsed(false)} type="button" title="展开侧栏">
                ⊞
              </button>
            )}
            <span className={styles.title}>{session ? shortCwd(session.cwd) : 'Claude Code'}</span>
            {session?.status === 'running' && <span className={styles.subtitle}>运行中…</span>}
            {session?.closed && <span className={styles.subtitle}>会话已结束</span>}
            <span className={styles.spacer} />
            <button
              className={styles.iconButton}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              type="button"
              title="切换主题"
            >
              {theme === 'light' ? '☾' : '☀'}
            </button>
            <button
              className={styles.iconButton}
              onClick={() => setDetailsCollapsed(!detailsCollapsed)}
              type="button"
              title="会话详情"
            >
              ⊞
            </button>
          </div>

          {session ? (
            <>
              <ChatView session={session} />
              <Composer session={session} />
            </>
          ) : (
            <div className={styles.blank}>
              <span className={styles.blankMark}>✳</span>
              <span>从左侧选择一个会话，或新建一个</span>
            </div>
          )}
        </div>
      }
    />
  )
}

function shortCwd(cwd: string): string {
  return cwd.replace(/^\/root/, '~')
}
