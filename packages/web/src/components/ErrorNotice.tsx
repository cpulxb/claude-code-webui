import { Fragment } from 'react'

import styles from './ErrorNotice.module.css'
import { AlertCircleIcon, XIcon } from './Icons.tsx'

/**
 * A path in an error, absolute or under ~, set in mono so it reads as the
 * path it is. Not one inside a URL or a word: `https://host`, `a/b`.
 */
const PATH = /(?<![\w:/.~])(~?\/[^\s，。；、：）)」]+)/

/**
 * An error, read as a notice rather than a line of red text. The app's
 * messages run `what failed：why`, so the part before the colon is the
 * title and the rest explains it; one without a colon is explanation alone.
 */
export function ErrorNotice({ text, compact, onDismiss }: { text: string; compact?: boolean; onDismiss?: () => void }): JSX.Element {
  const at = text.indexOf('：')
  const title = at > 0 && at <= 24 ? text.slice(0, at) : null
  const detail = title ? text.slice(at + 1) : text

  return (
    <div className={compact ? `${styles.notice} ${styles.compact}` : styles.notice} role="alert">
      <span className={styles.icon}>
        <AlertCircleIcon size={compact ? 14 : 16} />
      </span>
      <div className={styles.text}>
        {title && <div className={styles.title}>{title}</div>}
        <div className={styles.detail}>
          {detail.split(PATH).map((part, index) =>
            index % 2 === 1 ? (
              <code key={index} className={styles.path}>
                {part}
              </code>
            ) : (
              <Fragment key={index}>{part}</Fragment>
            ),
          )}
        </div>
      </div>
      {onDismiss && (
        <button className={styles.dismiss} onClick={onDismiss} type="button" title="关闭提示" aria-label="关闭提示">
          <XIcon size={12} />
        </button>
      )}
    </div>
  )
}
