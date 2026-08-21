import { randomUUID } from 'node:crypto'

import { query, type ModelInfo, type Query, type SDKUserMessage, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type {
  Attachment,
  EffortLevel,
  PermissionDecision,
  PermissionMode,
  ServerEvent,
  SessionConfig,
} from '@ccw/shared'

import { resolveClaudeExecutable } from '../config.ts'
import { InputQueue } from './input-queue.ts'
import { PermissionBroker } from './permission.ts'

type MessageParam = SDKUserMessage['message']
type ContentBlocks = Extract<MessageParam['content'], readonly unknown[]>

export type EmitEvent = (event: ServerEvent) => void

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
          this.#emit({
            type: 'permission_request',
            sessionId: this.sessionId,
            request: {
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
            },
          })
          return this.#permissions.await(options.requestId, options.signal, options.suggestions)
        },
        stderr: (data) => {
          process.stderr.write(`[cli ${this.sessionId.slice(0, 8)}] ${data}`)
        },
      },
    })

    void this.#pump()
    if (config.effort) void this.setEffort(config.effort)
  }

  /** Drains the SDK's message stream onto the downlink until the CLI exits. */
  async #pump(): Promise<void> {
    try {
      for await (const message of this.#query) {
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
      for (const requestId of this.#permissions.drain()) {
        this.#emit({ type: 'permission_resolved', sessionId: this.sessionId, requestId })
      }
      this.#emit({ type: 'session_closed', sessionId: this.sessionId })
    }
  }

  get done(): boolean {
    return this.#done
  }

  send(text: string, attachments?: Attachment[]): void {
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: buildContent(text, attachments) },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
  }

  async interrupt(): Promise<void> {
    await this.#query.interrupt()
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
