import { useEffect, useState } from 'react'

import type { TurnStats } from '../../store/session.ts'
import styles from './Composer.module.css'

/**
 * The CLI's "Warping… (31s · ↓ 783 tokens)" line, webui edition: elapsed time
 * off the local clock, output tokens off the main thread's streaming usage.
 */
export function TurnStatus({ stats }: { stats: TurnStats }): JSX.Element {
  // The elapsed seconds only move if something re-renders this component.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const elapsed = Math.max(0, Math.floor((Date.now() - stats.startedAt) / 1000))
  const tokens = stats.doneTokens + stats.currentTokens
  return (
    <div className={styles.turnStatus}>
      <span className={styles.turnSpinner} aria-hidden />
      <span>
        运行中… ({formatElapsed(elapsed)}
        {tokens > 0 ? ` · ↓ ${formatTokens(tokens)} tokens` : ''})
      </span>
    </div>
  )
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}k`
}
