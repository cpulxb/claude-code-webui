import type { FilePreview } from '@ccw/shared'
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'

import { call } from '../../api/client.ts'
import { RefreshIcon } from '../Icons.tsx'
import panelStyles from './DetailsPanel.module.css'
import styles from './FileView.module.css'

/**
 * One editor tab in the details panel. Renders the bounded `files.read`
 * preview; double-clicking an untruncated text file swaps the view for a
 * textarea whose save writes the whole file back through `files.write`.
 */
export function FileView({ path, onSaved }: { path: string; onSaved: () => void }): JSX.Element {
  const [data, setData] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Null while viewing; the in-progress buffer while editing. */
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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
      setDraft(null)
      await load()
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault()
      void save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(null)
    }
  }

  return (
    <div>
      <div className={styles.head}>
        <span className={styles.path} title={path}>
          {/* The rtl ellipsis trick flips edge punctuation ("/root/…" shows a
              trailing slash); LRM marks pin both ends back to LTR. */}
          {`\u200E${path}\u200E`}
        </span>
        {data && <span className={styles.size}>{formatSize(data.size)}</span>}
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

      {!data ? (
        <div className={styles.placeholder}>读取中…</div>
      ) : data.kind === 'binary' ? (
        <div className={styles.placeholder}>二进制文件，无法预览</div>
      ) : data.kind === 'image' ? (
        <img className={styles.image} src={`data:${data.mediaType};base64,${data.data}`} alt={path} />
      ) : draft === null ? (
        <pre
          className={styles.viewText}
          onDoubleClick={() => {
            if (editable) setDraft(data.content)
          }}
          title={editable ? '双击编辑' : undefined}
        >
          {data.content}
        </pre>
      ) : (
        <>
          <textarea
            className={styles.editor}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onEditorKeyDown}
            spellCheck={false}
            autoFocus
          />
          <div className={styles.editBar}>
            <button className={styles.save} onClick={() => void save()} disabled={saving} type="button">
              {saving ? '保存中…' : '保存'}
            </button>
            <button className={styles.cancel} onClick={() => setDraft(null)} disabled={saving} type="button">
              取消
            </button>
            <span className={styles.hint}>Ctrl+S 保存 · Esc 取消</span>
          </div>
        </>
      )}

      {data?.kind === 'text' && data.truncated && (
        <div className={styles.note}>文件过大，仅显示前 256 KB，编辑已禁用（共 {formatSize(data.size)}）</div>
      )}
      {editable && draft === null && <div className={styles.note}>双击内容进入编辑</div>}
    </div>
  )
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
