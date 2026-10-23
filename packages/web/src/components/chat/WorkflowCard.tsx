import { memo, useState } from 'react'

import type { AgentStatus, ChatNode } from '../../render/nodes.ts'
import {
  workflowAgentKey,
  workflowAgentStatus,
  type WorkflowAgent,
  type WorkflowPhase,
  type WorkflowRun,
} from '../../render/workflows.ts'
import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { ChevronRightIcon } from '../Icons.tsx'
import { STATUS_LABEL } from './AgentCard.tsx'
import styles from './WorkflowCard.module.css'

type ToolNode = Extract<ChatNode, { kind: 'tool' }>

const AGENT_STATE_LABEL: Record<string, string> = {
  start: '排队',
  progress: '运行中',
  done: '完成',
  error: '失败',
}

/**
 * A `Workflow` tool call, drawn as the terminal's /workflows detail view:
 * the run's phases, every agent under its phase with its state and totals,
 * and each agent one click from its own conversation.
 */
export const WorkflowCard = memo(function WorkflowCard({ node }: { node: ToolNode }): JSX.Element {
  const run = useActiveSessionValue((session) => session.transcript.workflows[node.toolUseId])
  const attached = useActiveSessionValue((session) => session.attached) ?? false
  const openAgent = useStore((state) => state.openAgent)
  const stopWorkflow = useStore((state) => state.stopWorkflow)
  const [busy, setBusy] = useState(false)
  const [showScript, setShowScript] = useState(false)

  const status: AgentStatus = run?.status ?? (node.status === 'error' ? 'failed' : 'running')
  const running = status === 'running'
  const agents = run?.agents ?? []
  const done = agents.filter((agent) => agent.state === 'done').length
  const script = run?.script ?? (typeof node.input['script'] === 'string' ? node.input['script'] : undefined)

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.badge}>工作流</span>
        <span className={styles.title}>{run?.name ?? 'workflow'}</span>
        <span className={`${styles.status} ${styles[status]}`}>{STATUS_LABEL[status]}</span>
      </div>
      {run?.description && <div className={styles.description}>{run.description}</div>}

      <div className={styles.meta}>
        {agents.length > 0 && (
          <span>
            {done}/{agents.length} 个代理完成
          </span>
        )}
        {run && <RunStats run={run} />}
      </div>

      {run && agents.length > 0 && (
        <div className={styles.phases}>
          {groupByPhase(run).map(({ phase, members }) => (
            <div key={phase?.index ?? 0} className={styles.phase}>
              {phase && (
                <div className={styles.phaseHeader}>
                  <span className={styles.phaseIndex}>{phase.index}</span>
                  <span className={styles.phaseTitle}>{phase.title}</span>
                  {phase.detail && <span className={styles.phaseDetail}>{phase.detail}</span>}
                  <span className={styles.phaseCount}>
                    {members.filter((agent) => agent.state === 'done').length}/{members.length}
                  </span>
                </div>
              )}
              {members.map((agent) => (
                <AgentRow
                  key={agent.index}
                  agent={agent}
                  onOpen={agent.agentId ? () => void openAgent(workflowAgentKey(agent.agentId!)) : undefined}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      {run && agents.length === 0 && running && <div className={styles.waiting}>正在启动代理…</div>}

      {run?.error && <div className={styles.error}>{run.error}</div>}

      <div className={styles.actions}>
        {script && (
          <button className={styles.button} onClick={() => setShowScript(!showScript)} type="button">
            {showScript ? '收起脚本' : '查看脚本'}
          </button>
        )}
        {running && attached && run?.taskId && (
          <button
            className={styles.button}
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void stopWorkflow(node.toolUseId).finally(() => setBusy(false))
            }}
            type="button"
          >
            停止工作流
          </button>
        )}
      </div>
      {showScript && script && <pre className={styles.script}>{script}</pre>}
    </div>
  )
})

function AgentRow({ agent, onOpen }: { agent: WorkflowAgent; onOpen: (() => void) | undefined }): JSX.Element {
  const status = workflowAgentStatus(agent)
  const queued = agent.state === 'start' && !agent.startedAt
  const activity =
    agent.state === 'error'
      ? agent.error
      : agent.state === 'done'
        ? agent.resultPreview
        : agent.lastToolSummary
          ? `${agent.lastToolName ?? ''} ${agent.lastToolSummary}`.trim()
          : agent.lastToolName
  const stats: string[] = []
  if (agent.toolCalls > 0) stats.push(`${agent.toolCalls} 次工具`)
  if (agent.tokens > 0) stats.push(`${formatTokens(agent.tokens)} tokens`)
  if (agent.durationMs > 0) stats.push(formatSeconds(agent.durationMs))
  return (
    <button
      className={styles.agent}
      data-workflow-agent={agent.label}
      disabled={!onOpen}
      onClick={onOpen}
      title={agent.promptPreview ?? agent.label}
      type="button"
    >
      <span className={`${styles.dot} ${queued ? styles.queued : styles[status]}`} />
      <span className={styles.agentLabel}>{agent.label}</span>
      <span className={styles.agentState}>
        {agent.cached ? '缓存' : queued ? '排队' : (AGENT_STATE_LABEL[agent.state] ?? agent.state)}
        {agent.attempt && agent.attempt > 1 ? ` · 第 ${agent.attempt} 次` : ''}
      </span>
      {activity && <span className={styles.agentActivity}>{activity}</span>}
      {stats.length > 0 && <span className={styles.agentStats}>{stats.join(' · ')}</span>}
      {onOpen && (
        <span className={styles.open}>
          <ChevronRightIcon size={12} />
        </span>
      )}
    </button>
  )
}

function RunStats({ run }: { run: WorkflowRun }): JSX.Element | null {
  const parts: string[] = []
  if (run.toolCalls > 0) parts.push(`${run.toolCalls} 次工具`)
  if (run.totalTokens > 0) parts.push(`${formatTokens(run.totalTokens)} tokens`)
  if (run.durationMs > 0) parts.push(formatSeconds(run.durationMs))
  if (parts.length === 0) return null
  return <span className={styles.stats}>{parts.join(' · ')}</span>
}

/** Agents under the phase they ran in; agents outside any phase come first. */
function groupByPhase(run: WorkflowRun): { phase: WorkflowPhase | null; members: WorkflowAgent[] }[] {
  const groups: { phase: WorkflowPhase | null; members: WorkflowAgent[] }[] = []
  const loose = run.agents.filter((agent) => agent.phaseIndex === undefined && !agent.phaseTitle)
  if (loose.length > 0) groups.push({ phase: null, members: loose })
  const phases = [...run.phases]
  // A phase the snapshot named only on its agents still gets a header.
  for (const agent of run.agents) {
    if (agent.phaseIndex === undefined) continue
    if (!phases.some((phase) => phase.index === agent.phaseIndex)) {
      phases.push({ index: agent.phaseIndex, title: agent.phaseTitle ?? `阶段 ${agent.phaseIndex}` })
    }
  }
  phases.sort((a, b) => a.index - b.index)
  for (const phase of phases) {
    const members = run.agents.filter(
      (agent) => agent.phaseIndex === phase.index || (agent.phaseIndex === undefined && agent.phaseTitle === phase.title),
    )
    if (members.length > 0) groups.push({ phase, members })
  }
  return groups
}

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 120) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
}
