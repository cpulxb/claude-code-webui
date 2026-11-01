import { memo, useState, type ReactNode } from 'react'

import type { ChatNode } from '../../render/nodes.ts'
import { editStats, stepTarget, summarizeSteps, toolVerb, type Step, type StepCategory } from '../../render/condense.ts'
import { useActiveSessionValue } from '../../store/session.ts'
import { CompassIcon, FileIcon, LightbulbIcon, PencilIcon, SearchIcon, TerminalIcon, WrenchIcon } from '../Icons.tsx'
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

/**
 * A run of consecutive steps. One step is just its row; more fold under a
 * summary line, which names the step still running so a live turn reads
 * without opening anything.
 */
export function StepRun({ steps }: { steps: Step[] }): JSX.Element {
  const cwd = useActiveSessionValue((session) => session.cwd)
  const [open, setOpen] = useState(false)
  if (steps.length === 1) return <StepRow step={steps[0]!} cwd={cwd} />

  const live = steps
    .filter(
      (step): step is Extract<Step, { kind: 'tool' }> =>
        step.kind === 'tool' && step.node.status === 'running' && !step.stale,
    )
    .at(-1)
  const failed = steps.filter((step) => step.kind === 'tool' && step.node.status === 'error').length

  return (
    <>
      <button className={styles.runToggle} onClick={() => setOpen(!open)} type="button" aria-expanded={open}>
        <span className={styles.summary}>{summarizeSteps(steps)}</span>
        {failed > 0 && <span className={styles.failed}>{failed} 个失败</span>}
        {live && (
          <span className={styles.live}>
            {toolVerb(live.node.name).verb} {stepTarget(live.node, cwd)}
          </span>
        )}
        <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`}>▶</span>
      </button>
      {open && (
        <div className={styles.steps}>
          {steps.map((step) => (
            <StepRow key={step.key} step={step} cwd={cwd} boxed />
          ))}
        </div>
      )}
    </>
  )
}

function StepRow({ step, cwd, boxed }: { step: Step; cwd: string | undefined; boxed?: boolean }): JSX.Element {
  return step.kind === 'tool' ? (
    <ToolStep node={step.node} stale={step.stale} cwd={cwd} boxed={boxed} />
  ) : (
    <ThinkingStep text={step.text} boxed={boxed} />
  )
}

/** A tool call as one line; opening it shows the detailed view's card body. */
const ToolStep = memo(function ToolStep({
  node,
  stale,
  cwd,
  boxed,
}: {
  node: ToolNode
  stale: boolean
  cwd: string | undefined
  boxed: boolean | undefined
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { category, verb } = toolVerb(node.name)
  const Icon = ICONS[category]
  const stats = editStats(node)

  return (
    <div className={boxed ? styles.boxedStep : undefined}>
      <button className={styles.stepHead} onClick={() => setOpen(!open)} type="button" aria-expanded={open}>
        <span className={styles.icon}>
          <Icon size={13} />
        </span>
        <span className={styles.verb}>{verb}</span>
        <span className={styles.target}>{stepTarget(node, cwd)}</span>
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
const ThinkingStep = memo(function ThinkingStep({ text, boxed }: { text: string; boxed: boolean | undefined }): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className={boxed ? styles.boxedStep : undefined}>
      <button className={styles.stepHead} onClick={() => setOpen(!open)} type="button" aria-expanded={open}>
        <span className={styles.icon}>
          <LightbulbIcon size={13} />
        </span>
        <span className={styles.verb}>思考</span>
        <span className={`${styles.target} ${styles.thought}`}>{text.trim().split('\n', 1)[0]}</span>
      </button>
      {open && <div className={styles.thinkingBody}>{text}</div>}
    </div>
  )
})

/** A finished turn's process behind one line, its reply left below it. */
export function TurnFold({ label, detail, children }: { label: string; detail: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button className={styles.fold} onClick={() => setOpen(!open)} type="button" aria-expanded={open}>
        {label}
        <span className={styles.foldDetail}>{detail}</span>
        <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`}>▶</span>
      </button>
      {open && <div className={styles.foldBody}>{children}</div>}
    </>
  )
}
