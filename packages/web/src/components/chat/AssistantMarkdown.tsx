import { memo, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import styles from './AssistantMarkdown.module.css'

const REMARK = [remarkGfm]
// `detect: false` keeps unlabelled fences unhighlighted instead of letting the
// language guesser mangle prose or shell transcripts.
const REHYPE = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as never

/**
 * Assistant prose. Fenced blocks get a header with the language and a copy
 * button; everything else is plain GFM.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className={styles.markdown}>
      <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={{ pre: CodeBlock }}>
        {text}
      </Markdown>
    </div>
  )
})

function CodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const language = extractLanguage(children)

  const copy = (): void => {
    void navigator.clipboard.writeText(extractText(children)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span>{language ?? ''}</span>
        <button className={styles.copyButton} onClick={copy} type="button">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/** react-markdown passes the `<code>` element as `pre`'s only child. */
function extractLanguage(children: ReactNode): string | null {
  const props = codeProps(children)
  const className = typeof props?.className === 'string' ? props.className : ''
  return /language-([\w+-]+)/.exec(className)?.[1] ?? null
}

function extractText(children: ReactNode): string {
  const value = codeProps(children)?.children
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join('') : ''
}

function codeProps(children: ReactNode): { className?: unknown; children?: unknown } | null {
  const element = children as { props?: { className?: unknown; children?: unknown } } | null
  return element?.props ?? null
}
