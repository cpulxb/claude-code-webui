import { useEffect } from 'react'

import dialog from './auth/Auth.module.css'
import styles from './ConfirmDialog.module.css'

/**
 * The app's own `window.confirm`, whose box the browser draws in its own
 * style under the page's host name. Escape, the backdrop and the cancel
 * button all back out. Escape is caught on its way down and stopped there,
 * so a dialog underneath that closes on Escape stays open.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = '取消',
  danger = false,
  busy = false,
  error = null,
  alternative,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  /** A destructive answer: drawn in red, and Enter lands on cancel instead. */
  danger?: boolean
  /** Holds the answers while the confirmed action is in flight. */
  busy?: boolean
  error?: string | null
  /** A third answer, set apart on the left — 不保存 beside 取消 and 保存. */
  alternative?: { label: string; onClick: () => void }
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return (
    <div
      className={dialog.backdrop}
      // Stopped as well, or the backdrop of a dialog underneath would take it.
      onMouseDown={(event) => {
        event.stopPropagation()
        onCancel()
      }}
    >
      <div
        className={`${dialog.dialog} ${styles.dialog}`}
        onMouseDown={(event) => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={dialog.dialogTitle}>{title}</div>
        <div className={dialog.muted}>{message}</div>
        {error && <div className={dialog.error}>{error}</div>}
        <div className={styles.actions}>
          {alternative && (
            <>
              <button className={dialog.button} onClick={alternative.onClick} disabled={busy} type="button">
                {alternative.label}
              </button>
              <span className={dialog.spacer} />
            </>
          )}
          <button className={dialog.button} onClick={onCancel} type="button" autoFocus={danger}>
            {cancelLabel}
          </button>
          <button
            className={`${dialog.button} ${danger ? styles.danger : dialog.primary}`}
            onClick={onConfirm}
            disabled={busy}
            type="button"
            autoFocus={!danger}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
