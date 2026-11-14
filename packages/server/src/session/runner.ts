import { randomUUID } from 'node:crypto'

import {
  getSessionInfo,
  query,
  type AccountInfo,
  type McpServerStatus,
  type Query,
  type RewindFilesResult,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import { applyTurnProgress, startTurnProgress } from '@ccw/shared'
import type {
  Attachment,
  ContextUsage,
  EffortLevel,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PluginAction,
  PluginInfo,
  ServerEvent,
  SessionConfig,
  SessionFlags,
  SessionStatus,
  SessionSummary,
  SkillInfo,
  SkillState,
  TurnProgress,
  UsageReport,
} from '@ccw/shared'

import { cliEnv, resolveClaudeExecutable } from '../config.ts'
import { editSkillState, listPlugins, runPluginAction } from './extensions.ts'
import { InputQueue } from './input-queue.ts'
import { SessionModels } from './models.ts'
import { PermissionBroker } from './permission.ts'
import { runShellCommand } from './shell.ts'

type MessageParam = SDKUserMessage['message']
type ContentBlocks = Extract<MessageParam['content'], readonly unknown[]>

/** `generateSessionTitle` ships on `Query` (SDK 0.3.312) but is missing from its typings. */
type TitleQuery = Query & {
  generateSessionTitle?: (description: string, options?: { persist?: boolean }) => Promise<string | null | undefined>
}

export type EmitEvent = (event: ServerEvent) => void

/**
 * What a runner starts from. `resumeSessionAt`, with `resume`, loads the
 * conversation only up to that transcript entry: a rewind's cut, which the
 * server sets, never the browser.
 */
export type RunnerConfig = SessionConfig & { resumeSessionAt?: string }

/** Backlog cap — a runaway turn with hundreds of tool calls must not grow memory unbounded. */
const BACKLOG_LIMIT = 500

/** How often the transcript is re-read for the CLI's AI title while a turn runs without one. */
const TITLE_POLL_MS = 2000

/**
 * One WebUI session backed by one SDK `Query`, which in turn owns one Claude
 * Code subprocess. Prompts go in through {@link send}; everything the CLI
 * emits is broadcast verbatim as `sdk` events so the browser can render from
 * the same structured stream the TUI renders from.
 */
export class SessionRunner {
  /** Moves to the CLI's new conversation when it resets this one; see {@link #reset}. */
  #sessionId: string
  readonly config: RunnerConfig

  readonly #input = new InputQueue<SDKUserMessage>()
  readonly #permissions = new PermissionBroker((requestId) => {
    this.#emit({ type: 'permission_resolved', sessionId: this.sessionId, requestId })
    this.#announceState()
  })
  readonly #emit: EmitEvent
  readonly #query: Query
  readonly #models: SessionModels
  /** Settles once the CLI has exited and the last frame is out; see {@link shutdown}. */
  readonly #exited: Promise<void>
  #done = false
  #status: SessionStatus = 'idle'
  #turnProgress: TurnProgress | null = null
  /** `running` and `waiting` as the sidebars last heard them; see {@link #announceState}. */
  #announced = { running: false, waiting: false }
  /** Set by {@link interrupt} so the aborted turn's trailing frames cannot revive `running`. */
  #interrupted = false
  /** Surviving queued work opens at its init, never from aborted tail frames. */
  #queuedAfterInterrupt = false
  #interruptVersion = 0
  #interruptedResultSeen = false
  /** Candidate new-turn frames held until the interrupt receipt confirms queued work. */
  #queuedTurnBeforeReceipt: { progress: TurnProgress | null } | null = null
  readonly #backlog: SDKMessage[] = []
  #summary: SessionSummary
  /** The conversation was on disk before this runner: its title, if any, is already there. */
  #resumed: boolean
  /** A `conversation_reset` arrived and the frames have not named the new session yet. */
  #resetting = false
  /** The mode as the CLI last reported it; see {@link permissionMode}. */
  #permissionMode: PermissionMode
  /** Re-reads the transcript for the CLI's AI title; see {@link #watchTitle}. */
  #titleTimer: ReturnType<typeof setInterval> | undefined
  /** Set while a {@link #requestTitle} call is out, so a quick second prompt does not ask again. */
  #titling = false

  constructor(config: RunnerConfig, emit: EmitEvent, queryFactory: typeof query = query) {
    this.config = config
    this.#emit = emit
    this.#permissionMode = config.permissionMode ?? 'default'
    // The id is fixed before the CLI starts so the browser can register the
    // session first and never miss the `init` event. Resuming reuses the
    // existing transcript's id.
    this.#sessionId = config.resume ?? config.sessionId ?? randomUUID()
    this.#resumed = config.resume !== undefined
    this.#summary = {
      sessionId: this.sessionId,
      cwd: config.cwd,
      summary: '',
      // Merely reopening history must not promote it above newer messages.
      lastModified: config.resume ? 0 : Date.now(),
      live: true,
    }

    this.#query = queryFactory({
      prompt: this.#input,
      options: {
        cwd: config.cwd,
        ...(config.resume
          ? { resume: config.resume, ...(config.resumeSessionAt ? { resumeSessionAt: config.resumeSessionAt } : {}) }
          : { sessionId: this.sessionId }),
        ...(config.model ? { model: config.model } : {}),
        permissionMode: config.permissionMode ?? 'default',
        // Required before `bypassPermissions` can be selected at all; the
        // Modes popover exposes it, and the server is loopback-only.
        allowDangerouslySkipPermissions: true,
        // Without this the session does NOT get Claude Code's own system
        // prompt and behaves differently from the terminal.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        // Without it a subagent forwards only its tool calls: enough for a
        // heartbeat, not for the conversation the browser lets you open.
        forwardSubagentText: true,
        enableFileCheckpointing: true,
        // Thinking display defaults to 'omitted' on Opus 5 / 4.8 / 4.7 /
        // Sonnet 5 — the blocks stream with empty text unless asked for.
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(resolveClaudeExecutable() ? { pathToClaudeCodeExecutable: resolveClaudeExecutable()! } : {}),
        env: cliEnv(),
        canUseTool: async (toolName, input, options) => {
          const request: PermissionRequest = {
            requestId: options.requestId,
            toolUseId: options.toolUseID,
            toolName,
            input,
            title: options.title,
            displayName: options.displayName,
            description: options.description,
            suggestions: options.suggestions,
            blockedPath: options.blockedPath,
            decisionReason: options.decisionReason,
            agentId: options.agentID,
          }
          this.#emit({ type: 'permission_request', sessionId: this.sessionId, request })
          const decision = this.#permissions.await(request, options.signal)
          this.#announceState()
          return decision
        },
        stderr: (data) => {
          process.stderr.write(`[cli ${this.sessionId.slice(0, 8)}] ${data}`)
        },
      },
    })

    this.#models = new SessionModels(this.#query, config.cwd, config.model, {
      canRefresh: () => !this.#done && this.#status === 'idle' && this.pendingPermissions.length === 0,
      onChange: (snapshot) => this.#emit({ type: 'session_models', sessionId: this.sessionId, ...snapshot }),
    })
    this.#exited = this.#pump()
    // Failure here means the CLI died before the flag landed; #pump already
    // reports that, and an escaped rejection would crash the whole server.
    const initial: { effortLevel?: EffortLevel; ultracode?: boolean } = {}
    if (config.effort) initial.effortLevel = config.effort
    if (config.ultracode !== undefined) initial.ultracode = config.ultracode
    if (Object.keys(initial).length > 0) {
      this.#flags = { ...this.#flags, effort: config.effort ?? null, ultracode: config.ultracode ?? false }
      this.#query
        .applyFlagSettings(initial)
        .then(() => this.#publishFlags())
        .catch(() => {})
    }
  }

  /**
   * Effort and ultracode as the CLI last reported them, or as last asked of
   * it. An effort change carries ultracode from here, and {@link flags}
   * answers from here when the CLI cannot be asked.
   */
  #flags: SessionFlags = { effort: null, ultracode: false, ultracodeAvailable: false }

  /** Set by {@link send} for a typed `/model`, which the CLI handles without telling {@link SessionModels}. */
  #modelCommand = false

  /** Drains the SDK's message stream onto the downlink until the CLI exits. */
  async #pump(): Promise<void> {
    try {
      for await (const message of this.#query) {
        // Not a frame for the browser: it says the session is about to move.
        // Where to is the session id on the frames after it — CLI 2.1.316
        // fills `new_conversation_id` with the frame's own uuid, which names
        // no transcript.
        const source = message as { parent_tool_use_id?: string | null; agent_id?: string }
        const mainThread = !source.agent_id && (message.type === 'tool_progress' || !source.parent_tool_use_id)
        if (message.type === 'conversation_reset' && mainThread) {
          this.#resetting = true
          this.#queuedTurnBeforeReceipt = null
          this.#setTurnProgress(null)
          continue
        }
        const frameSession = (message as { session_id?: string }).session_id
        if (this.#resetting && frameSession && frameSession !== this.#sessionId) {
          this.#resetting = false
          this.#reset(frameSession)
        }
        // Tracked here as well as in the browser: a page that reloads mid-turn
        // has no way to tell a working session from a finished one otherwise.
        //
        // `send` opening the turn is what actually drives this — CLI 2.1.237
        // never emits `session_state_changed`, so the branch below is only a
        // more precise signal if a later version starts sending it.
        if (mainThread && this.#interrupted && this.#interruptedResultSeen && !this.#queuedAfterInterrupt) {
          // A queued turn can stream before the control receipt returns. Keep
          // its actual clock/retry privately; metadata/tails alone cannot revive
          // the stopped UI until that receipt confirms surviving queued work.
          if (message.type === 'system' && message.subtype === 'init') {
            this.#queuedTurnBeforeReceipt = { progress: startTurnProgress(Date.now()) }
          } else if (this.#queuedTurnBeforeReceipt?.progress) {
            this.#queuedTurnBeforeReceipt.progress = applyTurnProgress(this.#queuedTurnBeforeReceipt.progress, message, Date.now())
          }
        }
        if (mainThread && message.type === 'system' && message.subtype === 'init' && this.#queuedAfterInterrupt) {
          this.#queuedAfterInterrupt = false
          this.#interrupted = false
          this.#status = 'running'
        }
        if (mainThread && message.type === 'system' && message.subtype === 'session_state_changed' && !this.#interrupted) {
          // A permission/question holds the running turn; it is not completion.
          this.#status = message.state === 'idle' ? 'idle' : 'running'
        }
        // Every turn's `init` carries the mode, and a `status` follows each switch.
        if (message.type === 'system' && (message.subtype === 'init' || message.subtype === 'status') && message.permissionMode) {
          this.#permissionMode = message.permissionMode
        }
        const interruptedTail = this.#interrupted && this.#queuedAfterInterrupt
        if (message.type === 'result' && mainThread) {
          if (this.#interrupted) this.#interruptedResultSeen = true
          if (!interruptedTail) this.#status = 'idle'
          // Keep the interrupt latch through result: trailing aborted frames
          // cannot reopen a stopped turn. A new send or queued init releases it.
          // The browser re-reads transcripts on this result, which picks up a title
          // written by now; one written later is caught by the next turn's watch.
          this.#unwatchTitle()
          // The switch has landed by the next result even when the command
          // was queued behind a running turn (CLI 2.1.304).
          if (this.#modelCommand) {
            this.#modelCommand = false
            void this.#models.follow().then(() => this.#publishFlags()).catch(() => {})
          }
        }
        // A turn the CLI started on its own — a prompt it had queued behind the
        // one that just ended — is otherwise invisible: without
        // `session_state_changed` nothing would move the status off `idle`, and
        // the browser would offer no way to stop it. Only top-level assistant
        // output counts: a sub-agent's messages carry a `parent_tool_use_id`
        // and can still arrive while the parent turn is being torn down. Frames
        // an interrupted turn had already emitted are skipped for the same
        // reason — Stop must not bounce back to `running`.
        else if (message.type === 'assistant' && mainThread && !this.#interrupted && !message.aborted && !message.error && message.message.model !== '<synthetic>') {
          this.#status = 'running'
        }
        if (mainThread && !interruptedTail && (!this.#interrupted || message.type === 'result')) {
          // Startup init is metadata, not a turn. No server retry timer exists:
          // all phase/retry changes come from the CLI's structured events.
          if (!(message.type === 'system' && message.subtype === 'init' && this.#status === 'idle')) {
            const now = Date.now()
            this.#setTurnProgress(applyTurnProgress(this.#turnProgress, message, now), now)
            if (this.#turnProgress !== null) this.#status = 'running'
          }
        }
        // Clock/phase authority reaches every tab before its corresponding SDK frame.
        this.#trackBacklog(message)
        this.#emit({ type: 'sdk', sessionId: this.sessionId, message })
        this.#announceState()
      }
    } catch (error) {
      this.#status = 'idle'
      this.#setTurnProgress(null)
      this.#emit({
        type: 'session_error',
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.#done = true
      this.#status = 'idle'
      this.#setTurnProgress(null)
      this.#unwatchTitle()
      for (const requestId of this.#permissions.drain()) {
        this.#emit({ type: 'permission_resolved', sessionId: this.sessionId, requestId })
      }
      this.#emit({ type: 'session_closed', sessionId: this.sessionId })
    }
  }

  /**
   * The CLI went on in a fresh conversation, saved under a new id — `/clear`
   * or one of its aliases, or leaving plan mode with a cleared context — as
   * the terminal does, in the same process. The runner follows it: later
   * frames, title reads and a resume after a restart all name the new one,
   * and the old one stays on disk as history. The manager files the runner
   * under the new id and the browsers move over on `session_reset`.
   */
  #reset(next: string): void {
    const previous = this.#sessionId
    if (next === previous) return
    this.#sessionId = next
    this.#resumed = false
    // What streamed so far belongs to the conversation left behind.
    this.#backlog.length = 0
    this.#unwatchTitle()
    this.#summary = { sessionId: next, cwd: this.config.cwd, summary: '', lastModified: Date.now(), live: true }
    this.#emit({ type: 'session_reset', sessionId: previous, newSessionId: next, summary: this.summary })
    if (this.#status === 'running' && !this.#interrupted) this.#setTurnProgress(startTurnProgress(Date.now()))
  }

  /**
   * Retains the in-flight turn's messages for a browser that reloads mid-turn:
   * the CLI flushes the jsonl lazily, so the history read alone misses what
   * already streamed. Cleared when the turn ends — from there the transcript
   * catches up, and `session.state` payloads stay small.
   */
  #trackBacklog(message: SDKMessage): void {
    const source = message as { parent_tool_use_id?: string | null; agent_id?: string }
    const mainThread = !source.agent_id && !source.parent_tool_use_id
    const turnEnded = mainThread && (
      message.type === 'result' ||
      (message.type === 'system' && message.subtype === 'session_state_changed' && message.state === 'idle')
    )
    if (turnEnded) {
      this.#backlog.length = 0
      return
    }
    // Only what the renderer rebuilds from: stream_event (one per delta) and
    // tool_progress (one per second) would flood the ring for no benefit.
    if (this.#status !== 'running' || this.#interrupted) return
    if (message.type !== 'assistant' && message.type !== 'user' && message.type !== 'system') return
    this.#backlog.push(message)
    if (this.#backlog.length > BACKLOG_LIMIT) this.#backlog.shift()
  }

  /**
   * The CLI names an untitled session with a Haiku call made when its first
   * prompt lands, and appends the title to the transcript. The SDK stream never
   * reports that write, and the browser only re-reads transcripts when a turn
   * ends, so a long first turn would keep the prompt as the title. Reading one
   * transcript's head and tail is cheap, so re-read it until the title shows or
   * the turn ends.
   */
  #watchTitle(): void {
    if (this.#done || this.#titleTimer || this.#summary.customTitle) return
    this.#titleTimer = setInterval(() => void this.#readTitle(), TITLE_POLL_MS)
  }

  #unwatchTitle(): void {
    clearInterval(this.#titleTimer)
    this.#titleTimer = undefined
  }

  async #readTitle(): Promise<void> {
    const sessionId = this.#sessionId
    const info = await getSessionInfo(sessionId, { dir: this.config.cwd }).catch(() => undefined)
    // A reset meanwhile: that title is the old conversation's.
    if (sessionId === this.#sessionId) this.#applyTitle(info?.customTitle)
  }

  /**
   * Asks the CLI to name the session from this prompt and to write the name
   * to the transcript. The automatic naming {@link #watchTitle} waits for is
   * switched off in SDK sessions when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
   * is set, though the terminal still names its sessions; an explicit request
   * goes through regardless. When the automatic call is already out, the CLI
   * hands back its result instead of making a second one. A prompt under ten
   * characters or a slash command yields no title, so the next prompt tries
   * again, as in the terminal. Resumed sessions are left alone: their name, if
   * any, is already on disk.
   */
  #requestTitle(text: string): void {
    if (this.#resumed || this.#titling || this.#summary.customTitle) return
    const query = this.#query as TitleQuery
    if (!query.generateSessionTitle) return
    this.#titling = true
    const sessionId = this.#sessionId
    // A CLI too old to know the request rejects it; the watch still covers it.
    query
      .generateSessionTitle(text, { persist: true })
      .then((title) => {
        if (sessionId === this.#sessionId) this.#applyTitle(title ?? undefined)
      })
      .catch(() => {})
      .finally(() => {
        this.#titling = false
      })
  }

  #applyTitle(title: string | undefined): void {
    // A read or request still in flight when the session closes must not announce anything.
    if (this.#done || !title || title === this.#summary.customTitle) return
    this.#summary.customTitle = title
    this.#summary.summary = title
    this.#unwatchTitle()
    this.#publish()
  }

  get sessionId(): string {
    return this.#sessionId
  }

  get done(): boolean {
    return this.#done
  }

  /** Whether a turn is in flight right now, as the CLI last reported it. */
  get status(): SessionStatus {
    return this.#status
  }

  /** Server-owned clock/phase, never reconstructed from a reconnect backlog. */
  get turnProgress(): TurnProgress | null {
    return this.#turnProgress
  }

  /** Re-read after await: #pump can replace this field while a control request is pending. */
  #queuedTurnSnapshot(): { progress: TurnProgress | null } | null {
    return this.#queuedTurnBeforeReceipt
  }

  #setTurnProgress(progress: TurnProgress | null, serverNow = Date.now()): void {
    if (progress === this.#turnProgress) return
    this.#turnProgress = progress
    this.#emit({ type: 'turn_progress', sessionId: this.sessionId, progress, serverNow })
  }

  /** Permission prompts still open, for a browser that reconnected. */
  get pendingPermissions(): PermissionRequest[] {
    return this.#permissions.list()
  }

  /** The in-flight turn's messages, for the same reconnecting browser; see {@link #trackBacklog}. */
  get backlog(): SDKMessage[] {
    return [...this.#backlog]
  }

  /**
   * The mode the next message runs in. One CLI serves every tab, so a switch
   * made in one is the mode for all; a browser that (re)connects reads it here.
   */
  get permissionMode(): PermissionMode {
    return this.#permissionMode
  }

  get summary(): SessionSummary {
    return { ...this.#summary, running: this.#status === 'running', waiting: this.pendingPermissions.length > 0 }
  }

  /**
   * Tells every sidebar when a turn starts or ends, or a prompt opens or
   * closes — so a session in the background says whether it is done without
   * being opened. Called wherever either can change; publishes only a change.
   */
  #announceState(): void {
    if (this.#done) return
    const { running, waiting } = this.summary
    if (running !== this.#announced.running || waiting !== this.#announced.waiting) this.#publish()
  }

  #publish(): void {
    const summary = this.summary
    this.#announced = { running: summary.running === true, waiting: summary.waiting === true }
    this.#emit({ type: 'session_updated', sessionId: this.sessionId, summary })
  }

  /**
   * `uuid` becomes the prompt's id in the transcript and the key of the file
   * checkpoint taken before it: the CLI keeps a stream-json client's own id.
   */
  async send(text: string, attachments?: Attachment[], uuid?: string): Promise<void> {
    // Build before the status flips: `buildContent` validates the attachments
    // and throws, which would otherwise leave `running` set with no turn to
    // ever clear it — the browser would show Stop for a turn that never began.
    const content = buildContent(text, attachments)
    if (uuid !== undefined && !UUID.test(uuid)) throw new Error('uuid must be a UUID')
    await this.#models.withCurrentSettings(() => {
      this.#input.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: this.sessionId,
        ...(uuid ? { uuid: uuid as NonNullable<SDKUserMessage['uuid']> } : {}),
      })
      this.#interruptVersion += 1
      // Folded/queued prompts do not restart this turn's clock or erase retry.
      if (this.#status !== 'running' || this.#turnProgress === null) this.#setTurnProgress(startTurnProgress(Date.now()))
      this.#status = 'running'
      // A post-Stop send owns a new clock, but the old turn can still deliver
      // result/data tails. Keep the latch until this prompt's CLI init; it also
      // makes the old result unable to erase the new progress/Stop button.
      this.#queuedAfterInterrupt = this.#interrupted
      this.#queuedTurnBeforeReceipt = null
      if (/^\/model(?:\s|$)/.test(text.trim())) this.#modelCommand = true
      this.#summary.lastModified = Date.now()
      if (!this.#resumed && !this.#summary.firstPrompt) {
        this.#summary.firstPrompt = text.trim().slice(0, 2000) || '附件消息'
        this.#summary.summary = this.#summary.firstPrompt.replace(/\s+/g, ' ').slice(0, 160)
      }
      this.#watchTitle()
      this.#requestTitle(text)
      this.#publish()
    })
  }

  async interrupt(): Promise<void> {
    // Drop prompts the SDK has not pulled yet, so Stop cannot be followed by
    // one of them opening a fresh turn.
    this.#input.drain()
    // Frames the aborted turn had already emitted are still on their way; the
    // latch survives its result until a new send or surviving queued init, so
    // even late tail frames cannot undo the status set below.
    const version = ++this.#interruptVersion
    this.#interrupted = true
    this.#queuedAfterInterrupt = false
    this.#interruptedResultSeen = false
    this.#queuedTurnBeforeReceipt = null
    this.#status = 'idle'
    this.#backlog.length = 0
    this.#setTurnProgress(null)
    this.#announceState()
    const receipt = await this.#query.interrupt()
    // A newer send/stop/close owns state now; an old receipt cannot overwrite it.
    if (this.#done || this.#input.closed || version !== this.#interruptVersion) return
    // Prompts the CLI had already queued survive the abort — `interrupt()` in
    // SDK 0.3.238 cannot cancel them — and each one opens a turn of its own,
    // so the browser must keep showing Stop.
    this.#queuedAfterInterrupt = (receipt?.still_queued?.length ?? 0) > 0
    this.#status = this.#queuedAfterInterrupt ? 'running' : 'idle'
    if (this.#queuedAfterInterrupt) {
      const candidate = this.#queuedTurnSnapshot()
      if (candidate) {
        this.#queuedAfterInterrupt = false
        this.#interrupted = false
        this.#status = candidate.progress ? 'running' : 'idle'
        this.#setTurnProgress(candidate.progress)
      } else {
        this.#setTurnProgress(startTurnProgress(Date.now()))
      }
    }
    this.#queuedTurnBeforeReceipt = null
    this.#announceState()
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#query.setPermissionMode(mode)
    this.#permissionMode = mode
  }

  async setModel(model?: string): Promise<void> {
    await this.#models.select(model)
    // Availability follows the model (ultracode needs one that supports it).
    await this.#publishFlags().catch(() => {})
  }

  /**
   * On CLI 2.1.29x an `effortLevel` sent without an `ultracode` key also turns
   * ultracode off, so the current state rides along: the two are independent
   * controls in the UI.
   */
  async setEffort(effort: EffortLevel): Promise<void> {
    await this.#query.applyFlagSettings({ effortLevel: effort, ...(this.#flags.ultracode ? { ultracode: true } : {}) })
    this.#flags = { ...this.#flags, effort }
    await this.#publishFlags()
  }

  async setUltracode(on: boolean): Promise<SessionFlags> {
    await this.#query.applyFlagSettings({ ultracode: on })
    this.#flags = { ...this.#flags, ultracode: on }
    return this.#publishFlags()
  }

  /**
   * `getSettings` exists on the SDK's Query at runtime but is not in its
   * typings (0.3.238 through 0.3.322); `applied` is what the next request
   * will really carry. An SDK without the method, or a CLI that rejects the
   * request, leaves the flags as last read or set: they still apply, and
   * only cannot be read back.
   */
  async flags(): Promise<SessionFlags> {
    const { getSettings } = this.#query as Query & { getSettings?: () => Promise<unknown> }
    if (typeof getSettings !== 'function') return this.#flags
    try {
      const { applied = {} } = (await getSettings.call(this.#query)) as {
        applied?: { effort?: EffortLevel | null; ultracode?: boolean; ultracodeAvailable?: boolean }
      }
      this.#flags = {
        effort: applied.effort ?? null,
        ultracode: applied.ultracode === true,
        ultracodeAvailable: applied.ultracodeAvailable === true,
      }
    } catch {
      // What is known stands.
    }
    return this.#flags
  }

  async #publishFlags(): Promise<SessionFlags> {
    const flags = await this.flags()
    this.#emit({ type: 'session_flags', sessionId: this.sessionId, ...flags })
    return flags
  }

  async commands(): Promise<SlashCommand[]> {
    return this.#query.supportedCommands()
  }

  models(): ReturnType<SessionModels['list']> {
    return this.#models.list()
  }

  /** The same breakdown the terminal's `/context` command renders. */
  async contextUsage(): Promise<ContextUsage> {
    return this.#query.getContextUsage()
  }

  /**
   * The terminal's `/usage`. The SDK marks the request experimental and will
   * rename it once it settles, so this is the one place that names it. Plan
   * quotas come from the rate-limit headers of the CLI's own API calls when the
   * claude.ai usage endpoint does not answer, so they can be null before the
   * first turn.
   */
  async usage(behaviors: boolean): Promise<UsageReport> {
    return this.#query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: !behaviors })
  }

  /**
   * Checkpoint rewind of tracked files to their state at a user message. A
   * real run reports no counts (CLI 2.1.316 answers `{ canRewind,
   * skippedLinks }`), so they come from a dry run just before it.
   */
  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindFilesResult> {
    if (dryRun) return this.#query.rewindFiles(userMessageId, { dryRun })
    const preview = await this.#query.rewindFiles(userMessageId, { dryRun: true })
    if (!preview.canRewind) return preview
    const result = await this.#query.rewindFiles(userMessageId)
    return result.canRewind ? { ...preview, ...result } : result
  }

  /** Stops one subagent (or background shell); its task_notification says `stopped`. */
  async stopTask(taskId: string): Promise<void> {
    await this.#query.stopTask(taskId)
  }

  /** Ctrl+B for one foreground subagent: its Agent call returns and the turn moves on. */
  async backgroundTask(toolUseId: string): Promise<boolean> {
    return this.#query.backgroundTasks(toolUseId)
  }

  /** `!` mode. Runs where the CLI runs, so relative paths mean the same thing to both. */
  async shell(command: string): Promise<{ stdout: string; stderr: string }> {
    return runShellCommand(command, this.config.cwd)
  }

  async mcpStatus(): Promise<McpServerStatus[]> {
    return this.#query.mcpServerStatus()
  }

  /** Session-only, like the terminal's `/mcp` toggle; returns the updated list. */
  async toggleMcp(name: string, enabled: boolean): Promise<McpServerStatus[]> {
    await this.#query.toggleMcpServer(name, enabled)
    return this.#query.mcpServerStatus()
  }

  async reconnectMcp(name: string): Promise<McpServerStatus[]> {
    await this.#query.reconnectMcpServer(name)
    return this.#query.mcpServerStatus()
  }

  /** The terminal's `/skills` rows. `getSkillsDialog` is internal, so not in the SDK's typings. */
  async skills(): Promise<SkillInfo[]> {
    const query = this.#query as unknown as { getSkillsDialog(): Promise<{ skills: SkillInfo[] }> }
    return (await query.getSkillsDialog()).skills
  }

  /** The CLI watches its settings files, so this session picks the edit up by itself. */
  async setSkillState(name: string, state: SkillState): Promise<SkillInfo[]> {
    // The row's other names let the CLI place a skill its own scan cannot see, like an MCP server's.
    const handles = (await this.skills()).find((skill) => skill.name === name)?.handles
    await editSkillState(this.config.cwd, { name, state, ...(handles ? { handles } : {}) })
    return this.skills()
  }

  plugins(): Promise<PluginInfo[]> {
    return listPlugins(this.config.cwd)
  }

  /** Settings changes reach the CLI only through a reload, unlike skill states. */
  async pluginAction(id: string, scope: string, action: PluginAction): Promise<{ plugins: PluginInfo[]; notice?: string }> {
    const notice = await runPluginAction(this.config.cwd, id, scope, action)
    await this.#query.reloadPlugins()
    return { plugins: await this.plugins(), ...(notice ? { notice } : {}) }
  }

  async account(): Promise<AccountInfo> {
    return this.#query.accountInfo()
  }

  respondToPermission(requestId: string, decision: PermissionDecision): boolean {
    const handled = this.#permissions.respond(requestId, decision)
    if (handled) {
      this.#emit({ type: 'permission_resolved', sessionId: this.sessionId, requestId })
      this.#announceState()
    }
    return handled
  }

  close(): void {
    this.#interruptVersion += 1
    this.#interrupted = true
    this.#queuedAfterInterrupt = false
    this.#status = 'idle'
    this.#backlog.length = 0
    this.#setTurnProgress(null)
    this.#announceState()
    this.#input.close()
    this.#query.close()
  }

  /** {@link close}, resolved once the CLI is gone — before another may open the same transcript. */
  async shutdown(): Promise<void> {
    this.close()
    await this.#exited
  }

  /**
   * This runner's config with the settings the session runs on now: a mode,
   * model or effort picked since it started would otherwise be lost to a
   * restart. Effort and ultracode go only when set — an unset effort is the
   * settings' default, which the next CLI reads for itself.
   */
  async carryOver(): Promise<RunnerConfig> {
    const [{ model }, flags] = await Promise.all([this.#models.list(), this.flags()])
    const { effort: _effort, ultracode: _ultracode, ...config } = this.config
    return {
      ...config,
      permissionMode: this.#permissionMode,
      model,
      ...(flags.effort ? { effort: flags.effort } : {}),
      ...(flags.ultracode ? { ultracode: true } : {}),
    }
  }
}

/**
 * Attachments become leading content blocks so the model sees them before the
 * instruction text; a bare prompt stays a plain string.
 */
function buildContent(text: string, attachments?: Attachment[]): MessageParam['content'] {
  if (!attachments || attachments.length === 0) return text
  for (const attachment of attachments) assertAttachment(attachment)

  const blocks = attachments.map((attachment) =>
    attachment.kind === 'image'
      ? {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: attachment.mediaType, data: attachment.data },
        }
      : {
          type: 'document' as const,
          source: { type: 'base64' as const, media_type: attachment.mediaType, data: attachment.data },
          ...(attachment.filename ? { title: attachment.filename } : {}),
        },
  ) as unknown as ContentBlocks

  return [...blocks, { type: 'text', text }] as ContentBlocks
}

const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Only the base64 alphabet, padding and whitespace (line breaks are a legal
// base64 transport form). Deliberately not a full base64 validator: this just
// catches obvious mistakes such as a leading `data:…;base64,` prefix.
const BASE64 = /^[A-Za-z0-9+/=\s]+$/

/**
 * The RPC payload is untrusted JSON, and a malformed block is rejected by the
 * API mid-turn instead of at the call site — so the shape is checked here.
 */
function assertAttachment(attachment: Attachment): void {
  if (attachment.kind !== 'image' && attachment.kind !== 'document') {
    throw new Error(`unsupported attachment kind: ${String(attachment.kind)}`)
  }
  if (typeof attachment.mediaType !== 'string' || !MEDIA_TYPE.test(attachment.mediaType)) {
    throw new Error('attachment mediaType must be a MIME type')
  }
  if (typeof attachment.data !== 'string' || attachment.data.length === 0 || !BASE64.test(attachment.data)) {
    throw new Error('attachment data must be base64 without a data-URL prefix')
  }
}
