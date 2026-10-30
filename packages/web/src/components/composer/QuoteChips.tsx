import { useEffect, useState } from 'react'

import dialog from '../auth/Auth.module.css'
import { XIcon } from '../Icons.tsx'
import styles from './Composer.module.css'

/** The passages a reply answers, as cards over the input; a card opens to the whole passage. */
export function QuoteChips({
  quotes,
  onRemove,
}: {
  quotes: string[]
  onRemove: (index: number) => void
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className={styles.quotes}>
      {quotes.map((quote, index) => (
        <div key={quote} className={styles.quote}>
          <button className={styles.quoteOpen} onClick={() => setOpen(quote)} type="button" title="查看引用全文">
            <span className={styles.quoteText}>{quote}</span>
          </button>
          <button className={styles.quoteRemove} onClick={() => onRemove(index)} type="button" aria-label="移除引用">
            <XIcon size={12} />
          </button>
        </div>
      ))}
      {open !== null && <QuoteDialog quote={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function QuoteDialog({ quote, onClose }: { quote: string; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={dialog.backdrop} onMouseDown={onClose}>
      <div className={dialog.dialog} onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="引用">
        <div className={dialog.dialogHead}>
          <span className={dialog.dialogTitle}>引用</span>
          <span className={dialog.spacer} />
          <button className={dialog.close} onClick={onClose} type="button" aria-label="关闭">
            <XIcon />
          </button>
        </div>
        <blockquote className={styles.quoteFull}>{quote}</blockquote>
      </div>
    </div>
  )
}
