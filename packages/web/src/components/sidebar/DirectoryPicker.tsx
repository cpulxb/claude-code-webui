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
  // What the path box holds; null until the first navigation or keystroke, so
  // it shows the listed directory (the initial one is only known from the server).
  const [text, setText] = useState<string | null>(null)
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

  /** Lists `path`, with the path box following along. */
  const navigate = (path: string): void => {
    load(path)
    setText(withSlash(path))
  }

  // Re-list on mount and whenever the hidden-file filter flips.
  useEffect(() => {
    load(listing?.path ?? props.initialPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden])

  const parent = listing?.parent
  const typed = text ?? (listing ? withSlash(listing.path) : '')
  const parts = splitTyped(typed)
  // Like VS Code's folder picker: the text after the last slash narrows the
  // listing of the directory before it, and Tab steps into the first match.
  const prefix = parts?.prefix.toLowerCase() ?? ''
  const entries = (listing?.entries ?? []).filter((entry) => entry.name.toLowerCase().startsWith(prefix))
  const match = prefix ? entries[0] : undefined
  // 打开 and Enter take what the box says: its directory, or a folder in it
  // named exactly as typed. Only once that directory is the one listed, so
  // neither a half-typed name nor a listing still loading opens the wrong one.
  const target =
    !parts || error || !listing || trimSlash(parts.dir) !== listing.path
      ? undefined
      : parts.prefix
        ? listing.entries.find((entry) => entry.name === parts.prefix)?.path
        : listing.path

  return (
    <div className={styles.backdrop} onMouseDown={props.onCancel}>
      <div className={styles.dialog} onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className={styles.title}>选择工作区目录</div>

        <div className={styles.pathRow}>
          <input
            className={styles.pathInput}
            value={typed}
            onChange={(event) => {
              const value = event.target.value
              const dir = splitTyped(value)?.dir
              // After a failed listing, retry so fixing the path clears the error.
              if (dir && (error || trimSlash(dir) !== listing?.path)) load(dir)
              setText(value)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter' && target) {
                props.onPick(target)
              } else if ((event.key === 'Enter' || event.key === 'Tab') && match) {
                event.preventDefault()
                navigate(match.path)
              } else if (event.key === 'Enter' && parts) {
                navigate(typed)
              }
            }}
          />
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.list}>
          {parent && (
            <button
              className={styles.entry}
              onMouseDown={keepFocus}
              onClick={() => navigate(parent)}
              type="button"
              title="上一级"
            >
              <UpIcon />
              <span className={styles.entryName}>..</span>
            </button>
          )}
          {listing?.entries.length === 0 && <div className={styles.empty}>此目录下没有子目录</div>}
          {listing && listing.entries.length > 0 && entries.length === 0 && (
            <div className={styles.empty}>没有匹配的目录</div>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              className={`${styles.entry} ${entry === match ? styles.entrySelected : ''}`}
              onMouseDown={keepFocus}
              onClick={() => navigate(entry.path)}
              type="button"
            >
              <FolderIcon />
              <span className={styles.entryName}>{entry.name}</span>
              <ChevronIcon />
            </button>
          ))}
        </div>

        <div className={styles.foot}>
          <button
            className={`${styles.toggle} ${showHidden ? styles.toggleOn : ''}`}
            onMouseDown={keepFocus}
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
            onClick={() => target && props.onPick(target)}
            disabled={!target}
            type="button"
          >
            打开
          </button>
        </div>
      </div>
    </div>
  )
}

/** Splits typed text into the directory to list and the name prefix to filter it by. */
function splitTyped(text: string): { dir: string; prefix: string } | null {
  const slash = text.lastIndexOf('/')
  return slash < 0 ? null : { dir: text.slice(0, slash + 1), prefix: text.slice(slash + 1) }
}

function withSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`
}

/** Listings carry no trailing slash; the root keeps its own. */
function trimSlash(dir: string): string {
  return dir.replace(/(.)\/+$/, '$1')
}

/**
 * Clicking a row or the hidden-file toggle leaves the caret in the path box,
 * so typing to narrow the next listing can carry straight on.
 */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault()
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

/** Marks a row that opens into a deeper listing rather than picking it. */
function ChevronIcon(): JSX.Element {
  return (
    <svg className={styles.chevron} width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
