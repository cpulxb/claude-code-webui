import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import styles from './AssistantMarkdown.module.css'

const REMARK = [remarkGfm]
// `detect: false` keeps unlabelled fences unhighlighted instead of letting the
// language guesser mangle prose or shell transcripts.
const REHYPE = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as never

/** Upper bound on how often streaming text is re-parsed into markdown. */
const THROTTLE_MS = 80

/**
 * Assistant prose. Fenced blocks get a header with the language and a copy
 * button; everything else is plain GFM.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text }: { text: string }) {
  const rendered = useThrottled(text)

  // The memo is what actually saves work: react-markdown re-parses on every
  // render, so an element rebuilt each delta costs a full remark + rehype pass
  // even when `rendered` did not move. Keeping the element identical lets React
  // bail out of the subtree entirely, so a parse only happens per throttle
  // window rather than per delta.
  const body = useMemo(
    () => (
      <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={{ pre: CodeBlock }}>
        {rendered}
      </Markdown>
    ),
    [rendered],
  )

  return <div className={styles.markdown}>{body}</div>
})

/**
 * Re-parsing the whole accumulated text on every stream delta is O(n²) per
 * turn, which is what makes long CJK answers stutter. Throttling here bounds
 * how often `rendered` moves, which — together with the memo above — bounds how
 * often the text is parsed; the trailing timer guarantees the final text lands
 * as long as the component stays mounted.
 */
function useThrottled(text: string): string {
  const [rendered, setRendered] = useState(text)
  const lastRenderedAt = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (text === rendered) return

    const wait = THROTTLE_MS - (Date.now() - lastRenderedAt.current)
    if (wait <= 0) {
      lastRenderedAt.current = Date.now()
      setRendered(text)
      return
    }

    timer.current = window.setTimeout(() => {
      lastRenderedAt.current = Date.now()
      setRendered(text)
    }, wait)
    // Cancelling on unmount cannot lose text that is still reachable: the only
    // caller that unmounts mid-window is the streaming row, and it unmounts
    // because the transcript dropped `streaming` altogether — the pending tail
    // is gone from the store at that point, with or without this timer. A
    // remount (streaming row → finalized assistant node) seeds `rendered` from
    // the full text, so the handover is lossless.
    return () => window.clearTimeout(timer.current)
  }, [text, rendered])

  return rendered
}

function CodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const preRef = useRef<HTMLPreElement>(null)
  const language = extractLanguage(children)

  const flash = (next: 'copied' | 'failed'): void => {
    setState(next)
    setTimeout(() => setState('idle'), 1400)
  }

  // Read the text off the DOM: rehype-highlight splits highlighted code into a
  // tree of <span>s, so the React children are elements rather than strings.
  const copy = (): void => {
    const text = preRef.current?.textContent ?? ''
    void navigator.clipboard.writeText(text).then(
      () => flash('copied'),
      () => flash('failed'),
    )
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span>{language ?? ''}</span>
        <button
          className={`${styles.copyButton} ${state === 'failed' ? styles.copyFailed : ''}`}
          onClick={copy}
          type="button"
        >
          {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制'}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  )
}

/** react-markdown passes the `<code>` element as `pre`'s only child. */
function extractLanguage(children: ReactNode): string | null {
  const props = codeProps(children)
  const className = typeof props?.className === 'string' ? props.className : ''
  return /language-([\w+-]+)/.exec(className)?.[1] ?? null
}

function codeProps(children: ReactNode): { className?: unknown; children?: unknown } | null {
  const element = children as { props?: { className?: unknown; children?: unknown } } | null
  return element?.props ?? null
}
