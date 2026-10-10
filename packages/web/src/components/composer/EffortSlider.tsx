import { EFFORT_LEVELS, type EffortLevel, type ModelInfo } from '@ccw/shared'
import { useRef, useState } from 'react'

import { findModel } from '../../utils/models.ts'
import styles from './Composer.module.css'

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
}

/**
 * The effort stops the active model accepts. Offering a level the model
 * rejects would just produce an error on the next turn, so the slider follows
 * the model's own list; an unknown model falls back to all five.
 */
export function effortChoices(models: ModelInfo[], model: string | null): readonly EffortLevel[] {
  const selected = findModel(models, model)
  return selected?.supportedEffortLevels ?? (selected && selected.supportsEffort === false ? [] : EFFORT_LEVELS)
}

/** The level after `current`, wrapping — what clicking the row's label does. */
export function nextEffort(levels: readonly EffortLevel[], current: EffortLevel): EffortLevel | undefined {
  if (levels.length === 0) return undefined
  return levels[(levels.indexOf(current) + 1) % levels.length]
}

/**
 * VS Code's effort track: a pill with one notch per stop, a fill up to the
 * thumb, and the thumb itself.
 *
 * What makes it feel smooth is that nothing waits on the CLI. While the
 * pointer is down the thumb and fill follow it continuously, untransitioned,
 * and the level is reported as soon as the nearest stop changes (the store
 * updates optimistically). On release the thumb eases onto that stop. Pointer
 * capture keeps a drag alive outside the track, and preventDefault on
 * pointerdown keeps focus in the composer so the popover does not blur-close.
 */
export function EffortSlider(props: {
  levels: readonly EffortLevel[]
  value: EffortLevel
  onChange: (level: EffortLevel) => void
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  // Several pointermoves can land before the store's new level re-renders us.
  const reported = useRef<EffortLevel | null>(null)
  const count = props.levels.length
  const span = Math.max(1, count - 1)
  const index = Math.max(0, props.levels.indexOf(props.value))
  const ratio = drag ?? index / span

  const ratioAt = (clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    // The thumb's centre travels between the two inset extremes, so map the
    // pointer onto that inner span rather than the whole pill.
    const inner = rect.width - THUMB - 2 * INSET
    return Math.min(1, Math.max(0, (clientX - rect.left - INSET - THUMB / 2) / inner))
  }

  const follow = (clientX: number): void => {
    const next = ratioAt(clientX)
    if (next === null) return
    setDrag(next)
    const level = props.levels[Math.round(next * span)]
    if (level && level !== (reported.current ?? props.value)) {
      reported.current = level
      props.onChange(level)
    }
  }

  const release = (): void => {
    setDrag(null)
    reported.current = null
  }

  const step = (delta: number): void => {
    const level = props.levels[Math.min(span, Math.max(0, index + delta))]
    if (level && level !== props.value) props.onChange(level)
  }

  const at = (r: number): string => `calc(${INSET}px + ${r} * (100% - ${THUMB + 2 * INSET}px))`

  return (
    <div
      ref={trackRef}
      className={`${styles.effortTrack} ${drag !== null ? styles.effortDragging : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="思考强度"
      aria-valuemin={0}
      aria-valuemax={span}
      aria-valuenow={index}
      aria-valuetext={EFFORT_LABEL[props.value]}
      title="点击或拖动以调整思考强度"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        follow(event.clientX)
      }}
      onPointerMove={(event) => {
        if (drag !== null) follow(event.clientX)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          event.preventDefault()
          step(-1)
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault()
          step(1)
        }
      }}
    >
      <span className={styles.effortFill} style={{ width: `calc(${at(ratio)} + ${THUMB + INSET}px)` }} />
      {props.levels.map((level, i) => (
        <span
          key={level}
          className={styles.effortNotch}
          style={{ left: `calc(${at(count > 1 ? i / span : 0)} + ${THUMB / 2}px)` }}
        />
      ))}
      <span className={styles.effortThumb} style={{ left: at(ratio) }} />
    </div>
  )
}

const THUMB = 14
const INSET = 2
