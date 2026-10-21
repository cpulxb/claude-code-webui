import type { FilePreview, SessionStatus } from '@ccw/shared'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { call } from '../../api/client.ts'
import { AssistantMarkdown } from '../chat/AssistantMarkdown.tsx'
import { CheckIcon, RefreshIcon } from '../Icons.tsx'
import { CodeEditor } from './CodeEditor.tsx'
import panelStyles from './DetailsPanel.module.css'
import styles from './FileView.module.css'

/**
 * Unsaved buffers, keyed by absolute path, kept outside React so closing a tab
 * or switching sessions unmounts the view without dropping the edits: reopening
 * the same file restores them. `base` travels with the text — it is the on-disk
 * content the buffer was typed on, so a restored buffer is compared against the
 * version it was written against instead of silently overwriting whatever the
 * file holds now. Cleared as soon as the buffer stops being dirty (saved,
 * discarded, or typed back to the on-disk text).
 */
const drafts = new Map<string, { text: string; base: string }>()

/**
 * One editor tab in the details panel, dsh-style: text opens straight into a
 * live CodeMirror editor, typing lights the dirty dot, and ✓ or Ctrl+S writes
 * the whole file back via `files.write`. Markdown gets a rendered preview
 * (sharing the chat's renderer) with a preview/edit switch in the head.
 */
export function FileView({
  path,
  turnStatus,
  fsVersion,
  onSaved,
}: {
  path: string
  turnStatus: SessionStatus
  /** Bumped by the store after a rewind or save — the file changed without a turn. */
  fsVersion: number
  onSaved: () => void
}): JSX.Element {
  const [data, setData] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Null while the doc matches disk; the unsaved buffer otherwise. */
  const [draft, setDraft] = useState<string | null>(() => drafts.get(path)?.text ?? null)
  const [saving, setSaving] = useState(false)
  const [mdMode, setMdMode] = useState<'preview' | 'edit'>('preview')
  /** Set when disk moved under an unsaved buffer — saving then loses the newer file. */
  const [stale, setStale] = useState(false)
  /** Transient line under the editor for actions that would otherwise be silent. */
  const [hint, setHint] = useState<string | null>(null)

  const markdown = /\.(md|markdown)$/i.test(path)

  /**
   * The on-disk text `draft` was typed on. Set with the draft and cleared with
   * it, and it is what every staleness check compares a fresh read against —
   * including the read on mount, so a buffer restored from `drafts` is measured
   * against its own baseline rather than against the file as it is now.
   */
  const baseRef = useRef<string | null>(drafts.get(path)?.base ?? null)

  useEffect(() => {
    const base = baseRef.current
    // No entry without both halves: a buffer with no baseline could not be
    // checked for conflicts on the next mount, so it is dropped instead.
    if (draft === null || base === null) drafts.delete(path)
    else drafts.set(path, { text: draft, base })
  }, [path, draft])

  // Reads race: the mount effect, manual refresh, save and the turn-end check
  // can all be in flight at once. Every read takes a ticket and only the newest
  // one is allowed to touch state, so a slow older response cannot win.
  const readSeq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const seq = ++readSeq.current
    try {
      const result = await call('files.read', { path })
      if (seq !== readSeq.current) return
      // `base` is set only while a buffer is dirty — a draft restored from
      // `drafts` on mount, or the text `save()` just wrote. Flag the mismatch
      // instead of letting the next Ctrl+S put that buffer over what changed on
      // disk meanwhile; only text is comparable, so a file that stopped being
      // text counts as changed.
      const base = baseRef.current
      const changed = base !== null && (result.preview.kind !== 'text' || result.preview.content !== base)
      // Every winning read must finish the initial load, including a turn-end
      // check that overtakes it during StrictMode's effect replay. Once loaded,
      // keep the editor's baseline visible while an unsaved buffer conflicts.
      setData((current) => (changed && current !== null ? current : result.preview))
      setStale(changed)
      setHint(null)
      setError(null)
    } catch (cause) {
      if (seq !== readSeq.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [path])

  useEffect(() => {
    void load()
  }, [load])

  const mounted = useRef(false)
  /** fsVersion our own `save()` is about to produce — that bump needs no re-read. */
  const selfSaveVersion = useRef<number | null>(null)

  // Tab switches only hide this view, so without re-reading on turn end the
  // buffer would keep a stale baseline and a later save would write that
  // baseline back over whatever the turn just changed.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    // `save()` already re-read the file, so skip the second `files.read` its
    // own fsVersion bump would cost. Matched by version instead of a flag: a
    // bump that arrives mid-turn is consumed by the run it belongs to, leaving
    // the turn-end run below free to do its comparison.
    if (selfSaveVersion.current === fsVersion) {
      selfSaveVersion.current = null
      return
    }
    if (turnStatus === 'idle') void load()
  }, [turnStatus, fsVersion, load])

  // Editing a truncated preview would write its first 256KB back over the
  // whole file — size is the one thing that disqualifies a text file here.
  const editable = data?.kind === 'text' && !data.truncated

  /** Resolves to whether the write landed — callers restore state when it did not. */
  const save = async (): Promise<boolean> => {
    if (draft === null || saving) return false
    setSaving(true)
    try {
      await call('files.write', { path, content: draft })
      // Disk now holds the buffer, so that is the baseline the re-read below
      // measures against — the old one would flag our own write as a conflict.
      baseRef.current = draft
      // Re-read before clearing the dirty flag: the value-sync re-arms
      // against `data.content`, and doing this first makes that exactly the
      // text just written — no rollback flash between the two renders.
      await load()
      setDraft(null)
      baseRef.current = null
      // `onSaved` bumps fsVersion by one, which names the effect run to skip.
      // If something else bumps first the guard just misses and the extra read
      // is harmless.
      selfSaveVersion.current = fsVersion + 1
      onSaved()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setSaving(false)
    }
  }

  const discardDraft = (): void => {
    baseRef.current = null
    setDraft(null)
    setHint(null)
    // While stale the visible text can be older than disk, and the read is
    // also what clears the warning.
    if (stale) void load()
  }

  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      // Swallow it even when clean — the browser's save dialog never helps here.
      event.preventDefault()
      if (stale) setHint('文件已在磁盘上变化，未保存：先重新读取，或点“仍然覆盖保存”')
      // `data` guards the same window as the save button: a buffer restored
      // from `drafts` has not been compared with disk yet.
      else if (data) void save()
    } else if (event.key === 'Escape' && draft !== null) {
      event.preventDefault()
      discardDraft()
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        {/* dsh-style breadcrumb: the directory greys out and gives way first,
            so a long path loses its head and the file name stays readable. */}
        <span className={styles.path} title={path}>
          {/* The rtl ellipsis trick flips edge punctuation ("/root/…" shows a
              trailing slash); LRM marks pin both ends back to LTR. */}
          <span className={styles.dir}>{`\u200E${dirname(path)}\u200E`}</span>
          <span className={styles.name}>{basename(path)}</span>
        </span>
        {markdown && data?.kind === 'text' && (
          <div className={styles.modeSwitch}>
            <button
              className={mdMode === 'preview' ? styles.modeButtonActive : styles.modeButton}
              onClick={() => setMdMode('preview')}
              type="button"
            >
              预览
            </button>
            <button
              className={mdMode === 'edit' ? styles.modeButtonActive : styles.modeButton}
              onClick={() => setMdMode('edit')}
              type="button"
            >
              编辑
            </button>
          </div>
        )}
        {draft !== null && (
          <>
            <span className={styles.dirtyDot} title="有未保存的修改" />
            <button
              className={panelStyles.iconButton}
              onClick={() => void save()}
              // `!data` is the window where a buffer restored from `drafts` has
              // not been compared with disk yet — writing then is the silent
              // overwrite the baseline check exists to prevent.
              disabled={saving || stale || !data}
              type="button"
              title="保存 (Ctrl+S)"
            >
              <CheckIcon size={14} />
            </button>
          </>
        )}
        <button
          className={panelStyles.iconButton}
          onClick={() => void load()}
          disabled={draft !== null}
          type="button"
          title="重新读取"
        >
          <RefreshIcon size={13} />
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {stale && (
        <div className={styles.stale}>
          <span>文件已在磁盘上变化，你的修改基于旧内容</span>
          <button className={styles.staleAction} onClick={discardDraft} type="button">
            重新读取
          </button>
          <button
            className={styles.staleAction}
            onClick={() => {
              setStale(false)
              setHint(null)
              // A failed write leaves the old baseline in place, so the warning
              // (and the disabled save button) has to come back with it.
              void save().then((ok) => {
                if (!ok) setStale(true)
              })
            }}
            disabled={saving}
            type="button"
          >
            仍然覆盖保存
          </button>
        </div>
      )}

      {/* The keydown listener lives on the shared frame so it covers the
          markdown edit view too; only the editor can actually focus inside. */}
      <div className={styles.content} onKeyDown={onEditorKeyDown}>
        {!data ? (
          <div className={styles.placeholder}>读取中…</div>
        ) : data.kind === 'binary' ? (
          <div className={styles.placeholder}>二进制文件，无法预览</div>
        ) : data.kind === 'image' ? (
          <div className={styles.imageFrame}>
            <img className={styles.image} src={`data:${data.mediaType};base64,${data.data}`} alt={path} />
          </div>
        ) : markdown && mdMode === 'preview' ? (
          // The preview renders the unsaved buffer too, so edits show up
          // without a save round-trip.
          <div className={styles.mdPreview}>
            <AssistantMarkdown text={draft ?? data.content} />
          </div>
        ) : (
          <CodeEditor
            path={path}
            value={draft ?? data.content}
            readOnly={!editable}
            dirty={draft !== null}
            onChange={(text) => {
              if (text === data.content) {
                // Back to the text on screen: clean again, baseline included.
                baseRef.current = null
                setDraft(null)
              } else {
                // First keystroke on a clean buffer pins the baseline; later
                // ones keep it, so a conflict stays visible until it is resolved.
                baseRef.current ??= data.content
                setDraft(text)
              }
            }}
          />
        )}
      </div>

      {data?.kind === 'text' && data.truncated && (
        <div className={styles.note}>文件过大，仅显示前 256 KB，编辑已禁用（共 {formatSize(data.size)}）</div>
      )}
      {hint && <div className={styles.note}>{hint}</div>}
      {draft !== null && (!markdown || mdMode === 'edit') && (
        <div className={styles.note}>Ctrl+S 保存 · Esc 放弃修改</div>
      )}
    </div>
  )
}

/** Keeps the trailing slash, so the breadcrumb reads straight into the name. */
function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
