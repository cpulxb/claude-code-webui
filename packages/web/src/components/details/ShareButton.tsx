import type { ShareTtl } from '@ccw/shared'
import { useEffect, useRef, useState } from 'react'

import { call } from '../../api/client.ts'
import { shareHref, TTL_LABELS } from '../../utils/shares.ts'
import { ShareIcon } from '../Icons.tsx'
import panelStyles from './DetailsPanel.module.css'
import styles from './FileView.module.css'

/**
 * The file head's 分享: picks how long the link lives, makes it, and copies
 * it. The link opens without pairing, so the popover says so, and where to
 * take it back.
 */
export function ShareButton({ path }: { path: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [ttl, setTtl] = useState<ShareTtl>('7d')
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setNote('已复制到剪贴板')
    } catch {
      setNote('复制失败，请手动选中链接复制')
    }
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const href = shareHref(await call('shares.create', { path, ttl }))
      setLink(href)
      await copy(href)
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.shareRoot} ref={root}>
      <button
        className={panelStyles.iconButton}
        onClick={() => setOpen(!open)}
        type="button"
        title="分享链接"
        aria-expanded={open}
      >
        <ShareIcon size={13} />
      </button>
      {open && (
        <div className={styles.sharePopover} role="dialog" aria-label="分享文件">
          <div className={styles.shareTitle}>分享这个文件</div>
          <div className={styles.shareTtls} role="radiogroup" aria-label="有效期">
            {(Object.keys(TTL_LABELS) as ShareTtl[]).map((value) => (
              <button
                key={value}
                className={value === ttl ? styles.modeButtonActive : styles.modeButton}
                onClick={() => {
                  setTtl(value)
                  setLink(null)
                }}
                role="radio"
                aria-checked={value === ttl}
                type="button"
              >
                {TTL_LABELS[value]}
              </button>
            ))}
          </div>
          {link ? (
            <div className={styles.shareLink}>
              <input className={styles.shareInput} value={link} readOnly onFocus={(event) => event.target.select()} />
              <button className={styles.shareAction} onClick={() => void copy(link)} type="button">
                复制
              </button>
            </div>
          ) : (
            <button className={styles.shareAction} onClick={() => void create()} disabled={busy} type="button">
              {busy ? '生成中…' : '生成链接'}
            </button>
          )}
          {note && <div className={styles.shareNote}>{note}</div>}
          <div className={styles.shareNote}>拿到链接的人不用配对就能打开这个文件。在「设置 → 分享」里可以随时撤销。</div>
        </div>
      )}
    </div>
  )
}
