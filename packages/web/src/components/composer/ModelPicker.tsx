import type { ModelInfo } from '@ccw/shared'
import { useEffect, useRef } from 'react'

import { findModel, modelLabel } from '../../utils/models.ts'
import { CheckIcon } from '../Icons.tsx'
import styles from './Composer.module.css'

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
  /** Opens the settings page, where the menu's rows are configured. */
  onManage: () => void
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
          {model === current && (
            <span className={styles.modeCheck}>
              <CheckIcon size={14} />
            </span>
          )}
        </button>
      ))}
      {/* Mouse only: the arrow keys walk the models, not this row. */}
      <button
        className={`${styles.modelRow} ${styles.pickerManage}`}
        onMouseDown={(event) => {
          event.preventDefault()
          props.onManage()
        }}
        type="button"
        tabIndex={-1}
      >
        管理模型…
      </button>
    </div>
  )
}
