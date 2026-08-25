import type { ModelInfo } from '@ccw/shared'
import { useEffect, useRef } from 'react'

import styles from './Composer.module.css'

/** Resolves the session's model string against the SDK's model rows. */
export function findModel(models: ModelInfo[], model: string | null): ModelInfo | undefined {
  return models.find((row) => row.value === model || row.resolvedModel === model)
}

/**
 * A channel can point two aliases at the same underlying model, which leaves
 * the SDK reporting one `displayName` twice — appending the alias keeps the
 * rows tellable apart.
 */
export function modelLabel(model: ModelInfo, all: ModelInfo[]): string {
  const ambiguous = all.filter((other) => other.displayName === model.displayName).length > 1
  return ambiguous ? `${model.displayName}（${model.value}）` : model.displayName
}

/**
 * VS Code's "Select a model" popup: bold name, grey description underneath,
 * ✓ on the row the session is currently on. Selection state lives in the
 * caller so the composer's textarea keeps handling the arrow keys.
 */
export function ModelPicker(props: {
  models: ModelInfo[]
  current: string | null
  activeIndex: number
  rootRef?: React.Ref<HTMLDivElement>
  onSelect: (model: ModelInfo) => void
  onHover: (index: number) => void
}): JSX.Element {
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [props.activeIndex])

  const current = findModel(props.models, props.current)

  return (
    <div ref={props.rootRef} className={`${styles.popover} ${styles.menuPopover}`} role="listbox" aria-label="选择模型">
      <div className={styles.pickerHeader}>选择模型</div>
      {props.models.map((model, index) => (
        <button
          key={model.value}
          ref={index === props.activeIndex ? activeRef : null}
          className={`${styles.modelRow} ${index === props.activeIndex ? styles.menuItemActive : ''}`}
          // Mousedown, not click: click fires after the textarea's blur.
          onMouseDown={(event) => {
            event.preventDefault()
            props.onSelect(model)
          }}
          onMouseEnter={() => props.onHover(index)}
          type="button"
          role="option"
          aria-selected={model === current}
        >
          <span className={styles.modelText}>
            <span className={styles.modelName}>{modelLabel(model, props.models)}</span>
            {model.description && <span className={styles.modelDesc}>{model.description}</span>}
          </span>
          {model === current && <span className={styles.modeCheck}>✓</span>}
        </button>
      ))}
    </div>
  )
}
