import { useEffect, useMemo } from 'react'

import { emptyTranscript, findAgent, listAgents } from '../../render/nodes.ts'
import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { AgentStats, STATUS_LABEL } from './AgentCard.tsx'
import styles from './AgentCard.module.css'

/**
 * The bar over the chat pane. On the main thread it lists the session's
 * subagents as chips — the CLI's agent tree, one click from each
 * conversation. Inside a subagent it is a breadcrumb back out, with the same
 * chips to hop between siblings.
 */
export function AgentNav(): JSX.Element | null {
  // Both slices keep their identity while only the main thread streams, so
  // the bar re-renders when an agent changes rather than on every token.
  const tree = useActiveSessionValue((session) => session.transcript.agents)
  const order = useActiveSessionValue((session) => session.transcript.agentOrder)
  const agents = useMemo(
    () => (tree && order ? listAgents({ ...emptyTranscript(), agents: tree, agentOrder: order }) : []),
    [tree, order],
  )
  const viewAgent = useActiveSessionValue((session) => session.viewAgent) ?? null
  const current = useActiveSessionValue((session) =>
    session.viewAgent ? findAgent(session.transcript, session.viewAgent) : null,
  )
  const workflow = useActiveSessionValue((session) =>
    current?.workflow ? (session.transcript.workflows[current.workflow] ?? null) : null,
  )
  const openAgent = useStore((state) => state.openAgent)
  const refreshAgent = useStore((state) => state.refreshAgent)

  // A workflow agent's conversation never streams; poll its file while it runs.
  const pollKey = current?.workflow && current.status === 'running' ? current.toolUseId : null
  useEffect(() => {
    if (!pollKey) return
    const timer = setInterval(() => void refreshAgent(pollKey).catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [pollKey, refreshAgent])

  // Inside a workflow the chips are that run's agents; on the main thread
  // they are the subagents, and each workflow card lists its own.
  const chips = current?.workflow
    ? agents.filter((agent) => agent.workflow === current.workflow)
    : agents.filter((agent) => !agent.workflow)
  const workflowCount = useActiveSessionValue((session) => Object.keys(session.transcript.workflows).length) ?? 0

  if (agents.length === 0) return null
  const running = chips.filter((agent) => agent.status === 'running').length

  return (
    <div className={styles.nav}>
      {current ? (
        <>
          <button className={styles.crumb} onClick={() => void openAgent(null)} type="button">
            ← 主会话
          </button>
          <span className={styles.sep}>›</span>
          {workflow && (
            <>
              <span className={styles.navLabel}>工作流 {workflow.name}</span>
              <span className={styles.sep}>›</span>
            </>
          )}
          <span className={styles.crumbCurrent}>{current.description || '子代理'}</span>
          <span className={styles.navLabel}>{STATUS_LABEL[current.status]}</span>
          <AgentStats agent={current} />
          <span className={styles.sep}>|</span>
        </>
      ) : (
        <span className={styles.navLabel}>
          {chips.length > 0 ? `子代理 ${chips.length} 个${running > 0 ? `，${running} 个运行中` : ''}` : ''}
          {chips.length > 0 && workflowCount > 0 ? '；' : ''}
          {workflowCount > 0 ? `工作流 ${workflowCount} 个` : ''}
        </span>
      )}
      {chips.map((agent) => (
        <button
          key={agent.toolUseId}
          className={`${styles.chip} ${agent.toolUseId === viewAgent ? styles.chipActive : ''}`}
          onClick={() => void openAgent(agent.toolUseId)}
          type="button"
          title={agent.prompt || agent.description}
        >
          <span className={`${styles.dot} ${styles[agent.status]}`} />
          {agent.description || '子代理'}
        </button>
      ))}
      {current && <span className={styles.readonly}>只读 · 输入框仍发给主会话</span>}
    </div>
  )
}
