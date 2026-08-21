import { useState } from 'react'

import type { ChatNode } from '../../render/nodes.ts'
import styles from './ToolCard.module.css'

type ToolNode = Extract<ChatNode, { kind: 'tool' }>

const CLAMP_AFTER_LINES = 12

/**
 * A tool call rendered by kind. Bash gets the IN/OUT terminal pair, edits get a
 * diff, reads get the file body — a JSON dump for everything else would be
 * unreadable for the three tools that carry most of a session's traffic.
 */
export function ToolCard({ node }: { node: ToolNode }): JSX.Element {
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
        <ToolBody node={node} />
      </div>
    </>
  )
}

function ToolBody({ node }: { node: ToolNode }): JSX.Element {
  const input = node.input

  if (node.name === 'Edit' || node.name === 'Write') {
    return <EditBody node={node} />
  }

  const command = stringField(input, 'command')
  return (
    <>
      {command !== null ? (
        <Line gutter="IN" text={command} />
      ) : (
        <Line gutter="IN" text={summarizeInput(node.name, input)} />
      )}
      <OutputLine node={node} />
    </>
  )
}

function EditBody({ node }: { node: ToolNode }): JSX.Element {
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
      <OutputLine node={node} />
    </>
  )
}

function OutputLine({ node }: { node: ToolNode }): JSX.Element {
  if (node.status === 'running') return <div className={styles.waiting}>执行中…</div>
  if (!node.output) return <div className={styles.waiting}>（无输出）</div>
  return <Line gutter="OUT" text={node.output} error={node.status === 'error'} />
}

function Line({ gutter, text, error }: { gutter: string; text: string; error?: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const overflows = text.split('\n').length > CLAMP_AFTER_LINES

  return (
    <>
      <div className={styles.line}>
        <span className={styles.gutter}>{gutter}</span>
        <span
          className={[styles.content, error ? styles.contentError : '', overflows && !expanded ? styles.clamped : '']
            .filter(Boolean)
            .join(' ')}
        >
          {text}
        </span>
      </div>
      {overflows && (
        <button className={styles.more} onClick={() => setExpanded(!expanded)} type="button">
          {expanded ? '收起' : `展开全部 ${text.split('\n').length} 行`}
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
