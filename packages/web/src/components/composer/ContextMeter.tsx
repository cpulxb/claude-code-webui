import type { ContextUsage } from '@ccw/shared'
import { useEffect, useRef, useState } from 'react'

import styles from './ContextMeter.module.css'

/** Ring geometry: 14px viewBox, 2px stroke — dsh's ContextMeter proportions. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Context-occupancy ring beside the send button, with a click-open breakdown.
 *
 * Unlike dsh, no heuristic composition is needed: the CLI's `getContextUsage`
 * already returns the authoritative `/context` categories, so the panel shows
 * exactly what the terminal command shows. Renders nothing until the first
 * turn completes and a reading exists.
 */
export function ContextMeter({ usage }: { usage: ContextUsage | null }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  // Outside click / Escape close, one document listener while open — the same
  // pattern the modes popover uses.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!usage) return null
  const percent = Math.min(100, Math.max(0, usage.percentage))
  const label = `上下文已用 ${percent}%`

  // "Free space" is the remainder, not an occupant — the ring and the bar
  // already express it as the unfilled part.
  const used = usage.categories.filter((category) => category.tokens > 0 && !/free/i.test(category.name))
  const usedTotal = used.reduce((sum, category) => sum + category.tokens, 0)

  return (
    <span ref={rootRef} className={styles.root}>
      <button
        className={styles.trigger}
        onClick={() => setOpen(!open)}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
          <circle className={styles.track} cx="7" cy="7" r={RADIUS} />
          <circle
            className={styles.fill}
            cx="7"
            cy="7"
            r={RADIUS}
            strokeDasharray={`${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="上下文用量">
          <div className={styles.header}>
            <span className={styles.headline}>上下文已用</span>
            <span className={styles.percent}>{percent}%</span>
            <span className={styles.figures}>
              ~{tokens(usage.totalTokens)} / {tokens(usage.rawMaxTokens)}
            </span>
          </div>

          <div className={styles.bar}>
            {used.map((category) => (
              <div
                key={category.name}
                className={styles.segment}
                style={{
                  width: `${(percent * category.tokens) / (usedTotal || 1)}%`,
                  background: categoryColor(category.color),
                }}
              />
            ))}
          </div>

          <dl className={styles.rows}>
            {used.map((category) => (
              <div key={category.name} className={styles.row}>
                <dt>
                  <span className={styles.swatch} style={{ background: categoryColor(category.color) }} aria-hidden />
                  {category.name}
                </dt>
                <dd>~{tokens(category.tokens)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </span>
  )
}

/**
 * The CLI colours categories with theme names rather than CSS values — the
 * same mapping the details panel's `/context` grid uses. An unrecognised name
 * is a new theme slot, not an error.
 */
const CATEGORY_COLORS: Record<string, string> = {
  claude: 'var(--ccw-accent)',
  permission: 'var(--ccw-accent)',
  planMode: 'var(--ccw-accent)',
  autoAccept: 'var(--ccw-success)',
  success: 'var(--ccw-success)',
  warning: 'var(--ccw-warning)',
  error: 'var(--ccw-danger)',
  text: 'var(--ccw-text-primary)',
  secondaryText: 'var(--ccw-text-secondary)',
  promptBorder: 'var(--ccw-border-l2)',
  inactive: 'var(--ccw-text-faint)',
  // The terminal renders the Messages row purple; there is no theme slot for
  // it, so the hue is pinned here.
  purple_FOR_SUBAGENTS_ONLY: '#a78bfa',
}

function categoryColor(name: string): string {
  return CATEGORY_COLORS[name] ?? 'var(--ccw-text-faint)'
}

function tokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}
