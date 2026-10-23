import type { DirectoryListing } from '@ccw/shared'
import { useEffect, useRef, useState } from 'react'

import { call } from '../../api/client.ts'
import styles from './DirectoryPicker.module.css'

/**
 * Workspace picker over the real filesystem on the server host.
 *
 * The server is where the repositories live, so the browser cannot use the
 * native file dialog — the listing comes from an RPC. Only directories are
 * offered, since a session's cwd is always one.
 */
export function DirectoryPicker(props: {
  initialPath?: string
  onPick: (path: string) => void
  onCancel: () => void
}): JSX.Element {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Listings race: a slow earlier response must not bounce the view back.
  const requestId = useRef(0)

  const load = (path?: string): void => {
    const id = ++requestId.current
    void call('files.browse', { ...(path ? { path } : {}), showHidden })
      .then((result) => {
        if (id !== requestId.current) return
        setListing(result)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  // Re-list on mount and whenever the hidden-file filter flips.
  useEffect(() => {
    load(listing?.path ?? props.initialPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden])

  const current = listing?.path ?? ''

  return (
    <div className={styles.backdrop} onMouseDown={props.onCancel}>
      <div className={styles.dialog} onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className={styles.title}>选择工作区目录</div>

        <div className={styles.pathRow}>
          {editing === null ? (
            <>
              <Breadcrumbs path={current} home={listing?.home ?? ''} onNavigate={load} />
              <button className={styles.iconButton} onClick={() => setEditing(current)} type="button" title="直接输入路径">
                <PencilIcon />
              </button>
            </>
          ) : (
            <input
              className={styles.pathInput}
              value={editing}
              autoFocus
              onChange={(event) => setEditing(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  load(editing)
                  setEditing(null)
                }
                if (event.key === 'Escape') setEditing(null)
              }}
            />
          )}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.list}>
          {listing?.parent && (
            <button className={styles.entry} onClick={() => load(listing.parent ?? undefined)} type="button">
              <UpIcon />
              <span className={styles.entryName}>上一级</span>
            </button>
          )}
          {listing?.entries.length === 0 && <div className={styles.empty}>此目录下没有子目录</div>}
          {listing?.entries.map((entry) => (
            <button key={entry.path} className={styles.entry} onClick={() => load(entry.path)} type="button">
              <FolderIcon />
              <span className={styles.entryName}>{entry.name}</span>
              <ChevronIcon />
            </button>
          ))}
        </div>

        <div className={styles.foot}>
          <button
            className={`${styles.toggle} ${showHidden ? styles.toggleOn : ''}`}
            onClick={() => setShowHidden(!showHidden)}
            type="button"
          >
            显示隐藏文件
          </button>
          <span className={styles.spacer} />
          <button className={styles.button} onClick={props.onCancel} type="button">
            取消
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            onClick={() => current && props.onPick(current)}
            disabled={!current}
            type="button"
          >
            打开
          </button>
        </div>
      </div>
    </div>
  )
}

function FolderIcon(): JSX.Element {
  return (
    <svg className={styles.folder} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.2c0-.66.54-1.2 1.2-1.2h3.1c.36 0 .7.16.93.44l.72.87h6.05c.66 0 1.2.54 1.2 1.2v6.3c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V4.2Z"
        stroke="currentColor"
        strokeWidth="1.15"
      />
    </svg>
  )
}

function UpIcon(): JSX.Element {
  return (
    <svg className={styles.folder} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 12.5V4m0 0L4.5 7.5M8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function PencilIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.6 3.1a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2L5.6 12.7l-3 .7.7-3zM9.2 4.5l2.3 2.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Marks a row that opens into a deeper listing rather than picking it. */
function ChevronIcon(): JSX.Element {
  return (
    <svg className={styles.chevron} width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Each ancestor is clickable, so going up several levels is one click. */
function Breadcrumbs({
  path,
  home,
  onNavigate,
}: {
  path: string
  home: string
  onNavigate: (path: string) => void
}): JSX.Element {
  const insideHome = home && (path === home || path.startsWith(`${home}/`))
  const segments = insideHome ? path.slice(home.length).split('/').filter(Boolean) : path.split('/').filter(Boolean)

  const crumbs = segments.map((name, index) => ({
    name,
    path: insideHome
      ? [home, ...segments.slice(0, index + 1)].join('/')
      : `/${segments.slice(0, index + 1).join('/')}`,
  }))

  const rootLabel = insideHome ? '主目录' : '/'
  const rootPath = insideHome ? home : '/'

  return (
    <span className={styles.crumbs}>
      <button
        className={`${styles.crumb} ${crumbs.length === 0 ? styles.crumbLast : ''}`}
        onClick={() => onNavigate(rootPath)}
        type="button"
      >
        {rootLabel}
      </button>
      {crumbs.map((crumb, index) => (
        <span key={crumb.path} style={{ display: 'contents' }}>
          <span className={styles.crumbSep}>/</span>
          <button
            className={`${styles.crumb} ${index === crumbs.length - 1 ? styles.crumbLast : ''}`}
            onClick={() => onNavigate(crumb.path)}
            type="button"
          >
            {crumb.name}
          </button>
        </span>
      ))}
    </span>
  )
}
