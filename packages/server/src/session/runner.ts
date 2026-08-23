import { randomUUID } from 'node:crypto'

import {
  query,
  type ModelInfo,
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
  SessionStatus,
} from '@ccw/shared'

import { resolveClaudeExecutable } from '../config.ts'
import { InputQueue } from './input-queue.ts'
import { PermissionBroker } from './permission.ts'

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
  readonly #permissions = new PermissionBroker()
  readonly #emit: EmitEvent
  readonly #query: Query
  #done = false
  #status: SessionStatus = 'idle'
  readonly #backlog: SDKMessage[] = []

  constructor(config: SessionConfig, emit: EmitEvent) {
    this.config = config
    this.#emit = emit
    // The id is fixed before the CLI starts so the browser can register the
    // session first and never miss the `init` event. Resuming reuses the
    // existing transcript's id.
    this.sessionId = config.resume ?? config.sessionId ?? randomUUID()

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

    void this.#pump()
    // Failure here means the CLI died before the flag landed; #pump already
    // reports that, and an escaped rejection would crash the whole server.
    if (config.effort) this.setEffort(config.effort).catch(() => {})
  }

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
        if (message.type === 'result') this.#status = 'idle'
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

  send(text: string, attachments?: Attachment[]): void {
    this.#status = 'running'
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: buildContent(text, attachments) },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
  }

  async interrupt(): Promise<void> {
    await this.#query.interrupt()
    this.#status = 'idle'
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#query.setPermissionMode(mode)
  }

  async setModel(model?: string): Promise<void> {
    await this.#query.setModel(model)
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    await this.#query.applyFlagSettings({ effortLevel: effort })
  }

  async commands(): Promise<SlashCommand[]> {
    return this.#query.supportedCommands()
  }

  async models(): Promise<ModelInfo[]> {
    return this.#query.supportedModels()
  }

  /** The same breakdown the terminal's `/context` command renders. */
  async contextUsage(): Promise<ContextUsage> {
    return this.#query.getContextUsage()
  }

  /** Checkpoint rewind of tracked files to their state at a user message. */
  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindFilesResult> {
    return this.#query.rewindFiles(userMessageId, { dryRun })
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
