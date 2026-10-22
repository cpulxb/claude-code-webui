import { randomUUID } from 'node:crypto'

import {
  query,
  type AccountInfo,
  type McpServerStatus,
  type Query,
  type RewindFilesResult,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  Attachment,
  ContextUsage,
  EffortLevel,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ServerEvent,
  SessionConfig,
  SessionFlags,
  SessionStatus,
  SessionSummary,
} from '@ccw/shared'

import { resolveClaudeExecutable } from '../config.ts'
import { InputQueue } from './input-queue.ts'
import { SessionModels } from './models.ts'
import { PermissionBroker } from './permission.ts'
import { runShellCommand } from './shell.ts'

type MessageParam = SDKUserMessage['message']
type ContentBlocks = Extract<MessageParam['content'], readonly unknown[]>

export type EmitEvent = (event: ServerEvent) => void

/** Backlog cap — a runaway turn with hundreds of tool calls must not grow memory unbounded. */
const BACKLOG_LIMIT = 500

/**
 * One WebUI session backed by one SDK `Query`, which in turn owns one Claude
 * Code subprocess. Prompts go in through {@link send}; everything the CLI
 * emits is broadcast verbatim as `sdk` events so the browser can render from
 * the same structured stream the TUI renders from.
 */
export class SessionRunner {
  readonly sessionId: string
  readonly config: SessionConfig

  readonly #input = new InputQueue<SDKUserMessage>()
  readonly #permissions = new PermissionBroker((requestId) => {
    this.#emit({ type: 'permission_resolved', sessionId: this.sessionId, requestId })
  })
  readonly #emit: EmitEvent
  readonly #query: Query
  readonly #models: SessionModels
  #done = false
  #status: SessionStatus = 'idle'
  /** Set by {@link interrupt} so the aborted turn's trailing frames cannot revive `running`. */
  #interrupted = false
  readonly #backlog: SDKMessage[] = []
  readonly #summary: SessionSummary

  constructor(config: SessionConfig, emit: EmitEvent) {
    this.config = config
    this.#emit = emit
    // The id is fixed before the CLI starts so the browser can register the
    // session first and never miss the `init` event. Resuming reuses the
    // existing transcript's id.
    this.sessionId = config.resume ?? config.sessionId ?? randomUUID()
    this.#summary = {
      sessionId: this.sessionId,
      cwd: config.cwd,
      summary: '',
      // Merely reopening history must not promote it above newer messages.
      lastModified: config.resume ? 0 : Date.now(),
      live: true,
    }

    this.#query = query({
      prompt: this.#input,
      options: {
        cwd: config.cwd,
        ...(config.resume ? { resume: config.resume } : { sessionId: this.sessionId }),
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
          return this.#permissions.await(request, options.signal)
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
    void this.#pump()
    // Failure here means the CLI died before the flag landed; #pump already
    // reports that, and an escaped rejection would crash the whole server.
    const initial: { effortLevel?: EffortLevel; ultracode?: boolean } = {}
    if (config.effort) initial.effortLevel = config.effort
    if (config.ultracode !== undefined) initial.ultracode = config.ultracode
    if (Object.keys(initial).length > 0) {
      this.#ultracode = config.ultracode ?? false
      this.#query
        .applyFlagSettings(initial)
        .then(() => this.#publishFlags())
        .catch(() => {})
    }
  }

  /** Last ultracode state the CLI reported, so an effort change can carry it. */
  #ultracode = false

  /** Drains the SDK's message stream onto the downlink until the CLI exits. */
  async #pump(): Promise<void> {
    try {
      for await (const message of this.#query) {
        // Tracked here as well as in the browser: a page that reloads mid-turn
        // has no way to tell a working session from a finished one otherwise.
        //
        // `send` opening the turn is what actually drives this — CLI 2.1.237
        // never emits `session_state_changed`, so the branch below is only a
        // more precise signal if a later version starts sending it.
        if (message.type === 'system' && message.subtype === 'session_state_changed') {
          this.#status = message.state === 'running' ? 'running' : 'idle'
        }
        if (message.type === 'result') {
          this.#status = 'idle'
          // The turn is over, so nothing still in flight belongs to it: a later
          // top-level assistant frame is a new turn and may say `running` again.
          this.#interrupted = false
        }
        // A turn the CLI started on its own — a prompt it had queued behind the
        // one that just ended — is otherwise invisible: without
        // `session_state_changed` nothing would move the status off `idle`, and
        // the browser would offer no way to stop it. Only top-level assistant
        // output counts: a sub-agent's messages carry a `parent_tool_use_id`
        // and can still arrive while the parent turn is being torn down. Frames
        // an interrupted turn had already emitted are skipped for the same
        // reason — Stop must not bounce back to `running`.
        else if (message.type === 'assistant' && message.parent_tool_use_id === null && !this.#interrupted) {
          this.#status = 'running'
        }
        this.#trackBacklog(message)
        this.#emit({ type: 'sdk', sessionId: this.sessionId, message })
      }
    } catch (error) {
      this.#emit({
        type: 'session_error',
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.#done = true
      this.#status = 'idle'
      for (const requestId of this.#permissions.drain()) {
        this.#emit({ type: 'permission_resolved', sessionId: this.sessionId, requestId })
      }
      this.#emit({ type: 'session_closed', sessionId: this.sessionId })
    }
  }

  /**
   * Retains the in-flight turn's messages for a browser that reloads mid-turn:
   * the CLI flushes the jsonl lazily, so the history read alone misses what
   * already streamed. Cleared when the turn ends — from there the transcript
   * catches up, and `session.state` payloads stay small.
   */
  #trackBacklog(message: SDKMessage): void {
    const turnEnded =
      message.type === 'result' ||
      (message.type === 'system' && message.subtype === 'session_state_changed' && message.state !== 'running')
    if (turnEnded) {
      this.#backlog.length = 0
      return
    }
    // Only what the renderer rebuilds from: stream_event (one per delta) and
    // tool_progress (one per second) would flood the ring for no benefit.
    if (message.type !== 'assistant' && message.type !== 'user' && message.type !== 'system') return
    this.#backlog.push(message)
    if (this.#backlog.length > BACKLOG_LIMIT) this.#backlog.shift()
  }

  get done(): boolean {
    return this.#done
  }

  /** Whether a turn is in flight right now, as the CLI last reported it. */
  get status(): SessionStatus {
    return this.#status
  }

  /** Permission prompts still open, for a browser that reconnected. */
  get pendingPermissions(): PermissionRequest[] {
    return this.#permissions.list()
  }

  /** The in-flight turn's messages, for the same reconnecting browser; see {@link #trackBacklog}. */
  get backlog(): SDKMessage[] {
    return [...this.#backlog]
  }

  get summary(): SessionSummary {
    return { ...this.#summary }
  }

  async send(text: string, attachments?: Attachment[]): Promise<void> {
    // Build before the status flips: `buildContent` validates the attachments
    // and throws, which would otherwise leave `running` set with no turn to
    // ever clear it — the browser would show Stop for a turn that never began.
    const content = buildContent(text, attachments)
    await this.#models.withCurrentSettings(() => {
      this.#input.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      })
      this.#status = 'running'
      this.#interrupted = false
      this.#summary.lastModified = Date.now()
      if (!this.config.resume && !this.#summary.firstPrompt) {
        this.#summary.firstPrompt = text.trim().slice(0, 2000) || '附件消息'
        this.#summary.summary = this.#summary.firstPrompt.replace(/\s+/g, ' ').slice(0, 160)
      }
      this.#emit({ type: 'session_updated', sessionId: this.sessionId, summary: this.summary })
    })
  }

  async interrupt(): Promise<void> {
    // Drop prompts the SDK has not pulled yet, so Stop cannot be followed by
    // one of them opening a fresh turn.
    this.#input.drain()
    // Frames the aborted turn had already emitted are still on their way; the
    // flag holds until its `result` arrives (or the next `send`) so they cannot
    // undo the status set below.
    this.#interrupted = true
    const receipt = await this.#query.interrupt()
    // Prompts the CLI had already queued survive the abort — `interrupt()` in
    // SDK 0.3.238 cannot cancel them — and each one opens a turn of its own,
    // so the browser must keep showing Stop.
    this.#status = (receipt?.still_queued?.length ?? 0) > 0 ? 'running' : 'idle'
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#query.setPermissionMode(mode)
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
    await this.#query.applyFlagSettings({ effortLevel: effort, ...(this.#ultracode ? { ultracode: true } : {}) })
    await this.#publishFlags()
  }

  async setUltracode(on: boolean): Promise<SessionFlags> {
    await this.#query.applyFlagSettings({ ultracode: on })
    return this.#publishFlags()
  }

  /**
   * `getSettings` exists on the SDK's Query at runtime but is not in its
   * 0.3.238 typings; `applied` is what the next request will really carry.
   */
  async flags(): Promise<SessionFlags> {
    const settings = (await (this.#query as unknown as { getSettings(): Promise<unknown> }).getSettings()) as {
      applied?: { effort?: EffortLevel | null; ultracode?: boolean; ultracodeAvailable?: boolean }
    }
    const applied = settings.applied ?? {}
    const flags: SessionFlags = {
      effort: applied.effort ?? null,
      ultracode: applied.ultracode === true,
      ultracodeAvailable: applied.ultracodeAvailable === true,
    }
    this.#ultracode = flags.ultracode
    return flags
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

  /** Checkpoint rewind of tracked files to their state at a user message. */
  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindFilesResult> {
    return this.#query.rewindFiles(userMessageId, { dryRun })
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

  async account(): Promise<AccountInfo> {
    return this.#query.accountInfo()
  }

  respondToPermission(requestId: string, decision: PermissionDecision): boolean {
    const handled = this.#permissions.respond(requestId, decision)
    if (handled) {
      this.#emit({ type: 'permission_resolved', sessionId: this.sessionId, requestId })
    }
    return handled
  }

  close(): void {
    this.#input.close()
    this.#query.close()
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
