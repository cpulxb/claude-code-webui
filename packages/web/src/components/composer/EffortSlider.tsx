import { EFFORT_LEVELS, type EffortLevel, type ModelInfo } from '@ccw/shared'
import { useRef } from 'react'

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

/**
 * VS Code's rheostat-style effort control: one dot per stop, a draggable knob
 * on the current one. Pointer capture keeps a drag alive after the cursor
 * leaves the track, and preventDefault on pointerdown keeps focus on the
 * composer textarea so the popover the slider lives in does not blur-close
 * mid-drag.
 */
export function EffortSlider(props: {
  levels: readonly EffortLevel[]
  value: EffortLevel
  onChange: (level: EffortLevel) => void
}): JSX.Element {
  const railRef = useRef<HTMLDivElement>(null)
  const index = Math.max(0, props.levels.indexOf(props.value))
  const span = Math.max(1, props.levels.length - 1)

  const pick = (clientX: number): void => {
    const rect = railRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const level = props.levels[Math.round(ratio * span)]
    if (level && level !== props.value) props.onChange(level)
  }

  const step = (delta: number): void => {
    const level = props.levels[Math.min(span, Math.max(0, index + delta))]
    if (level && level !== props.value) props.onChange(level)
  }

  return (
    <div
      className={styles.effortSlider}
      role="slider"
      tabIndex={0}
      aria-label="思考强度"
      aria-valuemin={0}
      aria-valuemax={span}
      aria-valuenow={index}
      aria-valuetext={EFFORT_LABEL[props.value]}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        pick(event.clientX)
      }}
      onPointerMove={(event) => {
        if ((event.buttons & 1) === 1) pick(event.clientX)
      }}
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
      <div ref={railRef} className={styles.effortRail}>
        {props.levels.map((level, i) => (
          <span
            key={level}
            className={`${styles.effortDot} ${level === 'max' ? styles.effortDotMax : ''}`}
            style={{ left: `${(i / span) * 100}%` }}
          />
        ))}
        <span
          className={`${styles.effortKnob} ${props.value === 'max' ? styles.effortKnobMax : ''}`}
          style={{ left: `${(index / span) * 100}%` }}
        />
      </div>
    </div>
  )
}
