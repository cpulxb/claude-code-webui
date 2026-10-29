import type {
  AccountInfo,
  EffortLevel,
  McpServerStatus,
  ModelInfo,
  PermissionMode,
  PermissionUpdate,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'

export type {
  AccountInfo,
  EffortLevel,
  McpServerStatus,
  ModelInfo,
  PermissionMode,
  PermissionUpdate,
  RewindFilesResult,
  SDKMessage,
  SessionMessage,
  SlashCommand,
}

/** The `/context` breakdown: per-category tokens plus the CLI's own grid rows. */
export type ContextUsage = SDKControlGetContextUsageResponse

/** The states the terminal's `/skills` menu cycles through. */
export type SkillState = 'on' | 'name-only' | 'user-invocable-only' | 'off'

/**
 * One row of the terminal's `/skills` menu, from the CLI's internal
 * `get_skills_dialog` request — the rows the VS Code extension draws.
 */
export type SkillInfo = {
  /** The settings key. */
  name: string
  display_name: string
  description: string
  /** `user`, `project`, `plugin`, `built-in`, … */
  source: string
  /** Estimated cost of the skill's listing in the system prompt. */
  tokens: number
  state: SkillState
  /** Set when a local setting cannot change the state. */
  locked_by?: 'author' | 'plugin' | 'policy' | 'flag' | 'reserved-name'
  advertised: boolean
  handles: { unqualified_name?: string; aliases?: string[]; bare_name_reserved?: boolean }
}

/** One installed plugin, as `claude plugin list --json` reports it. */
export type PluginInfo = {
  /** `name@marketplace`. */
  id: string
  version?: string
  scope: string
  enabled: boolean
  installPath?: string
}

export type PluginAction = 'enable' | 'disable' | 'update' | 'uninstall'

export { fuzzyFilter, fuzzyScore } from './fuzzy.ts'
export { mergeProjectSessions, UNKNOWN_CWD } from './projects.ts'

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

/** Whether a turn is in flight. Mirrors the CLI's `session_state_changed`. */
export type SessionStatus = 'idle' | 'running'

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

/**
 * A dynamic workflow run as saved under `<session>/workflows/<runId>.json`,
 * or rebuilt from its journal while it has not finished yet.
 */
export type WorkflowRecord = {
  runId: string
  taskId?: string
  workflowName?: string
  summary?: string
  status?: string
  script?: string
  scriptPath?: string
  phases?: { title: string; detail?: string }[]
  /** The same items `task_progress.workflow_progress` carries live. */
  workflowProgress?: unknown[]
  totalTokens?: number
  totalToolCalls?: number
  durationMs?: number
}

/**
 * A finished turn's figures, rebuilt from the transcript for the row its live
 * `result` drew; see `history/turns.ts`.
 */
export type TurnTotals = {
  /** The turn's last entry, which the row follows. */
  after: string
  durationMs: number
  /** Model responses — what `result.num_turns` counts. */
  numTurns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/** A subagent transcript found next to a session's JSONL. */
export type SubagentMeta = {
  agentId: string
  /** The Agent tool_use that spawned it, when the CLI recorded one. */
  toolUseId?: string
  description?: string
  agentType?: string
}

export type PermissionDecision =
  | {
      behavior: 'allow'
      remember?: boolean
      /** AskUserQuestion's answers, keyed by question text; without them the model is told nobody answered. */
      answers?: Record<string, string>
    }
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

/**
 * Runtime-resolved effort and ultracode, as `get_settings` reports them.
 * `effort` is null when no effort parameter will be sent. CLIs that predate
 * ultracode report neither ultracode field, which reads as unavailable.
 */
export type SessionFlags = {
  effort: EffortLevel | null
  ultracode: boolean
  ultracodeAvailable: boolean
}

export type SessionConfig = {
  cwd: string
  model?: string
  permissionMode?: PermissionMode
  effort?: EffortLevel
  /**
   * Ultracode (CLI ≥ 2.1.29x): standing dynamic-workflow orchestration at
   * whatever effort is selected. Session-only, so it is replayed on attach.
   */
  ultracode?: boolean
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

/** Sidebar metadata from saved transcripts and sessions that have not been flushed yet. */
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

/** One node of the Explorer tree — a single readdir level, fetched lazily. */
export type TreeEntry = { name: string; path: string; isDirectory: boolean }

/** What `files.read` returns for the Explorer's preview overlay. */
export type FilePreview =
  | { kind: 'text'; size: number; content: string; truncated: boolean }
  | { kind: 'image'; size: number; mediaType: string; data: string }
  | { kind: 'binary'; size: number }

/** One changed file in the source-control panel. */
export type ScmFile = {
  /** Path relative to `cwd`. */
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
  /** The pre-rename path, present only when `status` is `renamed`. */
  oldPath?: string
}

/**
 * What the source-control panel shows for a directory.
 *
 * `git` means a real repository: changes are measured against `HEAD` (or the
 * empty tree while the branch is unborn). `shadow` means a non-repo tracked by
 * an external shadow git dir: changes are measured against its baseline
 * commit. `none` means nothing tracks the directory yet — the panel offers to
 * start shadow tracking.
 */
export type ScmStatus =
  | { kind: 'git'; branch: string | null; files: ScmFile[] }
  | { kind: 'shadow'; files: ScmFile[] }
  | { kind: 'none' }

/** What installing a release runs, in order. */
export type UpdateStep = 'merge' | 'install' | 'build'

export type UpdateProgress =
  | { state: 'running'; step: UpdateStep }
  | { state: 'failed'; step: UpdateStep; error: string }
  /** Installed; the server is exiting so its supervisor starts the new version. */
  | { state: 'restarting' }
  /** Installed, but nothing would start the server again: the user restarts it. */
  | { state: 'restartRequired' }

/**
 * Release updates. The server compares its own git checkout with the `vX.Y.Z`
 * tags on `origin`, so only a pushed tag counts as a new version.
 */
export type UpdateStatus = {
  /** The running version, from the root package.json. */
  current: string
  /** Newest release tag that HEAD does not contain yet, without its `v`. */
  latest: string | null
  /** Subjects of the commits `latest` brings in, newest first. */
  changes: string[]
  /**
   * False under `pnpm dev`: tsx watch restarts the server as soon as the merge
   * lands, which would cut the install off halfway.
   */
  canApply: boolean
  /** Null until `update.apply` runs; from then on it describes that install. */
  progress: UpdateProgress | null
}

/** A field the settings page edits that a higher-precedence source also sets. */
export type SettingsOverride = {
  /** `model`, `modelPicker`, or `env.<NAME>`. */
  key: string
  source: 'project' | 'local' | 'flag' | 'managed'
  path?: string
}

/** The user-level `settings.json` the settings page edits. */
export type UserSettings = {
  path: string
  /** `{}` while the file does not exist. */
  settings: Record<string, unknown>
  /** Hash of the bytes read; a write based on an older one is refused. */
  revision: string
  overrides: SettingsOverride[]
}

/** One entry of an upstream channel's `/v1/models`. */
export type UpstreamModel = {
  id: string
  /** OpenAI-style `owned_by`; Anthropic's own list has none. */
  owner?: string
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
  /**
   * What the server knows about a session that the browser cannot.
   *
   * A reload wipes the page but not the CLI process behind it, so `live` is the
   * only trustworthy answer to "is this session already running?" — guessing
   * `false` would present a live session as a read-only replay and let the next
   * message spawn a second process writing the same transcript. `status` and
   * `pendingPermissions` restore what the dropped downlink took with it, and
   * `backlog` restores the in-flight turn's messages, which the CLI may not
   * have flushed to the jsonl yet; it is empty while the session is idle.
   */
  'session.state': {
    params: { sessionId: string }
    result: {
      live: boolean
      status: SessionStatus
      pendingPermissions: PermissionRequest[]
      backlog: SDKMessage[]
    }
  }
  'session.setPermissionMode': {
    params: { sessionId: string; mode: PermissionMode }
    result: Record<string, never>
  }
  'session.setModel': { params: { sessionId: string; model?: string }; result: Record<string, never> }
  'session.setEffort': { params: { sessionId: string; effort: EffortLevel }; result: Record<string, never> }
  'session.setUltracode': { params: { sessionId: string; on: boolean }; result: SessionFlags }
  /** What the CLI will actually send next turn — `get_settings`' `applied` block. */
  'session.flags': { params: { sessionId: string }; result: SessionFlags }
  'session.commands': { params: { sessionId: string }; result: { commands: SlashCommand[] } }
  'session.models': { params: { sessionId: string }; result: { models: ModelInfo[]; model?: string } }
  'session.contextUsage': { params: { sessionId: string }; result: { usage: ContextUsage } }
  /**
   * Restores checkpointed files to their state just before a user message.
   * `dryRun` previews the counts without touching the tree. Requires a live
   * runner — the checkpoint store belongs to the CLI process.
   */
  'session.rewindFiles': {
    params: { sessionId: string; userMessageId: string; dryRun?: boolean }
    result: { rewind: RewindFilesResult }
  }
  /** Stops one running subagent or background task (`task_notification` follows). */
  'session.stopTask': { params: { sessionId: string; taskId: string }; result: Record<string, never> }
  /**
   * Moves a foreground subagent to the background — the terminal's Ctrl+B.
   * The blocked Agent call returns at once and the turn continues.
   */
  'session.backgroundTask': {
    params: { sessionId: string; toolUseId: string }
    result: { backgrounded: boolean }
  }
  /**
   * The terminal's `!` mode: runs one command in the session's cwd and returns
   * its output. Nothing reaches the model here — the browser sends the result
   * on as a `<bash-input>`/`<bash-stdout>` prompt, the way the CLI records it.
   */
  'session.shell': { params: { sessionId: string; command: string }; result: { stdout: string; stderr: string } }
  /** `/mcp`: live status of every MCP server, which `init` only snapshots. */
  'session.mcpStatus': { params: { sessionId: string }; result: { servers: McpServerStatus[] } }
  'session.mcpToggle': {
    params: { sessionId: string; name: string; enabled: boolean }
    result: { servers: McpServerStatus[] }
  }
  'session.mcpReconnect': { params: { sessionId: string; name: string }; result: { servers: McpServerStatus[] } }
  /** `/skills`: the terminal menu's rows for this session. */
  'session.skills': { params: { sessionId: string }; result: { skills: SkillInfo[] } }
  /** Saved where the terminal's `/skills` saves: the project's `.claude/settings.local.json`. */
  'session.setSkillState': {
    params: { sessionId: string; name: string; state: SkillState }
    result: { skills: SkillInfo[] }
  }
  /** `/plugins`: every installed plugin, enabled or not. */
  'session.plugins': { params: { sessionId: string }; result: { plugins: PluginInfo[] } }
  /** Also applied to the running session, as `/reload-plugins` would; `notice` reports an update. */
  'session.pluginAction': {
    params: { sessionId: string; id: string; scope: string; action: PluginAction }
    result: { plugins: PluginInfo[]; notice?: string }
  }
  /** `/status`: who the CLI is logged in as. */
  'session.account': { params: { sessionId: string }; result: { account: AccountInfo } }
  /**
   * `/rename`: appends a custom title to the transcript, the same entry the
   * terminal writes. Works on saved sessions too, so no runner is needed.
   */
  'session.rename': { params: { sessionId: string; title: string; cwd?: string }; result: Record<string, never> }
  /** `/branch`: copies the transcript under a new session id. Undo history stays behind. */
  'session.fork': { params: { sessionId: string; cwd?: string; title?: string }; result: { sessionId: string } }
  'permission.respond': {
    params: { sessionId: string; requestId: string; decision: PermissionDecision }
    result: Record<string, never>
  }
  'history.projects': { params: Record<string, never>; result: { projects: ProjectGroup[] } }
  /**
   * Replayed transcript. Note these are `SessionMessage`, not `SDKMessage` —
   * the on-disk shape carries an opaque `message` payload, so the renderer
   * adapts them rather than reusing the live-stream path unchanged.
   *
   * With `limit`, one page of it: the entries just before `before` (the first
   * uuid of the window already shown), just after `after` (its last), around
   * `around` (an entry's uuid, or the id of a tool call in it — a session
   * opened at that entry), or the newest ones. A missing `around` entry gets
   * the newest page. Without `limit`, the whole transcript.
   */
  'history.messages': {
    params: { sessionId: string; cwd?: string; limit?: number; before?: string; after?: string; around?: string }
    /**
     * `hasMore` / `hasNewer`: entries remain before / after this page.
     * `turns`: the stats rows of turns that end on this page, paged reads only.
     * `permissionMode` is absent when the session's mode was never toggled,
     * and is only read for the page a session opens at.
     */
    result: {
      messages: SessionMessage[]
      hasMore: boolean
      hasNewer: boolean
      turns?: TurnTotals[]
      permissionMode?: PermissionMode
    }
  }
  /**
   * The directory a session runs in, for opening one known only by its id —
   * from the address bar. Null when no session has that id.
   */
  'history.locate': { params: { sessionId: string }; result: { cwd: string | null } }
  /** Subagents a session spawned, read from `<session>/subagents/*.meta.json`. */
  'history.subagents': { params: { sessionId: string }; result: { agents: SubagentMeta[] } }
  /** One dynamic workflow run, for a reloaded session's workflow card. */
  'history.workflow': { params: { sessionId: string; runId: string }; result: { run: WorkflowRecord | null } }
  /**
   * One subagent's own conversation, from `<session>/subagents/agent-<id>.jsonl`.
   * Shaped like `history.messages` so the same renderer replays it.
   */
  'history.subagent': {
    params: { sessionId: string; agentId: string }
    result: { messages: SessionMessage[] }
  }
  /**
   * Scans `cwd` for `@` completions. Deliberately keyed on the directory rather
   * than a session: the scan needs nothing from the CLI, and requiring a runner
   * would break the menu for sessions opened read-only.
   */
  'files.suggest': {
    params: { cwd: string; query: string }
    result: { suggestions: FileSuggestion[] }
  }
  /** Directory listing for the workspace picker. Omit `path` to start at home. */
  'files.browse': {
    params: { path?: string; showHidden?: boolean }
    result: DirectoryListing
  }
  /** One level of the Explorer tree. Unlike `files.browse`, files are included. */
  'files.list': { params: { path: string }; result: { entries: TreeEntry[] } }
  /** Bounded read backing the Explorer preview: text capped, images as base64. */
  'files.read': { params: { path: string }; result: { preview: FilePreview } }
  /**
   * Whole-file save from an editor tab. The client only offers editing for
   * untruncated text previews — writing a capped read back would shear the
   * file at 256KB — and the server refuses anything but an existing file.
   */
  'files.write': { params: { path: string; content: string }; result: { bytesWritten: number } }
  /** Changed files in `cwd`, or `{ kind: 'none' }` when it is not a git repo. */
  'scm.status': { params: { cwd: string }; result: { status: ScmStatus } }
  /**
   * Unified diff for one changed file, against HEAD (or the empty tree on an
   * unborn branch). `binary` marks files git cannot textually diff.
   */
  'scm.diff': { params: { cwd: string; path: string }; result: { diff: string; binary: boolean } }
  /** Destructive: restores the file to HEAD, or deletes it when untracked. */
  'scm.discard': { params: { cwd: string; path: string }; result: Record<string, never> }
  /**
   * Creates the shadow repo for a non-git directory on first call, then
   * (re)commits the current state as the new diff baseline.
   */
  'scm.shadowBaseline': { params: { cwd: string }; result: Record<string, never> }
  /** The last release check's answer; `update_status` events push every change after it. */
  'update.status': { params: Record<string, never>; result: UpdateStatus }
  /** Checks for a release now rather than at the next hourly check; fails with git's reason. */
  'update.check': { params: Record<string, never>; result: UpdateStatus }
  /**
   * Starts installing `latest` and returns at once; progress arrives as
   * `update_status` events. The restart at the end ends every live session.
   */
  'update.apply': { params: Record<string, never>; result: UpdateStatus }
  /** `cwd` is where overrides are looked for: its project and local settings. */
  'settings.read': { params: { cwd?: string }; result: UserSettings }
  /**
   * Replaces the whole file. Refused when it changed since `revision` was
   * read — the CLI's `/model` and CC Switch write the same file. Live sessions
   * pick the channel and models up at their next idle refresh.
   */
  'settings.write': {
    params: { settings: Record<string, unknown>; revision: string; cwd?: string }
    result: UserSettings
  }
  /**
   * Lists the models a channel offers, with the page's unsaved address and
   * key. Asked from the server because the browser could not reach most
   * gateways (CORS), and requested the way the CLI would: same auth header,
   * same proxy variables. A key refused there is tried in the other auth
   * header. Fails with the reason, the key never included.
   */
  'settings.fetchModels': {
    params: { baseUrl: string; authField: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY'; key: string }
    result: { models: UpstreamModel[] }
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
  | { type: 'session_updated'; sessionId: string; summary: SessionSummary }
  | { type: 'session_models'; sessionId: string; models: ModelInfo[]; model: string }
  | ({ type: 'session_flags'; sessionId: string } & SessionFlags)
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  | { type: 'session_error'; sessionId: string; error: string }
  | { type: 'session_closed'; sessionId: string }
  | { type: 'update_status'; status: UpdateStatus }

/**
 * Browser → server frames on a terminal socket (`/api/term`). Unlike
 * `/api/events` this socket is two-way, and each one is a single PTY.
 */
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  /** Characters the browser has finished rendering — the flow-control credit. */
  | { type: 'ack'; chars: number }

/** Server → browser frames on a terminal socket. */
export type TerminalServerMessage =
  /** The PTY is up; `shell` is the program's basename, used as the tab title. */
  | { type: 'ready'; shell: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }

export const API_RPC_PATH = '/api/rpc'
export const API_EVENTS_PATH = '/api/events'
/** Query: `cwd` (absolute, must be a known workspace), `cols`, `rows`. */
export const API_TERM_PATH = '/api/term'
export const DEFAULT_PORT = 3090

/**
 * Pairing and device management. Plain HTTP routes rather than RPC methods:
 * they read and set the device cookie, and pairing is the one call an
 * unpaired browser may make. Every route answers in the `RpcResponse` envelope.
 */
export const API_AUTH_PATH = '/api/auth'
/** POST `{ code }` — trades a pairing code for the device cookie. */
export const API_PAIR_PATH = '/api/auth/pair'
/** POST — a fresh pairing code for another device ("添加设备"). */
export const API_PAIRING_CODE_PATH = '/api/auth/code'
export const API_DEVICES_PATH = '/api/auth/devices'
/** POST `{ id }`. */
export const API_REVOKE_PATH = '/api/auth/revoke'

/** `GET /api/auth`. `local` is a loopback request, which needs no pairing. */
export type AuthStatus = { authenticated: boolean; local: boolean }

export type DeviceInfo = {
  id: string
  /** Derived from the User-Agent at pairing time, e.g. "Safari · iPhone". */
  name: string
  createdAt: number
  lastSeenAt: number
  lastIp: string
  /** The device this request came from. */
  current: boolean
}

export type PairingCode = {
  /** `XXXX-XXXX`, Crockford base32. */
  code: string
  expiresAt: number
}
