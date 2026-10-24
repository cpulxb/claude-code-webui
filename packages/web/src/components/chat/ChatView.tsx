import type { RewindFilesResult } from '@ccw/shared'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { AssistantBlock, ChatNode, StreamingBlock } from '../../render/nodes.ts'
import { AGENT_TOOLS, findAgent } from '../../render/nodes.ts'
import { WORKFLOW_TOOL } from '../../render/workflows.ts'
import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { BrandMark, CheckIcon, HistoryIcon, LinkIcon } from '../Icons.tsx'
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
  // Only the main thread pages its history; a subagent's comes in one read.
  const historyCursor = useActiveSessionValue((session) => (session.viewAgent ? null : session.historyCursor)) ?? null
  const historyLoading = useActiveSessionValue((session) => session.historyLoading)
  const historyError = useActiveSessionValue((session) => (session.viewAgent ? null : session.historyError)) ?? null
  const loadOlderHistory = useStore((state) => state.loadOlderHistory)
  const retryHistory = useStore((state) => state.retryHistory)
  // Below: a session opened at an older entry reads forward the same way.
  const newerCursor = useActiveSessionValue((session) => (session.viewAgent ? null : session.newerCursor)) ?? null
  const newerLoading = useActiveSessionValue((session) => session.newerLoading)
  const newerError = useActiveSessionValue((session) => (session.viewAgent ? null : session.newerError)) ?? null
  const loadNewerHistory = useStore((state) => state.loadNewerHistory)
  const jumpToLatest = useStore((state) => state.jumpToLatest)
  const placement = useActiveSessionValue((session) => (session.viewAgent ? null : session.anchor)) ?? null
  // The placement last carried out, so each request moves the view once.
  const placedRef = useRef<object | null>(null)
  // `newerCursor` as of the last layout: a page that just closed the gap below
  // still came in under the reader.
  const newerRef = useRef<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const newerSentinelRef = useRef<HTMLDivElement>(null)
  // The topmost row when an older page was asked for, by its offset in the
  // scrolled content: only what lands above it moves that, not scrolling.
  const anchorRef = useRef<{ element: Element; offset: number } | null>(null)
  const holdAnchor = useCallback(() => {
    const root = scrollRef.current
    const first = sentinelRef.current?.nextElementSibling
    if (!root || !first) return
    anchorRef.current = { element: first, offset: contentOffset(root, first) }
    // Native scroll anchoring may or may not shift for the same insert (not
    // at scrollTop 0, not in Safari); off until the page lands, so the shift
    // in the layout effect below is the only one.
    root.style.overflowAnchor = 'none'
  }, [])
  const releaseAnchor = useCallback(() => {
    anchorRef.current = null
    if (scrollRef.current) scrollRef.current.style.overflowAnchor = ''
  }, [])

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

  // The next page is fetched as the placeholder above the oldest row nears
  // the viewport. Observed afresh per page: a page too short to push the
  // placeholder away again fetches the one after it straight off. After a
  // failure it waits for the retry button rather than looping on the error.
  useEffect(() => {
    const root = scrollRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel || !activeId || !historyCursor || historyError) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        holdAnchor()
        void loadOlderHistory(activeId)
      },
      { root, rootMargin: '100% 0px 0px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [activeId, historyCursor, historyError, holdAnchor, loadOlderHistory])

  // Below the newest row shown nothing needs anchoring: rows added under the
  // viewport do not move it.
  useEffect(() => {
    const root = scrollRef.current
    const sentinel = newerSentinelRef.current
    if (!root || !sentinel || !activeId || !newerCursor || newerError) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNewerHistory(activeId)
      },
      { root, rootMargin: '0px 0px 100% 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [activeId, newerCursor, newerError, loadNewerHistory])

  const retry = useCallback(() => {
    if (!activeId) return
    // An older page lands above the rows shown; the newest one replaces them.
    if (historyCursor) holdAnchor()
    void retryHistory(activeId)
  }, [activeId, historyCursor, holdAnchor, retryHistory])

  // A page that failed never lands; hand anchoring back to the browser.
  useEffect(() => {
    if (!historyLoading) releaseAnchor()
  }, [historyLoading, releaseAnchor])

  const nodes = transcript?.nodes
  const streaming = transcript?.streaming

  // Streaming coalesces into one scroll per frame: measuring on every token
  // forced a synchronous layout per delta. A swapped node list — session
  // switch, history replay landing — is positioned before paint instead, since
  // a frame later means the browser first draws the whole history at scrollTop
  // 0. `nodes` is a fresh array whenever a node is added *or* mutated, so
  // arriving tool output follows too.
  useLayoutEffect(() => {
    // An older page landed between the placeholder and the anchored row:
    // scroll by exactly what was inserted above it, so the reader's view —
    // wherever they scrolled to meanwhile — stays put.
    const anchor = anchorRef.current
    if (anchor && sentinelRef.current?.nextElementSibling !== anchor.element) {
      const element = scrollRef.current
      if (element && anchor.element.isConnected) element.scrollTop += contentOffset(element, anchor.element) - anchor.offset
      releaseAnchor()
    }

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
    // doing in the session they came from — or where it was sent, again.
    if (switched) {
      followRef.current = true
      placedRef.current = null
    }
    const readingForward = newerRef.current !== null
    newerRef.current = newerCursor
    const element = scrollRef.current
    if (!element) return
    const cancelFrame = (): void => {
      if (frameRef.current === undefined) return
      cancelAnimationFrame(frameRef.current)
      frameRef.current = undefined
    }
    // Sent somewhere — opened at a message, or back to the end: carried out
    // once per request, as soon as the row it names is on screen.
    if (placement && placement !== placedRef.current) {
      const target = placement.id === null ? null : element.querySelector(`[data-uuid="${CSS.escape(placement.id)}"]`)
      if (target || placement.id === null) {
        placedRef.current = placement
        cancelFrame()
        followRef.current = !target
        if (target) {
          target.scrollIntoView({ block: 'center' })
          target.classList.add(styles.userTurnPlaced!)
          target.addEventListener('animationend', () => target.classList.remove(styles.userTurnPlaced!), { once: true })
        } else {
          element.scrollTop = element.scrollHeight
        }
        return
      }
    }
    // Pages read in below the reader — the last one too — are theirs to scroll
    // into: chasing one would skip it and fetch the next. Only where it leaves
    // them says whether they still follow.
    if (!switched && (newerCursor || readingForward)) {
      followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD
      return
    }
    if (!followRef.current) return
    if (swapped) {
      cancelFrame()
      element.scrollTop = element.scrollHeight
      return
    }
    if (frameRef.current !== undefined) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      if (followRef.current) element.scrollTop = element.scrollHeight
    })
  }, [nodes, streaming, pendingPermissions, activeId, viewAgent, placement, newerCursor])

  useEffect(
    () => () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  if (!nodes) return null
  const empty = nodes.length === 0 && !streaming && !historyCursor && !historyError && !newerCursor && !newerError

  return (
    <div className={styles.scroll} ref={scrollRef}>
      <AgentNav />
      {empty ? (
        <div className={styles.empty}>
          <span className={styles.emptyMark}>
            <BrandMark size={24} />
          </span>
          <span>Claude Code</span>
        </div>
      ) : (
        <div className={styles.stream}>
          {(historyCursor || historyError) && (
            <div ref={sentinelRef} className={styles.olderHistory}>
              {historyError ? (
                <>
                  <span className={styles.historyError}>{historyError}</span>
                  <button className={styles.historyRetry} disabled={historyLoading} onClick={retry} type="button">
                    {historyLoading ? '重试中…' : '重试'}
                  </button>
                </>
              ) : historyLoading ? (
                '正在加载更早的消息…'
              ) : (
                '上滑加载更早的消息'
              )}
            </div>
          )}
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
          {(newerCursor || newerError) && (
            <div ref={newerSentinelRef} className={styles.newerHistory}>
              {newerError ? (
                <>
                  <span className={styles.historyError}>{newerError}</span>
                  <button
                    className={styles.historyRetry}
                    disabled={newerLoading}
                    onClick={() => activeId && void loadNewerHistory(activeId)}
                    type="button"
                  >
                    {newerLoading ? '重试中…' : '重试'}
                  </button>
                </>
              ) : newerLoading ? (
                '正在加载更新的消息…'
              ) : (
                '下滑加载更新的消息'
              )}
            </div>
          )}
          {pendingPermissions?.map((request) => (
            <PermissionCard key={request.requestId} request={request} />
          ))}
          {error && <div className={`${styles.row} ${styles.rowError}`}>{error}</div>}
          {newerCursor && (
            <button className={styles.jumpLatest} onClick={() => activeId && void jumpToLatest(activeId)} type="button">
              跳到最新
            </button>
          )}
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
  const messageLink = useStore((state) => state.messageLink)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyLink = (): void => {
    void messageLink(node.id)
      .then((link) => navigator.clipboard.writeText(link))
      .then(
        () => 'copied' as const,
        () => 'failed' as const,
      )
      .then((result) => {
        setCopied(result)
        setTimeout(() => setCopied('idle'), 1400)
      })
  }

  return (
    <>
      <div className={styles.userTurn} data-uuid={node.id}>
        {node.text}
        {node.attachments > 0 && <div className={styles.attachmentNote}>附件 × {node.attachments}</div>}
        <div className={styles.turnActions}>
          <button
            className={`${styles.turnAction} ${copied === 'failed' ? styles.turnActionFailed : ''}`}
            onClick={copyLink}
            type="button"
            title={copied === 'copied' ? '已复制链接' : copied === 'failed' ? '复制失败' : '复制这条消息的链接'}
          >
            {copied === 'copied' ? <CheckIcon size={13} /> : <LinkIcon size={13} />}
          </button>
          <button
            className={styles.turnAction}
            onClick={() => onRewind(node.id)}
            type="button"
            title="把文件回退到这条消息之前的状态"
          >
            <HistoryIcon size={13} />
          </button>
        </div>
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

/** Where `element` sits in the scroller's content, however far it is scrolled. */
function contentOffset(scroller: HTMLElement, element: Element): number {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}
