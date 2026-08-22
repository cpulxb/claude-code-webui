import type {
  EffortLevel,
  ModelInfo,
  PermissionMode,
  PermissionUpdate,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'

export type { EffortLevel, ModelInfo, PermissionMode, PermissionUpdate, SDKMessage, SessionMessage, SlashCommand }

/** The `/context` breakdown: per-category tokens plus the CLI's own grid rows. */
export type ContextUsage = SDKControlGetContextUsageResponse

export { fuzzyFilter, fuzzyScore } from './fuzzy.ts'

/** Every permission mode the CLI accepts, in the order the Modes popover lists them. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
  'dontAsk',
] as const satisfies readonly PermissionMode[]

/** Effort levels from cheapest to deepest — the slider's five stops. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortLevel[]

/**
 * A tool call waiting on the user. Mirrors the fields the SDK's `canUseTool`
 * callback receives; `title`/`displayName`/`description` are rendered as-is
 * rather than reconstructed from `toolName` + `input`.
 */
export type PermissionRequest = {
  requestId: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  /** Pass back verbatim as `updatedPermissions` when the user picks "always allow". */
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  decisionReason?: string
  agentId?: string
}

export type PermissionDecision =
  | { behavior: 'allow'; remember?: boolean }
  | { behavior: 'deny'; message?: string }

/** An image or document the user attached to a prompt. */
export type Attachment = {
  kind: 'image' | 'document'
  /** MIME type, e.g. `image/png` or `application/pdf`. */
  mediaType: string
  /** Base64 payload without a data-URL prefix. */
  data: string
  filename?: string
}

export type SessionConfig = {
  cwd: string
  model?: string
  permissionMode?: PermissionMode
  effort?: EffortLevel
  /** Existing Claude session UUID to resume; omit to start fresh. */
  resume?: string
  /**
   * UUID the caller wants the new session to use. The browser supplies one so
   * it can register the session locally *before* the CLI starts emitting
   * events — otherwise `init` can land before `session.create` returns and be
   * dropped as belonging to an unknown session.
   */
  sessionId?: string
}

/** Session metadata for the sidebar, derived from the on-disk JSONL transcripts. */
export type SessionSummary = {
  sessionId: string
  summary: string
  lastModified: number
  cwd?: string
  gitBranch?: string
  customTitle?: string
  firstPrompt?: string
  /** True when this session is currently open in a runner. */
  live?: boolean
}

export type ProjectGroup = {
  /** Absolute working directory the sessions were started in. */
  cwd: string
  sessions: SessionSummary[]
}

export type FileSuggestion = {
  /** Path relative to the session cwd. */
  path: string
  isDirectory: boolean
}

/** One selectable directory in the workspace picker. */
export type DirectoryEntry = { name: string; path: string }

export type DirectoryListing = {
  /** Absolute path that was listed. */
  path: string
  /** Parent directory, or null at the filesystem root. */
  parent: string | null
  entries: DirectoryEntry[]
  /** The server user's home directory, used as the picker's starting point. */
  home: string
}

/**
 * Every RPC the server answers over `POST /api/rpc`, keyed by method name.
 * The client's `call()` derives both argument and return types from this map.
 */
export type RpcMap = {
  'session.create': { params: SessionConfig; result: { sessionId: string } }
  'session.close': { params: { sessionId: string }; result: Record<string, never> }
  'session.send': {
    params: { sessionId: string; text: string; attachments?: Attachment[] }
    result: Record<string, never>
  }
  'session.interrupt': { params: { sessionId: string }; result: Record<string, never> }
  'session.setPermissionMode': {
    params: { sessionId: string; mode: PermissionMode }
    result: Record<string, never>
  }
  'session.setModel': { params: { sessionId: string; model?: string }; result: Record<string, never> }
  'session.setEffort': { params: { sessionId: string; effort: EffortLevel }; result: Record<string, never> }
  'session.commands': { params: { sessionId: string }; result: { commands: SlashCommand[] } }
  'session.models': { params: { sessionId: string }; result: { models: ModelInfo[] } }
  'session.contextUsage': { params: { sessionId: string }; result: { usage: ContextUsage } }
  'permission.respond': {
    params: { sessionId: string; requestId: string; decision: PermissionDecision }
    result: Record<string, never>
  }
  'history.projects': { params: Record<string, never>; result: { projects: ProjectGroup[] } }
  /**
   * Replayed transcript. Note these are `SessionMessage`, not `SDKMessage` —
   * the on-disk shape carries an opaque `message` payload, so the renderer
   * adapts them rather than reusing the live-stream path unchanged.
   */
  'history.messages': {
    params: { sessionId: string; cwd?: string }
    /** `permissionMode` is absent when the session's mode was never toggled. */
    result: { messages: SessionMessage[]; permissionMode?: PermissionMode }
  }
  'files.suggest': {
    params: { sessionId: string; query: string }
    result: { suggestions: FileSuggestion[] }
  }
  /** Directory listing for the workspace picker. Omit `path` to start at home. */
  'files.browse': {
    params: { path?: string; showHidden?: boolean }
    result: DirectoryListing
  }
}

export type RpcMethod = keyof RpcMap
export type RpcParams<M extends RpcMethod> = RpcMap[M]['params']
export type RpcResult<M extends RpcMethod> = RpcMap[M]['result']

export type RpcSuccess<M extends RpcMethod = RpcMethod> = { ok: true; result: RpcResult<M> }
export type RpcFailure = { ok: false; error: string }
export type RpcResponse<M extends RpcMethod = RpcMethod> = RpcSuccess<M> | RpcFailure

/**
 * Downlink frames. The WebSocket at `/api/events` carries only these; the
 * browser never writes application data back over it.
 */
export type ServerEvent =
  | { type: 'sdk'; sessionId: string; message: SDKMessage }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  | { type: 'session_error'; sessionId: string; error: string }
  | { type: 'session_closed'; sessionId: string }

export const API_RPC_PATH = '/api/rpc'
export const API_EVENTS_PATH = '/api/events'
export const DEFAULT_PORT = 3090
