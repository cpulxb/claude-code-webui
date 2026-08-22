import type { RewindFilesResult } from '@ccw/shared'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { AssistantBlock, ChatNode, StreamingBlock } from '../../render/nodes.ts'
import { useStore, type SessionState } from '../../store/session.ts'
import { HistoryIcon } from '../Icons.tsx'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import styles from './ChatView.module.css'
import { PermissionCard } from './PermissionCard.tsx'
import { ToolCard } from './ToolCard.tsx'

/** Pixels from the bottom within which we keep following new output. */
const FOLLOW_THRESHOLD = 120

/** One in-flight rewind interaction, anchored to a single user bubble. */
type RewindState = { nodeId: string; busy: boolean; preview: RewindFilesResult | null; error: string | null }

export function ChatView({ session }: { session: SessionState }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const rewindFiles = useStore((state) => state.rewindFiles)
  const [rewind, setRewind] = useState<RewindState | null>(null)

  const { nodes, streaming } = session.transcript

  const startRewind = async (nodeId: string): Promise<void> => {
    setRewind({ nodeId, busy: true, preview: null, error: null })
    try {
      const preview = await rewindFiles(nodeId, true)
      setRewind({
        nodeId,
        busy: false,
        preview,
        error: preview.canRewind ? null : (preview.error ?? '无法回退到这条消息'),
      })
    } catch (cause) {
      setRewind({ nodeId, busy: false, preview: null, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const confirmRewind = async (nodeId: string): Promise<void> => {
    setRewind((current) => (current ? { ...current, busy: true } : current))
    try {
      const result = await rewindFiles(nodeId, false)
      if (result.canRewind) setRewind(null)
      else setRewind({ nodeId, busy: false, preview: null, error: result.error ?? '回退失败' })
    } catch (cause) {
      setRewind({ nodeId, busy: false, preview: null, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

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

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && followRef.current) element.scrollTop = element.scrollHeight
  }, [nodes.length, streaming?.text.length, session.pendingPermissions.length])

  const empty = nodes.length === 0 && !streaming

  return (
    <div className={styles.scroll} ref={scrollRef}>
      {empty ? (
        <div className={styles.empty}>
          <span className={styles.emptyMark}>✳</span>
          <span>Claude Code</span>
        </div>
      ) : (
        <div className={styles.stream}>
          {nodes.map((node) =>
            node.kind === 'user' ? (
              <UserTurn
                key={node.id}
                node={node}
                rewind={rewind?.nodeId === node.id ? rewind : null}
                onRewind={() => void startRewind(node.id)}
                onConfirm={() => void confirmRewind(node.id)}
                onCancel={() => setRewind(null)}
              />
            ) : (
              <NodeView key={node.id} node={node} />
            ),
          )}
          {streaming && <StreamingRow block={streaming} />}
          {session.pendingPermissions.map((request) => (
            <PermissionCard key={request.requestId} request={request} />
          ))}
          {session.error && <div className={`${styles.row} ${styles.rowError}`}>{session.error}</div>}
        </div>
      )}
    </div>
  )
}

function UserTurn({
  node,
  rewind,
  onRewind,
  onConfirm,
  onCancel,
}: {
  node: Extract<ChatNode, { kind: 'user' }>
  rewind: RewindState | null
  onRewind: () => void
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <>
      <div className={styles.userTurn}>
        {node.text}
        {node.attachments > 0 && <div className={styles.attachmentNote}>附件 × {node.attachments}</div>}
        <button
          className={styles.rewindButton}
          onClick={onRewind}
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
            <button className={styles.rewindConfirm} onClick={onConfirm} type="button">
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
}

function NodeView({ node }: { node: Exclude<ChatNode, { kind: 'user' }> }): JSX.Element | null {
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
          <ToolCard node={node} />
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
}

function BlockView({ block }: { block: AssistantBlock }): JSX.Element {
  return block.type === 'thinking' ? <ReasoningRow text={block.text} /> : <AssistantMarkdown text={block.text} />
}

/** Thinking is collapsed by default — it is context, not the answer. */
function ReasoningRow({ text, live }: { text: string; live?: boolean }): JSX.Element {
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
}

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
