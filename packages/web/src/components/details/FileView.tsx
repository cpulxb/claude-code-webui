import type { FilePreview } from '@ccw/shared'
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'

import { call } from '../../api/client.ts'
import { AssistantMarkdown } from '../chat/AssistantMarkdown.tsx'
import { CheckIcon, RefreshIcon } from '../Icons.tsx'
import { CodeEditor } from './CodeEditor.tsx'
import panelStyles from './DetailsPanel.module.css'
import styles from './FileView.module.css'

/**
 * One editor tab in the details panel, dsh-style: text opens straight into a
 * live CodeMirror editor, typing lights the dirty dot, and ✓ or Ctrl+S writes
 * the whole file back via `files.write`. Markdown gets a rendered preview
 * (sharing the chat's renderer) with a preview/edit switch in the head.
 */
export function FileView({ path, onSaved }: { path: string; onSaved: () => void }): JSX.Element {
  const [data, setData] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Null while the doc matches disk; the unsaved buffer otherwise. */
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [mdMode, setMdMode] = useState<'preview' | 'edit'>('preview')

  const markdown = /\.(md|markdown)$/i.test(path)

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await call('files.read', { path })
      setData(result.preview)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [path])

  useEffect(() => {
    void load()
  }, [load])

  // Editing a truncated preview would write its first 256KB back over the
  // whole file — size is the one thing that disqualifies a text file here.
  const editable = data?.kind === 'text' && !data.truncated

  const save = async (): Promise<void> => {
    if (draft === null || saving) return
    setSaving(true)
    try {
      await call('files.write', { path, content: draft })
      // Re-read before clearing the dirty flag: the value-sync re-arms
      // against `data.content`, and doing this first makes that exactly the
      // text just written — no rollback flash between the two renders.
      await load()
      setDraft(null)
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      // Swallow it even when clean — the browser's save dialog never helps here.
      event.preventDefault()
      void save()
    } else if (event.key === 'Escape' && draft !== null) {
      event.preventDefault()
      setDraft(null)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.pathBox} title={path}>
          {/* The rtl ellipsis trick flips edge punctuation ("/root/…" shows a
              trailing slash); LRM marks pin both ends back to LTR. */}
          {`\u200E${path}\u200E`}
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
        {draft !== null && <span className={styles.dirtyDot} title="有未保存的修改" />}
        <button
          className={panelStyles.iconButton}
          onClick={() => void save()}
          disabled={draft === null || saving}
          type="button"
          title="保存 (Ctrl+S)"
        >
          <CheckIcon size={14} />
        </button>
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

      {/* The keydown listener lives on the shared frame so it covers the
          markdown edit view too; only the editor can actually focus inside. */}
      <div className={styles.content} onKeyDown={onEditorKeyDown}>
        {!data ? (
          <div className={styles.placeholder}>读取中…</div>
        ) : data.kind === 'binary' ? (
          <div className={styles.placeholder}>二进制文件，无法预览</div>
        ) : data.kind === 'image' ? (
          <img className={styles.image} src={`data:${data.mediaType};base64,${data.data}`} alt={path} />
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
            onChange={(text) => setDraft(text === data.content ? null : text)}
          />
        )}
      </div>

      {data?.kind === 'text' && data.truncated && (
        <div className={styles.note}>文件过大，仅显示前 256 KB，编辑已禁用（共 {formatSize(data.size)}）</div>
      )}
      {draft !== null && (!markdown || mdMode === 'edit') && (
        <div className={styles.note}>Ctrl+S 保存 · Esc 放弃修改</div>
      )}
    </div>
  )
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
