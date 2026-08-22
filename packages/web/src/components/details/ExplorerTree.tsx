import type { FilePreview, SessionStatus, TreeEntry } from '@ccw/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

import { call } from '../../api/client.ts'
import { ChevronRightIcon, FileIcon, FolderIcon, RefreshIcon, XIcon } from '../Icons.tsx'
import panelStyles from './DetailsPanel.module.css'
import styles from './ExplorerTree.module.css'

/**
 * 文件 tab of the details panel: a lazy tree over `files.list` — one readdir
 * per expanded node, never a recursive walk — with a bounded preview overlay
 * behind `files.read`.
 */
export function ExplorerTree({
  cwd,
  turnStatus,
  fsVersion,
}: {
  cwd: string
  turnStatus: SessionStatus
  /** Bumped by the store after a rewind — the tree changed without a turn. */
  fsVersion: number
}): JSX.Element {
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({})
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ entry: TreeEntry; data: FilePreview | null } | null>(null)
  // Mirrors `open` so the turn-end refresh effect does not refire on toggles.
  const openRef = useRef<ReadonlySet<string>>(open)
  openRef.current = open

  const loadDir = useCallback(async (path: string): Promise<void> => {
    try {
      const result = await call('files.list', { path })
      setChildren((prev) => ({ ...prev, [path]: result.entries }))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // A turn ending is when the tree can have changed; re-read the root and
  // whatever is expanded. The mount pass doubles as the initial read.
  useEffect(() => {
    if (turnStatus !== 'idle') return
    void loadDir(cwd)
    for (const dir of openRef.current) void loadDir(dir)
  }, [turnStatus, fsVersion, cwd, loadDir])

  const toggleDir = (path: string): void => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!children[path]) void loadDir(path)
  }

  const openFile = async (entry: TreeEntry): Promise<void> => {
    setPreview({ entry, data: null })
    try {
      const result = await call('files.read', { path: entry.path })
      // A slow response for a file the user already closed must not reopen it.
      setPreview((current) => (current?.entry.path === entry.path ? { entry, data: result.preview } : current))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPreview(null)
    }
  }

  return (
    <div>
      <div className={styles.rootRow}>
        <span className={styles.rootName} title={cwd}>
          {basename(cwd)}
        </span>
        <span className={panelStyles.spacer} />
        <button className={panelStyles.iconButton} onClick={() => void loadDir(cwd)} type="button" title="刷新">
          <RefreshIcon size={14} />
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {!children[cwd] ? (
        <div className={panelStyles.empty}>读取中…</div>
      ) : children[cwd].length === 0 ? (
        <div className={panelStyles.empty}>空目录</div>
      ) : (
        <Rows
          entries={children[cwd]}
          depth={0}
          open={open}
          childrenByDir={children}
          onToggle={toggleDir}
          onOpenFile={(entry) => void openFile(entry)}
        />
      )}

      {preview && <PreviewOverlay entry={preview.entry} data={preview.data} onClose={() => setPreview(null)} />}
    </div>
  )
}

function Rows({
  entries,
  depth,
  open,
  childrenByDir,
  onToggle,
  onOpenFile,
}: {
  entries: TreeEntry[]
  depth: number
  open: ReadonlySet<string>
  childrenByDir: Record<string, TreeEntry[]>
  onToggle: (path: string) => void
  onOpenFile: (entry: TreeEntry) => void
}): JSX.Element {
  return (
    <>
      {entries.map((entry) => {
        const indent = { paddingLeft: 6 + depth * 14 }

        if (!entry.isDirectory) {
          return (
            <button
              key={entry.path}
              className={styles.row}
              style={indent}
              onClick={() => onOpenFile(entry)}
              type="button"
              title={entry.path}
            >
              {/* Files carry no chevron; the pad keeps their names aligned with siblings. */}
              <span className={styles.chevronPad} />
              <span className={styles.icon}>
                <FileIcon size={13} />
              </span>
              <span className={styles.name}>{entry.name}</span>
            </button>
          )
        }

        const expanded = open.has(entry.path)
        const kids = childrenByDir[entry.path]
        return (
          <div key={entry.path}>
            <button
              className={styles.row}
              style={indent}
              onClick={() => onToggle(entry.path)}
              type="button"
              title={entry.path}
            >
              <span className={expanded ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}>
                <ChevronRightIcon size={12} />
              </span>
              <span className={styles.icon}>
                <FolderIcon size={13} />
              </span>
              <span className={styles.name}>{entry.name}</span>
            </button>

            {expanded &&
              (kids === undefined ? (
                <div className={styles.note} style={{ paddingLeft: 6 + (depth + 1) * 14 }}>
                  读取中…
                </div>
              ) : kids.length === 0 ? (
                <div className={styles.note} style={{ paddingLeft: 6 + (depth + 1) * 14 }}>
                  空目录
                </div>
              ) : (
                <Rows
                  entries={kids}
                  depth={depth + 1}
                  open={open}
                  childrenByDir={childrenByDir}
                  onToggle={onToggle}
                  onOpenFile={onOpenFile}
                />
              ))}
          </div>
        )
      })}
    </>
  )
}

function PreviewOverlay({
  entry,
  data,
  onClose,
}: {
  entry: TreeEntry
  data: FilePreview | null
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.previewPanel} onClick={(event) => event.stopPropagation()}>
        <div className={styles.previewHead}>
          <span className={styles.previewName}>{entry.name}</span>
          <span className={styles.previewPath}>{entry.path}</span>
          {data && <span className={styles.previewSize}>{formatSize(data.size)}</span>}
          <button className={panelStyles.iconButton} onClick={onClose} type="button" title="关闭">
            <XIcon size={14} />
          </button>
        </div>

        <div className={styles.previewBody}>
          {!data ? (
            <div className={styles.previewEmpty}>读取中…</div>
          ) : data.kind === 'binary' ? (
            <div className={styles.previewEmpty}>二进制文件，无法预览</div>
          ) : data.kind === 'image' ? (
            <img className={styles.previewImage} src={`data:${data.mediaType};base64,${data.data}`} alt={entry.name} />
          ) : (
            <pre className={styles.previewText}>{data.content}</pre>
          )}
        </div>

        {data?.kind === 'text' && data.truncated && (
          <div className={styles.previewNote}>文件过大，仅显示前 256 KB（共 {formatSize(data.size)}）</div>
        )}
      </div>
    </div>
  )
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return (index === -1 ? trimmed : trimmed.slice(index + 1)) || path
}
