import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { condense, type CondensedItem, type Step } from '../../render/condense.ts'
import type { AssistantBlock, ChatNode, StreamingBlock } from '../../render/nodes.ts'
import { AGENT_TOOLS, findAgent, lastTurnStart, rowKeys } from '../../render/nodes.ts'
import { WORKFLOW_TOOL } from '../../render/workflows.ts'
import { useActiveSessionValue, useSessionSettled, useStore } from '../../store/session.ts'
import { splitUploadRefs } from '../../utils/attachments.ts'
import { SHOW_REWIND_EVENT } from '../../utils/local-commands.ts'
import { parseQuestions } from '../../utils/questions.ts'
import { splitQuotes, withQuotes } from '../../utils/quotes.ts'
import { turnReplyText } from '../../utils/transcript-markdown.ts'
import { PromptAttachments } from '../attachments/PromptAttachments.tsx'
import { ErrorNotice } from '../ErrorNotice.tsx'
import { ArrowDownIcon, BrandMark, CheckIcon, CopyIcon, HistoryIcon, LinkIcon } from '../Icons.tsx'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import styles from './ChatView.module.css'
import { PermissionCard } from './PermissionCard.tsx'
import { QuestionCard } from './QuestionCard.tsx'
import { QuoteButton } from './QuoteButton.tsx'
import { RewindDialog } from './RewindDialog.tsx'
import { AgentCard } from './AgentCard.tsx'
import { WorkflowCard } from './WorkflowCard.tsx'
import { AgentNav } from './AgentNav.tsx'
import { StepRun, TurnFold } from './CondensedView.tsx'
import { ToolCard } from './ToolCard.tsx'
import { TurnNav } from './TurnNav.tsx'

/** Pixels from the bottom within which we keep following new output. */
const FOLLOW_THRESHOLD = 120

/** Room left above a prompt jumped to, clear of the sticky agent bar. */
const JUMP_MARGIN = 56

export function ChatView(): JSX.Element | null {
  const scrollRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  // Set while the "back to bottom" button's smooth scroll is under way.
  const seekingRef = useRef(false)
  const frameRef = useRef<number | undefined>(undefined)
  // Last session and node count this component scrolled for, to tell a swapped
  // node list apart from a node appended by the running turn.
  const seenRef = useRef<{ id: string | null; count: number }>({ id: null, count: 0 })
  const activeId = useStore((state) => state.activeId)
  // The rewind dialog: at the prompt list for a null id, else at that prompt.
  const [rewind, setRewind] = useState<{ target: string | null } | null>(null)

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
  const running = useActiveSessionValue((session) => session.status === 'running') ?? false
  const settled = useSessionSettled()
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

  const openRewind = useCallback((target: string | null) => setRewind({ target }), [])
  const closeRewind = useCallback(() => setRewind(null), [])

  // Esc Esc in the composer and `/rewind` open it at the list.
  useEffect(() => {
    const onShow = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail
      setRewind({ target: typeof detail === 'string' ? detail : null })
    }
    window.addEventListener(SHOW_REWIND_EVENT, onShow)
    return () => window.removeEventListener(SHOW_REWIND_EVENT, onShow)
  }, [])

  // It is about the session it was opened in.
  useEffect(() => setRewind(null), [activeId])

  // Only auto-scroll while the reader is already at the bottom; yanking the
  // viewport away from someone reading scrollback is the classic chat bug.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    let lastTop = element.scrollTop
    const onScroll = (): void => {
      const top = element.scrollTop
      const near = element.scrollHeight - top - element.clientHeight < FOLLOW_THRESHOLD
      // The smooth scroll back down passes through distances that would read
      // as the reader having left. It is over at the bottom, or as soon as
      // they scroll up themselves.
      if (near || top < lastTop) seekingRef.current = false
      if (!seekingRef.current) followRef.current = near
      lastTop = top
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
  const empty =
    nodes?.length === 0 && !streaming && !historyCursor && !historyError && !newerCursor && !newerError
  const streamShown = nodes !== undefined && !empty
  const newestTurn = useMemo(() => (nodes ? lastTurnStart(nodes) : 0), [nodes])
  const keys = useMemo(() => (nodes ? rowKeys(nodes) : []), [nodes])
  const openSession = useStore((state) => state.openSession)
  // A prompt on screen is scrolled to; one not read in yet is opened at, as a
  // message link would be.
  const jumpTo = useCallback(
    (id: string) => {
      const root = scrollRef.current
      const target = root?.querySelector<HTMLElement>(`[data-uuid="${CSS.escape(id)}"]`)
      if (!root || !target) {
        if (activeId) void openSession(activeId, undefined, id)
        return
      }
      followRef.current = false
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      root.scrollTo({ top: contentOffset(root, target) - JUMP_MARGIN, behavior: reduce ? 'auto' : 'smooth' })
      target.classList.add(styles.userTurnPlaced!)
      target.addEventListener('animationend', () => target.classList.remove(styles.userTurnPlaced!), { once: true })
    },
    [activeId, openSession],
  )
  const chatLayout = useStore((state) => state.chatLayout)
  const condensed = useMemo(
    () => (chatLayout === 'compact' && nodes ? condense(nodes, newestTurn, settled) : null),
    [chatLayout, nodes, newestTurn, settled],
  )
  // The newest turn was cut short: it leaves no result row and no
  // `session_error` either — the process was simply gone — so without this the
  // thread ends on a tool card with nothing saying why.
  const interrupted =
    settled &&
    (nodes?.some((node, index) => index >= newestTurn && node.kind === 'tool' && node.status === 'running') ?? false)

  // The way back down, offered once the newest output is out of following
  // reach. Watched rather than measured on scroll: a session switch or a
  // collapsing card moves the end without any scroll event.
  const bottomRef = useRef<HTMLDivElement>(null)
  const [away, setAway] = useState(false)
  useEffect(() => {
    const root = scrollRef.current
    const sentinel = bottomRef.current
    setAway(false)
    if (!root || !sentinel) return
    const observer = new IntersectionObserver(([entry]) => setAway(!entry!.isIntersecting), {
      root,
      rootMargin: `0px 0px ${FOLLOW_THRESHOLD}px 0px`,
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [streamShown])

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    followRef.current = true
    seekingRef.current = true
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollTo({ top: element.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }, [])

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

  const renderNode = (node: ChatNode, index: number, key: string): JSX.Element =>
    node.kind === 'user' && viewAgent ? (
      // A subagent's prompt came from the parent model, not from a
      // checkpointed user message, so it has nothing to rewind to.
      <div key={key} className={styles.userTurn}>
        <div className={styles.agentPromptLabel}>主代理下达的任务</div>
        {node.text}
      </div>
    ) : node.kind === 'user' ? (
      <UserTurn key={key} node={node} onRewind={openRewind} />
    ) : (
      <NodeView key={key} node={node} settled={settled || index < newestTurn} />
    )

  const renderItem = (item: CondensedItem): JSX.Element => {
    switch (item.type) {
      case 'node':
        return renderNode(nodes[item.index]!, item.index, item.key)
      case 'text':
        return (
          <div key={item.key} className={`${styles.row} ${styles.prose}`}>
            <AssistantMarkdown text={item.text} decodeSerialized />
          </div>
        )
      case 'steps':
        return (
          <div key={item.key} className={runRowClass(item.steps)}>
            <StepRun steps={item.steps} />
          </div>
        )
      case 'fold':
        return (
          <TurnFold key={item.key} label={foldLabel(item)} steps={foldSteps(item.items)}>
            {item.items.map(renderItem)}
          </TurnFold>
        )
    }
  }

  /**
   * The condensed layout draws each turn's output as one block under a single
   * mark, rather than a dot per row: a reply reads as a whole. The block runs
   * from one prompt to the next; the newest takes the reply still streaming.
   */
  const renderTurns = (items: CondensedItem[], tail: JSX.Element | null): JSX.Element[] => {
    const out: JSX.Element[] = []
    let turn: JSX.Element[] = []
    let turnKey = 'start'
    const close = (last: boolean): void => {
      if (turn.length === 0 && !(last && tail)) return
      out.push(
        <div key={`turn:${turnKey}`} className={`${styles.turn} ${last && running ? styles.turnLive : ''}`}>
          <span className={styles.turnMark} aria-hidden="true">
            <BrandMark size={14} />
          </span>
          <div className={styles.turnBody}>
            {turn}
            {last && tail}
          </div>
        </div>,
      )
      turn = []
    }
    for (const item of items) {
      if (item.type === 'node' && nodes[item.index]!.kind === 'user') {
        close(false)
        out.push(renderItem(item))
        turnKey = item.key
      } else {
        turn.push(renderItem(item))
      }
    }
    close(true)
    return out
  }

  // At the end of the newest turn, unless an older stretch is shown and the
  // newer messages are still to load between the two.
  const streamingRow = streaming ? <StreamingRow block={streaming} /> : null
  const streamingInTurn = condensed !== null && !newerCursor && !newerError
  const cards = pendingPermissions?.map((request) => {
    const questions = request.toolName === 'AskUserQuestion' ? parseQuestions(request.input) : null
    return questions ? (
      <QuestionCard key={request.requestId} request={request} questions={questions} />
    ) : (
      <PermissionCard key={request.requestId} request={request} />
    )
  })

  return (
    <div className={styles.pane}>
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
          <div className={condensed ? `${styles.stream} ${styles.condensed}` : styles.stream} ref={streamRef}>
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
            {condensed
              ? renderTurns(condensed, streamingInTurn ? streamingRow : null)
              : nodes.map((node, index) => renderNode(node, index, keys[index]!))}
            {!streamingInTurn && streamingRow}
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
            {/* Its own block, child of the stream, so on a phone it can stay
                pinned over the composer however far back the thread is read. */}
            {((cards?.length ?? 0) > 0 || interrupted || Boolean(error)) && (
              <div className={styles.pending}>
                {cards}
                {interrupted && (
                  <div className={`${styles.row} ${styles.rowMuted}`}>
                    <div className={styles.notice}>会话进程已退出，这一轮没有跑完。上面标记为「已中断」的工具不会再有结果。</div>
                  </div>
                )}
                {error && (
                  <div className={styles.errorRow}>
                    <ErrorNotice text={error} />
                  </div>
                )}
              </div>
            )}
            {newerCursor && (
              <button className={styles.jumpLatest} onClick={() => activeId && void jumpToLatest(activeId)} type="button">
                跳到最新
              </button>
            )}
            {/* An older stretch has 跳到最新 above instead: its end is not the latest. */}
            {away && !newerCursor && (
              <div className={styles.toBottomDock}>
                <button
                  className={styles.toBottom}
                  onClick={scrollToBottom}
                  type="button"
                  title={running ? '正在回复，回到底部' : '回到底部'}
                  aria-label={running ? '正在回复，回到底部' : '回到底部'}
                >
                  {running ? (
                    <span className={styles.toBottomDots}>
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    <ArrowDownIcon size={16} />
                  )}
                </button>
              </div>
            )}
            <div ref={bottomRef} />
            {/* Last, so showing it never changes which row is :first-child. */}
            <QuoteButton scrollRef={scrollRef} streamRef={streamRef} />
          </div>
        )}
      </div>
      {/* A subagent's conversation has the one prompt. */}
      {!viewAgent && <TurnNav scrollRef={scrollRef} onJump={jumpTo} />}
      {rewind && <RewindDialog target={rewind.target} onClose={closeRewind} />}
    </div>
  )
}

const UserTurn = memo(function UserTurn({
  node,
  onRewind,
}: {
  node: Extract<ChatNode, { kind: 'user' }>
  onRewind: (nodeId: string) => void
}): JSX.Element {
  const messageLink = useStore((state) => state.messageLink)
  const cwd = useActiveSessionValue((session) => session.cwd)
  const { quotes, body, refs } = useMemo(() => {
    const { quotes, body } = splitQuotes(node.text)
    return { quotes, ...splitUploadRefs(body) }
  }, [node.text])
  // What the bubble reads as text: its quotes stay Markdown, the upload paths are left out.
  const text = withQuotes(quotes, body).trim()
  // Inline documents (PDFs from before uploads) have no tile to show.
  const documents = node.attachments - (node.images?.length ?? 0)
  const [copiedText, setCopiedText] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyText = (): void => {
    void navigator.clipboard
      .writeText(text)
      .then(
        () => 'copied' as const,
        () => 'failed' as const,
      )
      .then((result) => {
        setCopiedText(result)
        setTimeout(() => setCopiedText('idle'), 1400)
      })
  }
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
    <div className={styles.userTurn} data-uuid={node.id}>
      {quotes.map((quote, index) => (
        <blockquote key={index} className={styles.userQuote}>
          {quote}
        </blockquote>
      ))}
      <PromptAttachments images={node.images} refs={refs} cwd={cwd} spaced={body !== ''} />
      {body}
      {documents > 0 && <div className={styles.attachmentNote}>附件 × {documents}</div>}
      <div className={styles.turnActions}>
        {text && (
          <button
            className={`${styles.turnAction} ${copiedText === 'failed' ? styles.turnActionFailed : ''}`}
            onClick={copyText}
            type="button"
            title={copiedText === 'copied' ? '已复制' : copiedText === 'failed' ? '复制失败' : '复制这条消息'}
          >
            {copiedText === 'copied' ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          </button>
        )}
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
          title="回退到这条消息之前（代码和/或对话）"
        >
          <HistoryIcon size={13} />
        </button>
      </div>
    </div>
  )
})

const NodeView = memo(function NodeView({
  node,
  settled,
}: {
  node: Exclude<ChatNode, { kind: 'user' }>
  settled: boolean
}): JSX.Element | null {
  switch (node.kind) {
    case 'assistant':
      return (
        <div className={`${styles.row} ${styles.prose}`}>
          {node.blocks.map((block, index) => (
            <BlockView key={index} block={block} />
          ))}
        </div>
      )

    case 'tool': {
      // The call outlived whatever could have finished it: no pulsing dot, and
      // each card reads itself as stopped rather than still working.
      const stale = node.status === 'running' && settled
      return (
        <div
          className={[
            styles.row,
            node.status === 'running' && !stale ? styles.rowPending : '',
            stale ? styles.rowMuted : '',
            node.status === 'error' ? styles.rowError : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {AGENT_TOOLS.has(node.name) ? (
            <AgentCard node={node} stale={stale} />
          ) : node.name === WORKFLOW_TOOL ? (
            <WorkflowCard node={node} stale={stale} />
          ) : (
            <ToolCard node={node} stale={stale} />
          )}
        </div>
      )
    }

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
      return <CompactRow node={node} />

    case 'result':
      return <ResultRow node={node} />
  }
})

/** A finished turn's footer: `/copy` for its reply, then the figures the CLI reported for it. */
function ResultRow({ node }: { node: Extract<ChatNode, { kind: 'result' }> }): JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyReply = (): void => {
    // Read on click rather than subscribed to: the row would otherwise
    // re-render with every node the transcript gains.
    const { activeId, sessions } = useStore.getState()
    const nodes = activeId ? (sessions[activeId]?.transcript.nodes ?? []) : []
    const index = nodes.findIndex((entry) => entry.id === node.id)
    const text = index < 0 ? null : turnReplyText(nodes, index)
    void (text ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no reply')))
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
    <div className={`${styles.stats} ${node.isError ? styles.statsError : ''}`}>
      <button
        className={`${styles.turnAction} ${copied === 'failed' ? styles.turnActionFailed : ''}`}
        onClick={copyReply}
        type="button"
        title={copied === 'copied' ? '已复制' : copied === 'failed' ? '这一轮没有可复制的回复' : '复制这一轮的回复'}
      >
        {copied === 'copied' ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
      <span>{formatDuration(node.durationMs)}</span>
      {/* The condensed layout shows these on hovering the turn: the time is the figure read every turn. */}
      <span className={styles.statsFull}>
        <span>{node.numTurns} 轮</span>
        <span>
          输入 {formatTokens(node.inputTokens)} · 输出 {formatTokens(node.outputTokens)}
        </span>
        {node.cacheReadTokens > 0 && <span>缓存命中 {formatTokens(node.cacheReadTokens)}</span>}
      </span>
    </div>
  )
}

function BlockView({ block }: { block: AssistantBlock }): JSX.Element {
  return block.type === 'thinking' ? <ReasoningRow text={block.text} /> : <AssistantMarkdown text={block.text} decodeSerialized />
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

/** The divider opens to the summary the model carried on from. */
function CompactRow({ node }: { node: Extract<ChatNode, { kind: 'compact' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const label =
    node.preTokens === undefined
      ? '上下文已压缩'
      : `上下文已压缩（${node.trigger === 'auto' ? '自动' : '手动'}，${formatTokens(node.preTokens)}${
          node.postTokens !== undefined ? ` → ${formatTokens(node.postTokens)}` : ''
        }）`

  return (
    <>
      <div className={styles.compact}>
        {node.summary ? (
          <button className={styles.compactToggle} onClick={() => setOpen(!open)} type="button">
            <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`}>▶</span>
            {label}
          </button>
        ) : (
          label
        )}
      </div>
      {open && node.summary && (
        <div className={styles.compactSummary}>
          <AssistantMarkdown text={node.summary} />
        </div>
      )}
    </>
  )
}

function StreamingRow({ block }: { block: StreamingBlock }): JSX.Element {
  return (
    <div className={`${styles.row} ${styles.rowPending} ${styles.prose}`}>
      {block.type === 'thinking' ? (
        <ReasoningRow text={block.text} live />
      ) : (
        <>
          <AssistantMarkdown text={block.text} decodeSerialized />
          <span className={styles.cursor} />
        </>
      )}
    </div>
  )
}

/** A run's bullet, as the detailed view colours a lone card. */
function runRowClass(steps: Step[]): string {
  const tools = steps.flatMap((step) => (step.kind === 'tool' ? [step] : []))
  const state = tools.some((step) => step.node.status === 'running' && !step.stale)
    ? styles.rowPending
    : tools.some((step) => step.node.status === 'error')
      ? styles.rowError
      : tools.some((step) => step.stale)
        ? styles.rowMuted
        : ''
  return state ? `${styles.row} ${state}` : styles.row!
}

/** Every step folded away, through the runs between its texts. */
function foldSteps(items: CondensedItem[]): Step[] {
  return items.flatMap((item) => (item.type === 'steps' ? item.steps : item.type === 'fold' ? foldSteps(item.items) : []))
}

function foldLabel(fold: Extract<CondensedItem, { type: 'fold' }>): string {
  if (fold.durationMs === null) return '已结束'
  return `${fold.outcome === 'error' ? '出错结束' : '已完成'}，用时 ${formatDuration(fold.durationMs)}`
}

/** Where `element` sits in the scroller's content, however far it is scrolled. */
function contentOffset(scroller: HTMLElement, element: Element): number {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

/** Whole seconds, as the terminal's "Worked for 1m 47s" reads. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}
