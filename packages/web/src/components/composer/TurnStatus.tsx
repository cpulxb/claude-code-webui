import { useEffect, useState } from 'react'

import { useActiveSessionValue } from '../../store/session.ts'
import { formatElapsed, formatTokens, turnStatusText } from '../../utils/turn-status.ts'
import { BrandMark, RefreshIcon } from '../Icons.tsx'
import styles from './Composer.module.css'

/**
 * The CLI's "Warping… (31s · ↓ 783 tokens)" line, webui edition: elapsed time
 * off the local clock, output tokens off the main thread's streaming usage.
 *
 * `turnStats` is subscribed here rather than passed down, because it changes on
 * every streamed token — reading it in the composer would re-render the palette,
 * the model picker and the effort slider along with it.
 */
export function TurnStatus(): JSX.Element | null {
  const progress = useActiveSessionValue((session) => session.turnProgress)
  const waiting = useActiveSessionValue((session) => session.pendingPermissions.length > 0) ?? false
  const startedAt = useActiveSessionValue((session) => session.turnStats?.startedAt)
  const doneTokens = useActiveSessionValue((session) => session.turnStats?.doneTokens) ?? 0
  const currentTokens = useActiveSessionValue((session) => session.turnStats?.currentTokens) ?? 0

  // The elapsed seconds only move if something re-renders this component.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  if (startedAt === undefined) return null
  const now = Date.now()
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  const tokens = doneTokens + currentTokens
  const status = turnStatusText(progress ?? null, now, waiting)
  return (
    <div className={`${styles.turnStatus} ${status.warning ? styles.turnStatusWarning : ''}`}>
      <span className={`${styles.turnSpinner} ${status.warning ? styles.turnSpinnerWarning : ''}`} aria-hidden>
        {progress?.retry ? <RefreshIcon size={12} /> : <BrandMark size={12} />}
      </span>
      <div className={styles.turnStatusBody}>
        <span className={styles.turnStatusLabel} role="status" aria-live="polite">
          {status.label}
        </span>
        <span className={styles.turnStatusStats}>
          （已用时 {formatElapsed(elapsed)}{tokens > 0 ? ` · ↓ ${formatTokens(tokens)} tokens` : ''}）
        </span>
        {status.detail && <span className={styles.turnStatusDetail}>{status.detail}</span>}
      </div>
    </div>
  )
}
