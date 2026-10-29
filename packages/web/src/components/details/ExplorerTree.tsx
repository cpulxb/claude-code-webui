import type { SessionStatus, TreeEntry } from '@ccw/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

import { call } from '../../api/client.ts'
import { FolderIcon, FolderOpenIcon, RefreshIcon } from '../Icons.tsx'
import panelStyles from './DetailsPanel.module.css'
import styles from './ExplorerTree.module.css'
import { FileTypeIcon } from './FileTypeIcon.tsx'

/**
 * 文件 tab of the details panel: a lazy tree over `files.list` — one readdir
 * per expanded node, never a recursive walk. Clicking a file hands it to the
 * panel, which opens it as an editor tab beside the tree's own.
 */
export function ExplorerTree({
  cwd,
  turnStatus,
  fsVersion,
  onOpenFile,
}: {
  cwd: string
  turnStatus: SessionStatus
  /** Bumped by the store after a rewind or save — the tree changed without a turn. */
  fsVersion: number
  onOpenFile: (entry: TreeEntry) => void
}): JSX.Element {
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({})
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
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
  // whatever is expanded. The mount pass doubles as the initial read, and
  // goes ahead mid-turn — the tree would sit empty until the turn ended.
  useEffect(() => {
    if (turnStatus !== 'idle' && children[cwd]) return
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

  return (
    <div>
      <div className={styles.rootRow}>
        <span className={styles.icon}>
          <FolderOpenIcon size={13} />
        </span>
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
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  )
}

/** dsh look: dotfiles fade back, real directories carry the weight. */
function rowClass(entry: TreeEntry): string {
  if (entry.name.startsWith('.')) return `${styles.row} ${styles.rowMuted}`
  return entry.isDirectory ? `${styles.row} ${styles.rowStrong}` : styles.row
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
              className={rowClass(entry)}
              style={indent}
              onClick={() => onOpenFile(entry)}
              type="button"
              title={entry.path}
            >
              <span className={styles.icon}>
                <FileTypeIcon name={entry.name} size={13} />
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
              className={rowClass(entry)}
              style={indent}
              onClick={() => onToggle(entry.path)}
              type="button"
              title={entry.path}
            >
              <span className={styles.icon}>
                {expanded ? <FolderOpenIcon size={13} /> : <FolderIcon size={13} />}
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

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return (index === -1 ? trimmed : trimmed.slice(index + 1)) || path
}
