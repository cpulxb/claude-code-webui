import { useEffect, useRef } from 'react'

import { FileIcon, FolderIcon } from '../Icons.tsx'
import styles from './Composer.module.css'

export type MenuItem = {
  key: string
  name: string
  /** Right-aligned argument hint, e.g. `<file>`. */
  hint?: string
  description?: string
  /** Set on file rows — renders VS Code's folder/document glyph. */
  isDirectory?: boolean
}

/** Candidate list for the `@` trigger. Selection lives in the caller. */
export function TriggerMenu(props: {
  items: MenuItem[]
  activeIndex: number
  emptyText: string
  onSelect: (item: MenuItem) => void
  onHover: (index: number) => void
}): JSX.Element {
  const activeRef = useRef<HTMLButtonElement>(null)

  // Keyboard navigation must drag the viewport with it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [props.activeIndex])

  if (props.items.length === 0) {
    return (
      <div className={`${styles.popover} ${styles.menuPopover}`}>
        <div className={styles.menuEmpty}>{props.emptyText}</div>
      </div>
    )
  }

  return (
    <div className={`${styles.popover} ${styles.menuPopover}`} role="listbox">
      {props.items.map((item, index) => (
        <button
          key={item.key}
          ref={index === props.activeIndex ? activeRef : null}
          className={`${styles.menuItem} ${index === props.activeIndex ? styles.menuItemActive : ''}`}
          // Mousedown, not click: click fires after blur, which would close
          // the menu before the selection is read.
          onMouseDown={(event) => {
            event.preventDefault()
            props.onSelect(item)
          }}
          onMouseEnter={() => props.onHover(index)}
          type="button"
          role="option"
          aria-selected={index === props.activeIndex}
        >
          {item.isDirectory !== undefined && (
            <span className={styles.menuIcon}>{item.isDirectory ? <FolderIcon size={13} /> : <FileIcon size={13} />}</span>
          )}
          <span className={styles.menuName}>{item.name}</span>
          {item.hint && <span className={styles.menuHint}>{item.hint}</span>}
          {item.description && <span className={styles.menuDesc}>{item.description}</span>}
        </button>
      ))}
    </div>
  )
}
