import { memo, useEffect, useState } from 'react'

import type { AgentRun, AgentStatus, ChatNode } from '../../render/nodes.ts'
import { findAgent } from '../../render/nodes.ts'
import { useActiveSessionValue, useStore } from '../../store/session.ts'
import styles from './AgentCard.module.css'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'

type ToolNode = Extract<ChatNode, { kind: 'tool' }>

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
}

/**
 * An Agent tool call, rendered as the subagent it started rather than as a
 * generic tool: what it was asked, what it is doing right now, what it handed
 * back, and the way into its own conversation.
 */
export const AgentCard = memo(function AgentCard({ node, stale }: { node: ToolNode; stale: boolean }): JSX.Element {
  const agent = useActiveSessionValue((session) => findAgent(session.transcript, node.toolUseId))
  const attached = useActiveSessionValue((session) => session.attached) ?? false
  const openAgent = useStore((state) => state.openAgent)
  const stopAgent = useStore((state) => state.stopAgent)
  const backgroundAgent = useStore((state) => state.backgroundAgent)
  const [busy, setBusy] = useState(false)

  const description = agent?.description || stringField(node.input, 'description') || '子代理'
  const reported: AgentStatus =
    agent?.status ?? (node.status === 'error' ? 'failed' : node.status === 'done' ? 'completed' : 'running')
  // `stale` means the main thread was still blocked on this call when its
  // runner died — so the subagent died with it. Mapping the status rather
  // than the label also stops the timer and hides 停止 / 转入后台, which have
  // nothing left to act on.
  const status: AgentStatus = stale && reported === 'running' ? 'stopped' : reported
  const running = status === 'running'
  const elapsed = useElapsed(running)

  const act = (action: () => Promise<void>): void => {
    setBusy(true)
    void action().finally(() => setBusy(false))
  }

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.badge}>子代理</span>
        <span className={styles.title}>{description}</span>
        {agent?.subagentType && <span className={styles.type}>{agent.subagentType}</span>}
        <span className={`${styles.status} ${styles[status]}`}>
          {STATUS_LABEL[status]}
          {agent?.backgrounded && running ? ' · 后台' : ''}
        </span>
      </div>

      <div className={styles.meta}>
        {running && <span className={styles.activity}>{agent?.activity ?? (agent?.lastTool ? `正在 ${agent.lastTool}` : '启动中…')}</span>}
        {agent && <AgentStats agent={agent} fallbackSeconds={running ? elapsed : undefined} />}
      </div>

      {!running && agent?.summary && <Report text={agent.summary} />}

      <div className={styles.actions}>
        <button className={styles.primary} onClick={() => void openAgent(node.toolUseId)} type="button">
          打开会话 →
        </button>
        {running && attached && agent?.agentId && (
          <button className={styles.button} disabled={busy} onClick={() => act(() => stopAgent(node.toolUseId))} type="button">
            停止
          </button>
        )}
        {running && attached && !agent?.backgrounded && (
          <button
            className={styles.button}
            disabled={busy}
            onClick={() => act(() => backgroundAgent(node.toolUseId))}
            type="button"
            title="同终端的 Ctrl+B：子代理继续运行，主线程不再等待它"
          >
            转入后台
          </button>
        )}
      </div>
    </div>
  )
})

/** The hand-back report, clamped like tool output so a long one does not bury the thread. */
function Report({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const long = text.length > 280 || text.split('\n').length > 5
  return (
    <>
      <div className={`${styles.summary} ${long && !open ? styles.summaryClamped : ''}`}>
        <AssistantMarkdown text={text} />
      </div>
      {long && (
        <button className={styles.more} onClick={() => setOpen(!open)} type="button">
          {open ? '收起报告' : '展开完整报告'}
        </button>
      )}
    </>
  )
}

export function AgentStats({ agent, fallbackSeconds }: { agent: AgentRun; fallbackSeconds?: number }): JSX.Element | null {
  const parts: string[] = []
  // History keeps no run totals, so a reloaded card counts its own tool calls
  // once the conversation is loaded.
  const toolUses = agent.toolUses || agent.transcript.nodes.filter((node) => node.kind === 'tool').length
  if (toolUses > 0) parts.push(`${toolUses} 次工具`)
  if (agent.totalTokens > 0) parts.push(`${formatTokens(agent.totalTokens)} tokens`)
  const seconds = agent.durationMs > 0 ? agent.durationMs / 1000 : fallbackSeconds
  if (seconds !== undefined) parts.push(`${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`)
  if (agent.model) parts.push(agent.model)
  if (parts.length === 0) return null
  return <span className={styles.stats}>{parts.join(' · ')}</span>
}

/** Seconds since this card first saw its agent running, ticking once a second. */
function useElapsed(running: boolean): number {
  const [startedAt] = useState(() => Date.now())
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [running])
  return (Date.now() - startedAt) / 1000
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' ? value : null
}

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}
