import type { UpstreamModel } from '@ccw/shared'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import { groupModels } from '../../utils/settings.ts'
import { CheckIcon, ChevronsUpDownIcon } from '../Icons.tsx'
import styles from './Settings.module.css'

/**
 * A model id input with a menu of what the channel lists, to pick from instead
 * of typing. The input stays free text: a gateway may serve models it does not
 * list, and the id may carry a suffix the list does not.
 */
export function ModelIdField({
  value,
  onChange,
  models,
  isTaken,
  className,
  invalid,
  placeholder,
  title,
  autoFocus,
}: {
  value: string
  onChange: (id: string) => void
  models: UpstreamModel[]
  /** Whether another row already has this id, so picking it would only repeat that row. */
  isTaken: (id: string) => boolean
  className: string
  invalid: boolean
  placeholder: string
  title: string | undefined
  /** A row just added: it takes the focus as it mounts. */
  autoFocus: boolean
}): JSX.Element {
  // A row added with a list at hand opens its menu at once: 获取 → 添加模型 → pick.
  const [open, setOpen] = useState(autoFocus && models.length > 0)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    // Caught on its way down, so nothing behind closes with the menu.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div ref={root} className={`${styles.idField} ${className}`}>
      <input
        className={`${styles.input} ${invalid ? styles.invalid : ''}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label="模型 ID"
        title={title}
        autoFocus={autoFocus && models.length === 0}
        spellCheck={false}
      />
      {models.length > 0 && (
        <button
          className={styles.iconButton}
          onClick={() => setOpen(!open)}
          type="button"
          title="从获取到的模型里选"
          aria-label="从获取到的模型里选"
          aria-expanded={open}
        >
          <ChevronsUpDownIcon size={14} />
        </button>
      )}
      {open && models.length > 0 && (
        <ModelMenu
          anchor={root}
          menuRef={menu}
          models={models}
          value={value}
          isTaken={isTaken}
          onPick={(id) => {
            onChange(id)
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** Room the menu wants below its field before it opens above instead. */
const MENU_ROOM = 200
const MENU_MARGIN = 8

/**
 * Drawn on the document rather than in the form: the form's pane scrolls and
 * would cut it off, and a long list should reach past the pane's edge.
 */
function ModelMenu({
  anchor,
  menuRef,
  models,
  value,
  isTaken,
  onPick,
}: {
  anchor: RefObject<HTMLElement>
  menuRef: RefObject<HTMLDivElement>
  models: UpstreamModel[]
  value: string
  isTaken: (id: string) => boolean
  onPick: (id: string) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [place, setPlace] = useState<CSSProperties>({})

  // Under the field, or above it when the room below is short; kept there as the pane scrolls or resizes.
  useLayoutEffect(() => {
    const update = (): void => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const below = window.innerHeight - rect.bottom - MENU_MARGIN
      const above = rect.top - MENU_MARGIN
      const up = below < MENU_ROOM && above > below
      const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 2 * MENU_MARGIN)
      setPlace({
        left: Math.max(MENU_MARGIN, Math.min(rect.left, window.innerWidth - width - MENU_MARGIN)),
        width,
        maxHeight: Math.min(320, up ? above : below),
        ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      })
    }
    // A row just added may sit below the fold of the form's pane.
    anchor.current?.scrollIntoView({ block: 'nearest' })
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [anchor])

  const groups = groupModels(models, query)
  const first = groups.flatMap((group) => group.models).find((model) => !isTaken(model.id))

  return createPortal(
    <div ref={menuRef} className={styles.menu} style={place} role="listbox" aria-label="获取到的模型">
      <input
        className={`${styles.input} ${styles.menuFilter}`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          if (first) onPick(first.id)
        }}
        placeholder={`筛选 ${models.length} 个模型`}
        aria-label="筛选模型"
        autoFocus
        spellCheck={false}
      />
      <div className={styles.menuList}>
        {groups.length === 0 && <div className={styles.menuEmpty}>没有匹配的模型</div>}
        {groups.map(({ owner, models: grouped }) => (
          <div key={owner}>
            {owner && <div className={styles.menuGroup}>{owner}</div>}
            {grouped.map(({ id }) => {
              const taken = isTaken(id)
              return (
                <button
                  key={id}
                  className={styles.menuItem}
                  onClick={() => onPick(id)}
                  disabled={taken}
                  type="button"
                  role="option"
                  aria-selected={id === value}
                >
                  <span className={styles.menuId}>{id}</span>
                  {id === value && <CheckIcon size={14} />}
                  {taken && <span className={styles.menuNote}>已在列表里</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}
