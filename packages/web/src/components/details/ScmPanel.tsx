import type { ScmFile, ScmStatus, SessionStatus } from '@ccw/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

import { call } from '../../api/client.ts'
import { RefreshIcon, UndoIcon } from '../Icons.tsx'
import panelStyles from './DetailsPanel.module.css'
import styles from './ScmPanel.module.css'

const STATUS_LETTER: Record<ScmFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
}

/**
 * 源代码管理 section of the details panel: changed files against HEAD, a
 * per-file unified diff, and a two-click discard. Reads through the `scm.*`
 * RPCs, so it works for sessions opened read-only too — no runner required.
 */
export function ScmSection({ cwd, turnStatus }: { cwd: string; turnStatus: SessionStatus }): JSX.Element {
  const [status, setStatus] = useState<ScmStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ path: string; text: string; binary: boolean } | null>(null)
  const [confirmPath, setConfirmPath] = useState<string | null>(null)
  // Guards a slow diff response from landing on a row opened later.
  const openRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await call('scm.status', { cwd })
      setStatus(result.status)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [cwd])

  // A turn ending is the moment the working tree can have changed; the mount
  // pass (status is already `idle`) doubles as the initial read.
  useEffect(() => {
    if (turnStatus === 'idle') void refresh()
  }, [turnStatus, refresh])

  const toggleDiff = async (path: string): Promise<void> => {
    if (openRef.current === path) {
      openRef.current = null
      setOpenPath(null)
      return
    }
    openRef.current = path
    setOpenPath(path)
    setDiff(null)
    try {
      const result = await call('scm.diff', { cwd, path })
      if (openRef.current === path) setDiff({ path, text: result.diff, binary: result.binary })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const discard = async (path: string): Promise<void> => {
    setConfirmPath(null)
    try {
      await call('scm.discard', { cwd, path })
      if (openRef.current === path) {
        openRef.current = null
        setOpenPath(null)
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className={panelStyles.section}>
      <div className={styles.titleRow}>
        <span className={styles.title}>源代码管理</span>
        {status?.kind === 'git' && status.branch && <span className={styles.branch}>{status.branch}</span>}
        <span className={panelStyles.spacer} />
        <button className={panelStyles.iconButton} onClick={() => void refresh()} type="button" title="刷新">
          <RefreshIcon size={14} />
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {!status ? (
        <div className={panelStyles.empty}>读取中…</div>
      ) : status.kind === 'none' ? (
        <div className={panelStyles.empty}>当前目录不是 git 仓库</div>
      ) : status.files.length === 0 ? (
        <div className={panelStyles.empty}>工作区没有改动</div>
      ) : (
        status.files.map((file) => (
          <div key={file.path}>
            <div
              className={styles.fileRow}
              // A confirm left behind by a moved-away pointer would fire on a
              // later stray click, so it only survives while hovered.
              onMouseLeave={() => {
                if (confirmPath === file.path) setConfirmPath(null)
              }}
            >
              <button
                className={styles.fileMain}
                onClick={() => void toggleDiff(file.path)}
                type="button"
                title={file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              >
                <span className={styles.fileName}>{basename(file.path)}</span>
                <span className={styles.fileDir}>{dirname(file.path)}</span>
              </button>
              <button
                className={confirmPath === file.path ? styles.discardConfirm : styles.discard}
                onClick={() => (confirmPath === file.path ? void discard(file.path) : setConfirmPath(file.path))}
                type="button"
                title={file.status === 'untracked' ? '删除此文件' : '放弃改动，恢复到 HEAD'}
              >
                {confirmPath === file.path ? '确认放弃?' : <UndoIcon size={13} />}
              </button>
              <span className={`${styles.badge} ${styles[file.status]}`}>{STATUS_LETTER[file.status]}</span>
            </div>

            {openPath === file.path && <DiffView diff={diff?.path === file.path ? diff : null} />}
          </div>
        ))
      )}
    </div>
  )
}

function DiffView({ diff }: { diff: { text: string; binary: boolean } | null }): JSX.Element {
  const lines = diff && !diff.binary ? parseDiff(diff.text) : []
  return (
    <div className={styles.diffBox}>
      {!diff ? (
        <div className={styles.diffEmpty}>加载 diff…</div>
      ) : diff.binary ? (
        <div className={styles.diffEmpty}>二进制文件，无法显示差异</div>
      ) : lines.length === 0 ? (
        <div className={styles.diffEmpty}>无差异</div>
      ) : (
        lines.map((line, index) => (
          <div key={index} className={`${styles.diffLine} ${LINE_CLASS[line.kind]}`}>
            {line.text || ' '}
          </div>
        ))
      )}
    </div>
  )
}

const LINE_CLASS: Record<DiffLine['kind'], string> = {
  add: styles.diffAdd,
  remove: styles.diffRemove,
  hunk: styles.diffHunk,
  context: '',
}

type DiffLine = { kind: 'add' | 'remove' | 'hunk' | 'context'; text: string }

/** git's per-file header repeats what the row above already says — drop it. */
const DIFF_NOISE =
  /^(diff --git |index |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to|--- |\+\+\+ |\\ No newline)/

function parseDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = []
  for (const raw of text.replace(/\n$/, '').split('\n')) {
    if (DIFF_NOISE.test(raw)) continue
    if (raw.startsWith('@@')) lines.push({ kind: 'hunk', text: raw })
    else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw })
    else if (raw.startsWith('-')) lines.push({ kind: 'remove', text: raw })
    else lines.push({ kind: 'context', text: raw })
  }
  return lines
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}
