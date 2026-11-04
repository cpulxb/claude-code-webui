import { memo, useState, type ReactNode } from 'react'

import type { ChatNode } from '../../render/nodes.ts'
import { editStats, stepTarget, summarizeSteps, toolVerb, type Step, type StepCategory } from '../../render/condense.ts'
import { useActiveSessionValue } from '../../store/session.ts'
import { ChevronRightIcon, CompassIcon, FileIcon, LightbulbIcon, PencilIcon, SearchIcon, TerminalIcon, WrenchIcon } from '../Icons.tsx'
import styles from './CondensedView.module.css'
import { ToolCardBody } from './ToolCard.tsx'

type ToolNode = Extract<ChatNode, { kind: 'tool' }>

const ICONS: Record<StepCategory, (props: { size?: number }) => JSX.Element> = {
  command: TerminalIcon,
  read: FileIcon,
  edit: PencilIcon,
  search: SearchIcon,
  web: CompassIcon,
  other: WrenchIcon,
}

/** The fold's tally, in this order: what was read and looked up, then changed, then run. */
const TALLY: StepCategory[] = ['read', 'search', 'web', 'edit', 'command', 'other']

/**
 * A run of consecutive steps, as a timeline: one row per step on a rail, the
 * one still running saying so in its row. Each opens to the detailed view's
 * card body.
 */
export function StepRun({ steps }: { steps: Step[] }): JSX.Element {
  const cwd = useActiveSessionValue((session) => session.cwd)
  return (
    <div className={steps.length > 1 ? `${styles.timeline} ${styles.rail}` : styles.timeline}>
      {steps.map((step) => (
        <StepRow key={step.key} step={step} cwd={cwd} />
      ))}
    </div>
  )
}

function StepRow({ step, cwd }: { step: Step; cwd: string | undefined }): JSX.Element {
  return step.kind === 'tool' ? <ToolStep node={step.node} stale={step.stale} cwd={cwd} /> : <ThinkingStep text={step.text} />
}

/** A tool call as one line; opening it shows the detailed view's card body. */
const ToolStep = memo(function ToolStep({
  node,
  stale,
  cwd,
}: {
  node: ToolNode
  stale: boolean
  cwd: string | undefined
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { category, verb } = toolVerb(node.name)
  const Icon = ICONS[category]
  const stats = editStats(node)

  return (
    <div className={`${styles.step} ${styles[`step-${category}`] ?? ''}`}>
      <button className={styles.stepHead} onClick={() => setOpen(!open)} type="button" aria-expanded={open}>
        <span className={`${styles.icon} ${node.status === 'running' && !stale ? styles.iconLive : ''}`}>
          <Icon size={12} />
        </span>
        <span className={styles.verb}>{verb}</span>
        {/* A path or command is set in mono; the call's own description is prose. */}
        <span className={typeof node.input['description'] === 'string' ? `${styles.target} ${styles.described}` : styles.target}>
          {stepTarget(node, cwd)}
        </span>
        {stats && (
          <span className={styles.stats}>
            <span className={styles.added}>+{stats.added}</span>
            <span className={styles.removed}>−{stats.removed}</span>
          </span>
        )}
        <span className={styles.meta}>
          {stale ? (
            '已中断'
          ) : node.status === 'running' ? (
            node.elapsedSeconds !== undefined ? `${Math.round(node.elapsedSeconds)}s` : '执行中…'
          ) : node.status === 'error' ? (
            <span className={styles.failed}>失败</span>
          ) : null}
        </span>
      </button>
      {open && (
        <div className={styles.stepBody}>
          <ToolCardBody node={node} stale={stale} />
        </div>
      )}
    </div>
  )
})

/** Thinking as one line — its opening words — that opens to the whole of it. */
const ThinkingStep = memo(function ThinkingStep({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className={styles.step}>
      <button className={styles.stepHead} onClick={() => setOpen(!open)} type="button" aria-expanded={open}>
        <span className={styles.icon}>
          <LightbulbIcon size={12} />
        </span>
        <span className={styles.verb}>思考</span>
        <span className={`${styles.target} ${styles.thought}`}>{text.trim().split('\n', 1)[0]}</span>
      </button>
      {open && <div className={styles.thinkingBody}>{text}</div>}
    </div>
  )
})

/**
 * A finished turn's process behind one line, its reply left below it. The
 * line tallies the steps by kind, so what the turn did reads without opening it.
 */
export function TurnFold({ label, steps, children }: { label: string; steps: Step[]; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const tally = TALLY.map((category) => {
    const count = steps.filter((step) => step.kind === 'tool' && toolVerb(step.node.name).category === category).length
    return { category, count }
  }).filter(({ count }) => count > 0)

  return (
    <>
      <button className={styles.fold} onClick={() => setOpen(!open)} type="button" aria-expanded={open}>
        <span className={styles.foldLabel}>{label}</span>
        {tally.length > 0 && (
          <span className={styles.tally} title={summarizeSteps(steps)} aria-label={summarizeSteps(steps)} role="img">
            {tally.map(({ category, count }) => {
              const Icon = ICONS[category]
              return (
                <span key={category}>
                  <Icon size={12} />
                  {count}
                </span>
              )
            })}
          </span>
        )}
        <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`}>
          <ChevronRightIcon size={14} />
        </span>
      </button>
      {open && <div className={styles.foldBody}>{children}</div>}
    </>
  )
}
