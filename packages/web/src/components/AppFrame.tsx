import { useCallback, useRef, useState, type ReactNode } from 'react'

import styles from './AppFrame.module.css'

const SIDEBAR_RANGE = [180, 480] as const
const DETAILS_RANGE = [240, 1200] as const
/** Dragging a column never squeezes the conversation narrower than this. */
const MAIN_MIN = 360
/** Pulling this far past a column's minimum folds it instead of stopping there. */
const COLLAPSE_PAST_MIN = 40

type Column = 'sidebar' | 'details'

/**
 * The three-column shell: sessions | conversation | details.
 *
 * Widths live on `grid-template-columns` so collapsing can animate the track
 * itself, and the handles are frame children (columns clip their overflow)
 * positioned on the column borders. A maximized details panel takes the
 * conversation's track as well; the sidebar keeps its own.
 *
 * On a phone (`narrow`) the conversation keeps the whole width and both
 * panels slide over it as drawers, so none of the widths above apply.
 */
export function AppFrame(props: {
  sidebar: ReactNode
  main: ReactNode
  details: ReactNode
  sidebarCollapsed: boolean
  detailsCollapsed: boolean
  detailsMaximized: boolean
  narrow: boolean
  onCollapseSidebar: () => void
  onCollapseDetails: () => void
}): JSX.Element {
  const [sidebarWidth, setSidebarWidth] = useState(264)
  const [detailsWidth, setDetailsWidth] = useState(340)
  const [dragging, setDragging] = useState<Column | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  const startDrag = useCallback(
    (column: Column) => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(column)

      const startX = event.clientX
      const startWidth = column === 'sidebar' ? sidebarWidth : detailsWidth
      const [min, range] = column === 'sidebar' ? SIDEBAR_RANGE : DETAILS_RANGE
      const otherCollapsed = column === 'sidebar' ? props.detailsCollapsed : props.sidebarCollapsed
      const otherWidth = otherCollapsed ? 0 : column === 'sidebar' ? detailsWidth : sidebarWidth
      const room = (frameRef.current?.clientWidth ?? Infinity) - otherWidth - MAIN_MIN
      const max = Math.max(min, Math.min(range, room))
      const collapse = column === 'sidebar' ? props.onCollapseSidebar : props.onCollapseDetails

      const onMove = (moveEvent: PointerEvent): void => {
        // The details column grows leftwards, so its delta is inverted.
        const delta = column === 'sidebar' ? moveEvent.clientX - startX : startX - moveEvent.clientX
        const raw = startWidth + delta
        if (raw < min - COLLAPSE_PAST_MIN) {
          // Folding ends the drag: the collapse animates, and moving back out does not reopen the column.
          collapse()
          setDragging(null)
          window.removeEventListener('pointermove', onMove)
          return
        }
        const next = Math.min(max, Math.max(min, raw))
        if (column === 'sidebar') setSidebarWidth(next)
        else setDetailsWidth(next)
      }
      const onUp = (): void => {
        setDragging(null)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [sidebarWidth, detailsWidth, props.sidebarCollapsed, props.detailsCollapsed, props.onCollapseSidebar, props.onCollapseDetails],
  )

  const left = props.sidebarCollapsed ? 0 : sidebarWidth
  const right = props.detailsCollapsed ? 0 : detailsWidth
  const maximized = props.detailsMaximized && !props.detailsCollapsed

  return (
    <div
      ref={frameRef}
      className={styles.frame}
      style={
        props.narrow
          ? undefined
          : { gridTemplateColumns: maximized ? `${left}px 0px minmax(0, 1fr)` : `${left}px minmax(0, 1fr) ${right}px` }
      }
      {...(dragging ? { 'data-dragging': '' } : {})}
      {...(props.sidebarCollapsed ? { 'data-sidebar-collapsed': '' } : {})}
      {...(props.detailsCollapsed ? { 'data-details-collapsed': '' } : {})}
      {...(props.narrow ? { 'data-narrow': '' } : {})}
    >
      <div className={styles.sidebarCol}>
        <div className={styles.columnBody} style={props.narrow ? undefined : { minWidth: `${sidebarWidth}px` }}>
          {props.sidebar}
        </div>
      </div>
      <div className={styles.centerCol}>{props.main}</div>
      <div className={styles.detailsCol}>
        <div className={styles.columnBody} style={props.narrow ? undefined : { minWidth: `${detailsWidth}px` }}>
          {props.details}
        </div>
      </div>
      {props.narrow && <div className={styles.backdrop} onClick={props.onCollapseSidebar} aria-hidden />}

      <div
        className={props.sidebarCollapsed ? styles.hidden : styles.handle}
        style={{ left: `${left}px` }}
        onPointerDown={startDrag('sidebar')}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话列表宽度"
      />
      <div
        className={props.detailsCollapsed || maximized ? styles.hidden : styles.handle}
        style={{ right: `${right}px`, marginRight: '-4px', marginLeft: 0 }}
        onPointerDown={startDrag('details')}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整详情面板宽度"
      />
    </div>
  )
}
