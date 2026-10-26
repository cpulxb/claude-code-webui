import { memo, useMemo, useState } from 'react'

import type { ChatNode } from '../../render/nodes.ts'
import styles from './ToolCard.module.css'

type ToolNode = Extract<ChatNode, { kind: 'tool' }>

const CLAMP_AFTER_LINES = 12
/** Collapsed char budget, so one 200KB line collapses like 200 short lines do. */
const CLAMP_AFTER_CHARS = 2_000
const MAX_RENDER_LINES = 500
const MAX_RENDER_CHARS = 60_000

/** Which hard cap cut the text, so the notice can name the one that applied. */
type Cap = 'lines' | 'chars'

const CAP_LABEL: Record<Cap, string> = {
  lines: `前 ${MAX_RENDER_LINES} 行`,
  chars: `前 ${MAX_RENDER_CHARS / 1000}k 字符`,
}

/**
 * A tool call rendered by kind. Bash gets the IN/OUT terminal pair, edits get a
 * diff, reads get the file body — a JSON dump for everything else would be
 * unreadable for the three tools that carry most of a session's traffic.
 */
export const ToolCard = memo(function ToolCard({ node, stale }: { node: ToolNode; stale: boolean }): JSX.Element {
  const { title, subtitle } = describe(node)

  return (
    <>
      <div className={styles.header}>
        <span className={styles.name}>{title}</span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        {node.status === 'running' && node.elapsedSeconds !== undefined && (
          <span className={styles.elapsed}>{Math.round(node.elapsedSeconds)}s</span>
        )}
      </div>
      <div className={styles.body}>
        <ToolBody node={node} stale={stale} />
      </div>
    </>
  )
})

function ToolBody({ node, stale }: { node: ToolNode; stale: boolean }): JSX.Element {
  const input = node.input

  if (node.name === 'Edit' || node.name === 'Write') {
    return <EditBody node={node} stale={stale} />
  }

  const command = stringField(input, 'command')
  return (
    <>
      {command !== null ? (
        <Line gutter="IN" text={command} />
      ) : (
        <Line gutter="IN" text={summarizeInput(node.name, input)} />
      )}
      <OutputLine node={node} stale={stale} />
    </>
  )
}

function EditBody({ node, stale }: { node: ToolNode; stale: boolean }): JSX.Element {
  const path = stringField(node.input, 'file_path') ?? ''
  const oldText = stringField(node.input, 'old_string')
  const newText = stringField(node.input, 'new_string') ?? stringField(node.input, 'content')

  return (
    <>
      <Line gutter="FILE" text={path} />
      <div className={styles.diffSection}>
        {oldText !== null &&
          oldText.split('\n').map((line, index) => (
            <div key={`o${index}`} className={`${styles.diffLine} ${styles.diffRemove}`}>
              {`- ${line}`}
            </div>
          ))}
        {newText !== null &&
          newText.split('\n').map((line, index) => (
            <div key={`n${index}`} className={`${styles.diffLine} ${styles.diffAdd}`}>
              {`+ ${line}`}
            </div>
          ))}
      </div>
      <OutputLine node={node} stale={stale} />
    </>
  )
}

function OutputLine({ node, stale }: { node: ToolNode; stale: boolean }): JSX.Element {
  // `stale` means the runner that owed this call a result is gone, so the
  // wait is over even though the card never got one.
  if (stale) return <div className={styles.waiting}>已中断 · 没有结果</div>
  if (node.status === 'running') return <div className={styles.waiting}>执行中…</div>
  if (!node.output) return <div className={styles.waiting}>（无输出）</div>
  return <Line gutter="OUT" text={node.output} error={node.status === 'error'} />
}

function Line({ gutter, text, error }: { gutter: string; text: string; error?: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // Tool output can be hundreds of KB; only the part that is actually visible
  // goes into the DOM, and splitting once keeps re-renders cheap. Both states
  // are capped by lines *and* by chars, so a single huge line is clamped and
  // reported like a long one: `cappedBy` names the cap a full expansion would
  // still hit, which is why the notice cannot key off the line count alone.
  // The notice only shows once expanded — while collapsed the button label
  // already says how much expanding is going to give.
  const { lineCount, visible, cappedBy } = useMemo((): {
    lineCount: number
    visible: string
    cappedBy: Cap | null
  } => {
    const lines = text.split('\n')
    const budget = lines.slice(0, MAX_RENDER_LINES).join('\n')
    const kept = expanded ? budget : lines.slice(0, CLAMP_AFTER_LINES).join('\n')
    const chars = expanded ? MAX_RENDER_CHARS : CLAMP_AFTER_CHARS
    return {
      lineCount: lines.length,
      visible: kept.length > chars ? kept.slice(0, chars) : kept,
      // When the char cap applies it ends inside the first MAX_RENDER_LINES
      // lines, so it is the limit the reader actually runs into.
      cappedBy: budget.length > MAX_RENDER_CHARS ? 'chars' : lines.length > MAX_RENDER_LINES ? 'lines' : null,
    }
  }, [text, expanded])
  // Whether collapsing hides anything — the expand button and the CSS clamp.
  const overflows = lineCount > CLAMP_AFTER_LINES || text.length > CLAMP_AFTER_CHARS

  return (
    <>
      <div className={styles.line}>
        <span className={styles.gutter}>{gutter}</span>
        <span
          className={[styles.content, error ? styles.contentError : '', overflows && !expanded ? styles.clamped : '']
            .filter(Boolean)
            .join(' ')}
        >
          {visible}
        </span>
      </div>
      {expanded && cappedBy && <div className={styles.truncated}>输出过长，最多显示{CAP_LABEL[cappedBy]}</div>}
      {overflows && (
        <button className={styles.more} onClick={() => setExpanded(!expanded)} type="button">
          {expanded ? '收起' : cappedBy ? `展开${CAP_LABEL[cappedBy]}（共 ${lineCount} 行）` : `展开全部 ${lineCount} 行`}
        </button>
      )}
    </>
  )
}

/** Header line: the tool's name plus the one field that identifies this call. */
function describe(node: ToolNode): { title: string; subtitle: string } {
  const input = node.input
  const description = stringField(input, 'description')
  if (description) return { title: node.name, subtitle: description }

  const path = stringField(input, 'file_path') ?? stringField(input, 'path')
  if (path) return { title: node.name, subtitle: path }

  const pattern = stringField(input, 'pattern') ?? stringField(input, 'query')
  if (pattern) return { title: node.name, subtitle: pattern }

  return { title: node.name, subtitle: '' }
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return name
  return JSON.stringify(input, null, 2)
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' ? value : null
}
