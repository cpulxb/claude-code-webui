import type { RewindFilesResult } from '@ccw/shared'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { AssistantBlock, ChatNode, StreamingBlock } from '../../render/nodes.ts'
import { AGENT_TOOLS, findAgent } from '../../render/nodes.ts'
import { WORKFLOW_TOOL } from '../../render/workflows.ts'
import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { HistoryIcon } from '../Icons.tsx'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import styles from './ChatView.module.css'
import { PermissionCard } from './PermissionCard.tsx'
import { AgentCard } from './AgentCard.tsx'
import { WorkflowCard } from './WorkflowCard.tsx'
import { AgentNav } from './AgentNav.tsx'
import { ToolCard } from './ToolCard.tsx'

/** Pixels from the bottom within which we keep following new output. */
const FOLLOW_THRESHOLD = 120

/** One in-flight rewind interaction, anchored to a single user bubble. */
type RewindState = { nodeId: string; busy: boolean; preview: RewindFilesResult | null; error: string | null }

export function ChatView(): JSX.Element | null {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const frameRef = useRef<number | undefined>(undefined)
  // Last session and node count this component scrolled for, to tell a swapped
  // node list apart from a node appended by the running turn.
  const seenRef = useRef<{ id: string | null; count: number }>({ id: null, count: 0 })
  const activeId = useStore((state) => state.activeId)
  const rewindFiles = useStore((state) => state.rewindFiles)
  const [rewind, setRewind] = useState<RewindState | null>(null)
  // Rewind previews race each other when the user clicks several bubbles in a
  // row; only the newest request may write state.
  const rewindSeq = useRef(0)

  // Inside a subagent the pane shows that agent's own transcript; every other
  // part of the view (scroll following, permission cards) works the same.
  const viewAgent = useActiveSessionValue((session) => session.viewAgent) ?? null
  const transcript = useActiveSessionValue((session) =>
    session.viewAgent ? (findAgent(session.transcript, session.viewAgent)?.transcript ?? session.transcript) : session.transcript,
  )
  const agentId = useActiveSessionValue((session) =>
    session.viewAgent ? findAgent(session.transcript, session.viewAgent)?.agentId : undefined,
  )
  const allPermissions = useActiveSessionValue((session) => session.pendingPermissions)
  // The main thread shows every prompt so none is ever missed; a subagent
  // view shows only the ones its own tool calls raised.
  const pendingPermissions = viewAgent ? allPermissions?.filter((request) => request.agentId === agentId) : allPermissions
  const error = useActiveSessionValue((session) => session.error)

  const startRewind = useCallback(
    async (nodeId: string): Promise<void> => {
      const seq = ++rewindSeq.current
      setRewind({ nodeId, busy: true, preview: null, error: null })
      try {
        const preview = await rewindFiles(nodeId, true)
        if (seq !== rewindSeq.current) return
        setRewind({
          nodeId,
          busy: false,
          preview,
          error: preview.canRewind ? null : (preview.error ?? '无法回退到这条消息'),
        })
      } catch (cause) {
        if (seq !== rewindSeq.current) return
        setRewind({ nodeId, busy: false, preview: null, error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
    [rewindFiles],
  )

  const confirmRewind = useCallback(
    async (nodeId: string): Promise<void> => {
      const seq = ++rewindSeq.current
      setRewind((current) => (current ? { ...current, busy: true } : current))
      try {
        const result = await rewindFiles(nodeId, false)
        if (seq !== rewindSeq.current) return
        if (result.canRewind) setRewind(null)
        else setRewind({ nodeId, busy: false, preview: null, error: result.error ?? '回退失败' })
      } catch (cause) {
        if (seq !== rewindSeq.current) return
        setRewind({ nodeId, busy: false, preview: null, error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
    [rewindFiles],
  )

  const cancelRewind = useCallback(() => {
    rewindSeq.current += 1
    setRewind(null)
  }, [])

  // Only auto-scroll while the reader is already at the bottom; yanking the
  // viewport away from someone reading scrollback is the classic chat bug.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const onScroll = (): void => {
      followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  const nodes = transcript?.nodes
  const streaming = transcript?.streaming

  // Streaming coalesces into one scroll per frame: measuring on every token
  // forced a synchronous layout per delta. A swapped node list — session
  // switch, history replay landing — is positioned before paint instead, since
  // a frame later means the browser first draws the whole history at scrollTop
  // 0. `nodes` is a fresh array whenever a node is added *or* mutated, so
  // arriving tool output follows too.
  useLayoutEffect(() => {
    const count = nodes?.length ?? 0
    const seen = seenRef.current
    const viewKey = `${activeId}/${viewAgent ?? ''}`
    const switched = seen.id !== viewKey
    // Per-token deltas mutate a node in place or append one; a bigger jump is
    // a replacement — or a multi-tool assistant message, which is just as
    // cheap to place synchronously because it lands once per turn, not once
    // per token.
    const swapped = switched || count > seen.count + 1
    seenRef.current = { id: viewKey, count }
    // A freshly opened session opens at the bottom, whatever the reader was
    // doing in the session they came from.
    if (switched) followRef.current = true
    if (!followRef.current) return
    const element = scrollRef.current
    if (!element) return
    if (swapped) {
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = undefined
      }
      element.scrollTop = element.scrollHeight
      return
    }
    if (frameRef.current !== undefined) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      if (followRef.current) element.scrollTop = element.scrollHeight
    })
  }, [nodes, streaming, pendingPermissions, activeId, viewAgent])

  useEffect(
    () => () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  if (!nodes) return null
  const empty = nodes.length === 0 && !streaming

  return (
    <div className={styles.scroll} ref={scrollRef}>
      <AgentNav />
      {empty ? (
        <div className={styles.empty}>
          <span className={styles.emptyMark}>✳</span>
          <span>Claude Code</span>
        </div>
      ) : (
        <div className={styles.stream}>
          {nodes.map((node) =>
            node.kind === 'user' && viewAgent ? (
              // A subagent's prompt came from the parent model, not from a
              // checkpointed user message, so it has nothing to rewind to.
              <div key={node.id} className={styles.userTurn}>
                <div className={styles.agentPromptLabel}>主代理下达的任务</div>
                {node.text}
              </div>
            ) : node.kind === 'user' ? (
              <UserTurn
                key={node.id}
                node={node}
                rewind={rewind?.nodeId === node.id ? rewind : null}
                onRewind={startRewind}
                onConfirm={confirmRewind}
                onCancel={cancelRewind}
              />
            ) : (
              <NodeView key={node.id} node={node} />
            ),
          )}
          {streaming && <StreamingRow block={streaming} />}
          {pendingPermissions?.map((request) => (
            <PermissionCard key={request.requestId} request={request} />
          ))}
          {error && <div className={`${styles.row} ${styles.rowError}`}>{error}</div>}
        </div>
      )}
    </div>
  )
}

const UserTurn = memo(function UserTurn({
  node,
  rewind,
  onRewind,
  onConfirm,
  onCancel,
}: {
  node: Extract<ChatNode, { kind: 'user' }>
  rewind: RewindState | null
  onRewind: (nodeId: string) => void
  onConfirm: (nodeId: string) => void
  onCancel: () => void
}): JSX.Element {
  return (
    <>
      <div className={styles.userTurn}>
        {node.text}
        {node.attachments > 0 && <div className={styles.attachmentNote}>附件 × {node.attachments}</div>}
        <button
          className={styles.rewindButton}
          onClick={() => onRewind(node.id)}
          type="button"
          title="把文件回退到这条消息之前的状态"
        >
          <HistoryIcon size={13} />
        </button>
      </div>

      {rewind && (
        <div className={styles.rewindCard}>
          {rewind.busy ? (
            <span>{rewind.preview ? '回退中…' : '检查回退范围…'}</span>
          ) : rewind.error ? (
            <span className={styles.rewindError}>{rewind.error}</span>
          ) : rewind.preview ? (
            <span>
              将回退 {rewind.preview.filesChanged?.length ?? 0} 个文件（+{rewind.preview.insertions ?? 0} −
              {rewind.preview.deletions ?? 0}）
            </span>
          ) : null}
          {!rewind.busy && !rewind.error && rewind.preview && (
            <button className={styles.rewindConfirm} onClick={() => onConfirm(node.id)} type="button">
              确认回退
            </button>
          )}
          {!rewind.busy && (
            <button className={styles.rewindCancel} onClick={onCancel} type="button">
              取消
            </button>
          )}
        </div>
      )}
    </>
  )
})

const NodeView = memo(function NodeView({ node }: { node: Exclude<ChatNode, { kind: 'user' }> }): JSX.Element | null {
  switch (node.kind) {
    case 'assistant':
      return (
        <div className={styles.row}>
          {node.blocks.map((block, index) => (
            <BlockView key={index} block={block} />
          ))}
        </div>
      )

    case 'tool':
      return (
        <div
          className={[
            styles.row,
            node.status === 'running' ? styles.rowPending : '',
            node.status === 'error' ? styles.rowError : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {AGENT_TOOLS.has(node.name) ? (
            <AgentCard node={node} />
          ) : node.name === WORKFLOW_TOOL ? (
            <WorkflowCard node={node} />
          ) : (
            <ToolCard node={node} />
          )}
        </div>
      )

    case 'localOutput':
      return (
        <div className={`${styles.row} ${styles.rowMuted}`}>
          <div className={styles.localOutput}>{node.content}</div>
        </div>
      )

    case 'notice':
      return (
        <div className={`${styles.row} ${styles.rowMuted}`}>
          <div className={`${styles.notice} ${node.level === 'warning' ? styles.noticeWarning : ''}`}>{node.text}</div>
        </div>
      )

    case 'compact':
      return (
        <div className={styles.compact}>
          上下文已压缩（{node.trigger === 'auto' ? '自动' : '手动'}，{formatTokens(node.preTokens)}
          {node.postTokens !== undefined ? ` → ${formatTokens(node.postTokens)}` : ''}）
        </div>
      )

    case 'result':
      return (
        <div className={`${styles.stats} ${node.isError ? styles.statsError : ''}`}>
          <span>{node.numTurns} 轮</span>
          <span>{(node.durationMs / 1000).toFixed(1)}s</span>
          <span>
            输入 {formatTokens(node.inputTokens)} · 输出 {formatTokens(node.outputTokens)}
          </span>
          {node.cacheReadTokens > 0 && <span>缓存命中 {formatTokens(node.cacheReadTokens)}</span>}
          <span>${node.totalCostUsd.toFixed(4)}</span>
        </div>
      )
  }
})

function BlockView({ block }: { block: AssistantBlock }): JSX.Element {
  return block.type === 'thinking' ? <ReasoningRow text={block.text} /> : <AssistantMarkdown text={block.text} />
}

/** Thinking is collapsed by default — it is context, not the answer. */
const ReasoningRow = memo(function ReasoningRow({ text, live }: { text: string; live?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className={styles.reasoning}>
      <button className={styles.reasoningToggle} onClick={() => setOpen(!open)} type="button">
        <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`}>▶</span>
        {live ? '正在思考…' : '思考过程'}
      </button>
      {open && <div className={styles.reasoningBody}>{text}</div>}
    </div>
  )
})

function StreamingRow({ block }: { block: StreamingBlock }): JSX.Element {
  return (
    <div className={`${styles.row} ${styles.rowPending}`}>
      {block.type === 'thinking' ? (
        <ReasoningRow text={block.text} live />
      ) : (
        <>
          <AssistantMarkdown text={block.text} />
          <span className={styles.cursor} />
        </>
      )}
    </div>
  )
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}
