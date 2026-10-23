import { useEffect, useState } from 'react'

import { useActiveSessionValue } from '../../store/session.ts'
import { BrandMark } from '../Icons.tsx'
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
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const tokens = doneTokens + currentTokens
  return (
    <div className={styles.turnStatus}>
      <span className={styles.turnSpinner} aria-hidden>
        <BrandMark size={12} />
      </span>
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
