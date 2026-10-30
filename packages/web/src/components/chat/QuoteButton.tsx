import { useEffect, useState, type RefObject } from 'react'

import { useStore } from '../../store/session.ts'
import { ReplyIcon } from '../Icons.tsx'
import styles from './ChatView.module.css'

/** On a phone the browser's own copy/paste bar sits above the selection, so the button goes below. */
const TOUCH = window.matchMedia('(pointer: coarse)')
/** Space between the selection and the button; on touch it also clears the selection handles. */
const GAP = TOUCH.matches ? 28 : 8
/** Less room than this above the selection, within the scrolled view, and the button goes below. */
const ROOM = 44
/** How close the button's centre may come to either side of the stream. */
const EDGE = 40

type Spot = { text: string; top: number; left: number; below: boolean }

/**
 * claude.ai's "Reply": text selected in the conversation offers a button that
 * puts it over the composer as a quote. Placed in the stream's own
 * coordinates, so it scrolls along with the text it belongs to.
 */
export function QuoteButton({
  scrollRef,
  streamRef,
}: {
  scrollRef: RefObject<HTMLDivElement>
  streamRef: RefObject<HTMLDivElement>
}): JSX.Element | null {
  const [spot, setSpot] = useState<Spot | null>(null)

  useEffect(() => {
    const stream = streamRef.current
    const scroller = scrollRef.current
    if (!stream || !scroller) return
    // A selection being dragged out is not finished: the button waits for the release.
    let down = false

    const measure = (): void => {
      if (down) return
      const selection = document.getSelection()
      const text = selection?.toString().trim()
      if (!selection || selection.rangeCount === 0 || !text) return setSpot(null)
      const range = selection.getRangeAt(0)
      if (!stream.contains(range.commonAncestorContainer)) return setSpot(null)
      const rect = range.getBoundingClientRect()
      const box = stream.getBoundingClientRect()
      const below = TOUCH.matches || rect.top - scroller.getBoundingClientRect().top < ROOM
      setSpot({
        text,
        top: (below ? rect.bottom + GAP : rect.top - GAP) - box.top,
        left: Math.min(Math.max(rect.left + rect.width / 2 - box.left, EDGE), box.width - EDGE),
        below,
      })
    }
    const onDown = (): void => {
      down = true
      setSpot(null)
    }
    const onUp = (): void => {
      down = false
      measure()
    }

    document.addEventListener('pointerdown', onDown)
    // A long press on touch ends in pointercancel; the handles then move the selection.
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    document.addEventListener('selectionchange', measure)
    // Output streaming in, or an older page landing above, moves the text under the button.
    const observer = new ResizeObserver(measure)
    observer.observe(stream)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      document.removeEventListener('selectionchange', measure)
      observer.disconnect()
    }
  }, [scrollRef, streamRef])

  if (!spot) return null

  // Acted on at the press: a tap on a phone can clear the selection, and with
  // it this button, before a click would arrive.
  const quote = (event: React.PointerEvent): void => {
    event.preventDefault()
    const { quotes, setQuotes } = useStore.getState()
    if (!quotes.includes(spot.text)) setQuotes([...quotes, spot.text])
    document.getSelection()?.removeAllRanges()
    setSpot(null)
  }

  return (
    <button
      className={`${styles.quoteButton} ${spot.below ? styles.quoteButtonBelow : ''}`}
      style={{ top: spot.top, left: spot.left }}
      onPointerDown={quote}
      type="button"
    >
      <ReplyIcon size={14} />
      引用
    </button>
  )
}
