import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import { call } from '../../api/client.ts'
import { historyPrompts } from '../../render/history.ts'
import type { ChatNode } from '../../render/nodes.ts'
import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { splitQuotes } from '../../utils/quotes.ts'
import styles from './TurnNav.module.css'

type Prompt = { id: string; text: string }

/**
 * A tick per prompt of the main thread down the right edge of the chat, as
 * DeepSeek draws it: the one being read is longer and darker, and hovering
 * lists them all to jump between — prompts not read in yet included. Those
 * on screen are found by the `data-uuid` their bubbles carry.
 */
export function TurnNav({
  scrollRef,
  onJump,
}: {
  scrollRef: RefObject<HTMLDivElement>
  onJump: (id: string) => void
}): JSX.Element | null {
  const prompts = usePrompts()
  const [active, setActive] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // The prompt last jumped to stays marked until the reader scrolls on their
  // own: one near the end of what is read in cannot reach the top of the view,
  // and pages landing below it would otherwise mark the one before.
  const pinned = useRef<string | null>(null)
  // The prompt list is rebuilt whenever any node changes; only a different
  // set of prompts needs the scroll listener set up again.
  const ids = prompts.map((prompt) => prompt.id).join('\n')

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || prompts.length < 2) return
    let frame: number | undefined
    // The prompt being read is the last one above the top third of the view;
    // at the very end it is the last, however short its turn. Above the first
    // one read in, it is the one before that.
    const measure = (): void => {
      frame = undefined
      if (pinned.current) {
        setActive(pinned.current)
        return
      }
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2
      const shown = [...scroller.querySelectorAll<HTMLElement>('[data-uuid]')]
      let current: string | null = null
      for (const element of shown) {
        if (!atEnd && element.getBoundingClientRect().top > line) break
        current = element.dataset['uuid'] ?? current
      }
      if (current === null && shown[0]) {
        const first = prompts.findIndex((prompt) => prompt.id === shown[0]!.dataset['uuid'])
        current = prompts[Math.max(first - 1, 0)]!.id
      }
      setActive(current)
    }
    const schedule = (): void => {
      frame ??= requestAnimationFrame(measure)
    }
    const release = (): void => {
      if (pinned.current === null) return
      pinned.current = null
      schedule()
    }
    const own = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const
    measure()
    scroller.addEventListener('scroll', schedule, { passive: true })
    for (const type of own) scroller.addEventListener(type, release, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      for (const type of own) scroller.removeEventListener(type, release)
      window.removeEventListener('resize', schedule)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, scrollRef])

  // A long list opens scrolled to where the reader is.
  useEffect(() => {
    if (open) listRef.current?.querySelector(`.${styles.itemActive}`)?.scrollIntoView({ block: 'nearest' })
  }, [open])

  if (prompts.length < 2) return null

  return (
    <div className={styles.nav} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {open && (
        <div className={styles.panel} ref={listRef}>
          {prompts.map((prompt) => (
            <button
              key={prompt.id}
              className={`${styles.item} ${prompt.id === active ? styles.itemActive : ''}`}
              onClick={() => {
                pinned.current = prompt.id
                setActive(prompt.id)
                onJump(prompt.id)
                setOpen(false)
              }}
              type="button"
              title={prompt.text}
            >
              {prompt.text}
            </button>
          ))}
        </div>
      )}
      {/* Opens the list on a tap too, where there is no hover. */}
      <button className={styles.ticks} onClick={() => setOpen(true)} type="button" aria-label="按提问跳转">
        {prompts.map((prompt) => (
          <span key={prompt.id} className={`${styles.tick} ${prompt.id === active ? styles.tickActive : ''}`} />
        ))}
      </button>
    </div>
  )
}

/** Prompt lists read from disk, by session: once per page load, as new prompts arrive as nodes. */
const onDisk = new Map<string, Prompt[]>()

/**
 * The main thread's prompts: those on disk, then any newer ones read in or
 * sent since. Only a session not wholly read in asks the server.
 */
function usePrompts(): Prompt[] {
  const sessionId = useStore((state) => state.activeId)
  const cwd = useActiveSessionValue((session) => session.cwd)
  const nodes = useActiveSessionValue((session) => session.transcript.nodes)
  const partial =
    useActiveSessionValue((session) => session.historyCursor !== null || session.newerCursor !== null) ?? false
  const [, setRead] = useState(0)

  useEffect(() => {
    if (!sessionId || !cwd || !partial || onDisk.has(sessionId)) return
    let current = true
    call('history.prompts', { sessionId, cwd }).then(
      ({ messages }) => {
        onDisk.set(sessionId, historyPrompts(messages).map(toPrompt))
        if (current) setRead((count) => count + 1)
      },
      // Without it the navigator still lists the prompts read in.
      () => {},
    )
    return () => {
      current = false
    }
  }, [sessionId, cwd, partial])

  const disk = sessionId ? onDisk.get(sessionId) : undefined
  return useMemo(() => {
    const loaded = (nodes ?? []).flatMap((node) => (node.kind === 'user' ? [toPrompt(node)] : []))
    if (!disk) return loaded
    const known = new Set(disk.map((prompt) => prompt.id))
    return [...disk, ...loaded.filter((prompt) => !known.has(prompt.id))]
  }, [nodes, disk])
}

/** A prompt's first line, past any quoted passages; an attachment alone stands in for an empty one. */
function toPrompt(node: Extract<ChatNode, { kind: 'user' }>): Prompt {
  const line = splitQuotes(node.text).body.trim().split('\n', 1)[0]!
  return { id: node.id, text: line || (node.attachments > 0 ? `附件 × ${node.attachments}` : '（空消息）') }
}
