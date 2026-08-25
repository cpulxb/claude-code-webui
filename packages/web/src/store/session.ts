import type {
  Attachment,
  ContextUsage,
  EffortLevel,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ProjectGroup,
  RewindFilesResult,
  ServerEvent,
  SessionStatus,
  SlashCommand,
} from '@ccw/shared'
import { PERMISSION_MODES } from '@ccw/shared'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import { call, connectEvents, type ConnectionStatus } from '../api/client.ts'
import { applyHistoryMessage, listUserPromptUuids } from '../render/history.ts'
import { applyMessage, emptyTranscript, type Transcript } from '../render/nodes.ts'

/** Facts the CLI reports once per turn in its `init` message. */
export type SessionInit = {
  model: string
  cwd: string
  version: string
  tools: string[]
  mcpServers: { name: string; status: string }[]
  slashCommands: string[]
  /** Commands whose UX is bound to a terminal — hidden from the `/` menu. */
  terminalSlashCommands: string[]
}

/**
 * Live stats for the in-flight turn, shown as the composer's status line.
 * `currentTokens` tracks the API message currently streaming (its usage
 * arrives cumulatively); `doneTokens` folds each message in on message_stop.
 */
export type TurnStats = {
  startedAt: number
  doneTokens: number
  currentTokens: number
}

export type SessionState = {
  sessionId: string
  cwd: string
  transcript: Transcript
  status: SessionStatus
  /**
   * Whether a CLI process is backing this session. Sessions opened from the
   * sidebar start false: reading history costs nothing, but resuming spawns a
   * process that writes to the same JSONL the terminal may have open. The
   * runner is started on the first message instead.
   */
  attached: boolean
  closed: boolean
  error: string | null
  init: SessionInit | null
  commands: SlashCommand[]
  models: ModelInfo[]
  permissionMode: PermissionMode
  effort: EffortLevel
  model: string | null
  pendingPermissions: PermissionRequest[]
  /** `/context` breakdown, refreshed after each turn. Null until the first one. */
  contextUsage: ContextUsage | null
  /**
   * Mid-turn context total, read off each streamed assistant message's API
   * usage. Null while idle — between turns the authoritative snapshot above
   * is the fresher reading.
   */
  liveTokens: number | null
  /** Elapsed time + ↓ tokens of the running turn. Null while idle. */
  turnStats: TurnStats | null
  /**
   * Bumped when files change outside a turn — a rewind or an editor-tab save —
   * so cwd-watching panels (SCM, Explorer) know to re-read.
   */
  fsVersion: number
}

type Store = {
  connection: ConnectionStatus
  sessions: Record<string, SessionState>
  activeId: string | null
  projects: ProjectGroup[]
  defaultCwd: string

  connect: () => () => void
  restoreActive: () => Promise<void>
  createSession: (cwd: string) => Promise<string>
  openSession: (sessionId: string, cwd?: string) => Promise<void>
  setActive: (sessionId: string | null) => void
  closeSession: (sessionId: string) => Promise<void>
  refreshProjects: () => Promise<void>

  send: (text: string, attachments?: Attachment[]) => Promise<void>
  interrupt: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setEffort: (effort: EffortLevel) => Promise<void>
  setModel: (model: string) => Promise<void>
  respondToPermission: (requestId: string, decision: PermissionDecision) => Promise<void>
  /** dryRun previews; a real run bumps `fsVersion` and posts a notice node. */
  rewindFiles: (nodeId: string, dryRun: boolean) => Promise<RewindFilesResult>
  /** Bumps `fsVersion` after an out-of-band write (editor-tab save). */
  touchFs: (sessionId: string) => void
}

function newSession(sessionId: string, cwd: string, attached: boolean): SessionState {
  return {
    sessionId,
    cwd,
    transcript: emptyTranscript(),
    status: 'idle',
    attached,
    closed: false,
    error: null,
    init: null,
    commands: [],
    models: [],
    permissionMode: rememberedMode(),
    effort: 'high',
    model: null,
    pendingPermissions: [],
    contextUsage: null,
    liveTokens: null,
    turnStats: null,
    fsVersion: 0,
  }
}

/**
 * The permission mode to start a session in.
 *
 * The CLI starts every session at `default` and expects shift+tab, which is
 * fine in a terminal but tedious here — so the last mode picked in the browser
 * carries over. A session opened from the sidebar overrides this with whatever
 * its transcript recorded, when it recorded one.
 */
const MODE_KEY = 'ccw.permissionMode'

function rememberedMode(): PermissionMode {
  const stored = localStorage.getItem(MODE_KEY)
  return stored && (PERMISSION_MODES as readonly string[]).includes(stored) ? (stored as PermissionMode) : 'default'
}

export const useStore = create<Store>()(
  immer((set, get) => ({
    connection: 'connecting',
    sessions: {},
    activeId: null,
    projects: [],
    // The server runs where the repos are; the browser cannot know a default,
    // so the first session inherits the server process's cwd via the sidebar.
    defaultCwd: '',

    connect: () =>
      connectEvents({
        onStatus: (status) => {
          set((state) => {
            state.connection = status
          })
          // A reconnect can mean the server restarted, which takes every runner
          // with it. The socket alone cannot say, so re-read the live set.
          if (status === 'open') void reconcileSessions(set)
        },
        onEvent: (event) => handleEvent(set, get, event),
      }),

    /**
     * Reopens whatever session the tab was on before a reload.
     *
     * Only the id and cwd are persisted; everything else — transcript, whether
     * a runner is still up, what it is doing — is re-read from the server,
     * which is the authority on all three.
     */
    restoreActive: async () => {
      if (get().activeId) return
      const remembered = readRememberedSession()
      if (!remembered) return
      try {
        await get().openSession(remembered.sessionId, remembered.cwd)
      } catch {
        // The session was deleted, or its project directory moved.
        localStorage.removeItem(ACTIVE_KEY)
      }
    },

    createSession: async (cwd) => {
      // Register locally BEFORE the request: the CLI can emit `init` before
      // the HTTP response lands, and an event for an unknown session is
      // dropped, which would leave the command and model lists empty.
      const sessionId = crypto.randomUUID()
      set((state) => {
        state.sessions[sessionId] = newSession(sessionId, cwd, true)
        state.activeId = sessionId
      })
      try {
        // The runner starts in `default` unless told otherwise, which would
        // contradict the mode the composer is already showing.
        const permissionMode = get().sessions[sessionId]?.permissionMode ?? 'default'
        await call('session.create', { cwd, sessionId, permissionMode })
      } catch (error) {
        set((state) => {
          delete state.sessions[sessionId]
          if (state.activeId === sessionId) state.activeId = null
        })
        throw error
      }
      void loadSessionMeta(set, get, sessionId)
      // The boot cost (system prompt, tools, memory files) is context already
      // spent — read it now so the ring shows during the first turn, not after.
      void loadContextUsage(set, get, sessionId)
      return sessionId
    },

    // Opening eagerly attaches, VS Code style: the transcript renders from
    // disk first, then the runner resumes in the background so slash commands
    // and models are ready before the first message. The tradeoff is a CLI
    // process per opened session — and, as in VS Code, resuming a session a
    // terminal still has open means two writers on one JSONL.
    openSession: async (sessionId, cwd) => {
      const known = get().sessions[sessionId]
      if (known) {
        set((state) => {
          state.activeId = sessionId
        })
        // e.g. opened before the runner existed, or the eager attach failed.
        if (!known.attached && !known.closed) attach(set, get, sessionId).catch(() => {})
        return
      }
      const target = cwd ?? get().defaultCwd
      set((state) => {
        state.sessions[sessionId] = newSession(sessionId, target, false)
        state.activeId = sessionId
      })
      // Ordered, not raced: adopting can start delivering live events, and the
      // history replay overwrites the whole transcript when it lands.
      await loadHistory(set, get, sessionId, target)
      await adoptRunner(set, get, sessionId)
      // Fire-and-forget: rendering must not wait for a CLI to boot. A failure
      // leaves the session detached, and `send` retries the attach anyway.
      if (!get().sessions[sessionId]?.attached) attach(set, get, sessionId).catch(() => {})
    },

    setActive: (sessionId) =>
      set((state) => {
        state.activeId = sessionId
      }),

    closeSession: async (sessionId) => {
      await call('session.close', { sessionId })
      set((state) => {
        delete state.sessions[sessionId]
        if (state.activeId === sessionId) state.activeId = Object.keys(state.sessions)[0] ?? null
      })
      // The sidebar's live dots come from the runner table, so they only go
      // stale if the list is not re-read here.
      await get().refreshProjects()
    },

    refreshProjects: async () => {
      const { projects } = await call('history.projects', {})
      set((state) => {
        state.projects = projects
        if (!state.defaultCwd && projects[0]) state.defaultCwd = projects[0].cwd
      })
    },

    send: async (text, attachments) => {
      const sessionId = get().activeId
      if (!sessionId) return
      await attach(set, get, sessionId)
      set((state) => {
        const session = state.sessions[sessionId]
        if (!session) return
        // Optimistic echo: the CLI does not replay user messages by default.
        session.transcript.nodes.push({
          kind: 'user',
          id: `local-${Date.now()}-${session.transcript.nodes.length}`,
          text,
          attachments: attachments?.length ?? 0,
        })
        session.status = 'running'
        session.error = null
        session.turnStats = { startedAt: Date.now(), doneTokens: 0, currentTokens: 0 }
      })
      await call('session.send', { sessionId, text, ...(attachments?.length ? { attachments } : {}) })
    },

    interrupt: async () => {
      const sessionId = get().activeId
      // Nothing to interrupt before a runner exists.
      if (sessionId && get().sessions[sessionId]?.attached) await call('session.interrupt', { sessionId })
    },

    setPermissionMode: async (mode) => {
      const sessionId = get().activeId
      if (!sessionId) return
      if (get().sessions[sessionId]?.attached) await call('session.setPermissionMode', { sessionId, mode })
      localStorage.setItem(MODE_KEY, mode)
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.permissionMode = mode
      })
    },

    setEffort: async (effort) => {
      const sessionId = get().activeId
      if (!sessionId) return
      if (get().sessions[sessionId]?.attached) await call('session.setEffort', { sessionId, effort })
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.effort = effort
      })
    },

    setModel: async (model) => {
      const sessionId = get().activeId
      if (!sessionId) return
      if (get().sessions[sessionId]?.attached) await call('session.setModel', { sessionId, model })
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.model = model
      })
    },

    respondToPermission: async (requestId, decision) => {
      const sessionId = get().activeId
      if (!sessionId) return
      // Drop it locally right away so a double-click cannot answer twice.
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) {
          session.pendingPermissions = session.pendingPermissions.filter((p) => p.requestId !== requestId)
        }
      })
      await call('permission.respond', { sessionId, requestId, decision })
    },

    rewindFiles: async (nodeId, dryRun) => {
      const sessionId = get().activeId
      if (!sessionId) throw new Error('没有活跃会话')
      // The checkpoint store lives in the CLI process, so a session opened
      // read-only gets its runner started here — same as sending would.
      await attach(set, get, sessionId)
      const userMessageId = nodeId.startsWith('local-') ? await resolveUserUuid(get, sessionId, nodeId) : nodeId
      const { rewind } = await call('session.rewindFiles', { sessionId, userMessageId, dryRun })
      if (!dryRun && rewind.canRewind) {
        set((state) => {
          const session = state.sessions[sessionId]
          if (!session) return
          session.fsVersion += 1
          session.transcript.nodes.push({
            kind: 'notice',
            id: `rewind-${Date.now()}-${session.transcript.nodes.length}`,
            level: 'info',
            text: `已回退 ${rewind.filesChanged?.length ?? 0} 个文件（+${rewind.insertions ?? 0} −${rewind.deletions ?? 0}）`,
          })
        })
      }
      return rewind
    },

    touchFs: (sessionId) =>
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.fsVersion += 1
      }),
  })),
)

type Setter = (updater: (state: Store) => void) => void

/**
 * The session the tab had open, so a reload lands back on it.
 *
 * Subscribed rather than written from each action: `activeId` moves in four
 * places, and only one of them is `setActive`.
 */
const ACTIVE_KEY = 'ccw.activeSession'

useStore.subscribe((state) => {
  const session = state.activeId ? state.sessions[state.activeId] : null
  if (session) {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ sessionId: session.sessionId, cwd: session.cwd }))
  } else if (state.activeId === null) {
    localStorage.removeItem(ACTIVE_KEY)
  }
})

function readRememberedSession(): { sessionId: string; cwd: string } | null {
  const raw = localStorage.getItem(ACTIVE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { sessionId?: unknown; cwd?: unknown }
    if (typeof parsed.sessionId !== 'string' || typeof parsed.cwd !== 'string') return null
    return { sessionId: parsed.sessionId, cwd: parsed.cwd }
  } catch {
    return null
  }
}

/**
 * Recovers the transcript uuid behind a locally-echoed user node.
 *
 * Live sends get a synthetic `local-` id because the CLI does not replay user
 * messages; the JSONL has the real uuid. Locally-echoed nodes are always the
 * newest user bubbles, so aligning that tail against the end of the on-disk
 * prompt list recovers each one's uuid.
 */
async function resolveUserUuid(get: () => Store, sessionId: string, nodeId: string): Promise<string> {
  const session = get().sessions[sessionId]
  if (!session) throw new Error('会话不存在')
  const { messages } = await call('history.messages', { sessionId, cwd: session.cwd })
  const prompts = listUserPromptUuids(messages)
  const echoed = session.transcript.nodes.filter((node) => node.kind === 'user' && node.id.startsWith('local-'))
  const position = echoed.findIndex((node) => node.id === nodeId)
  const uuid = position === -1 ? undefined : prompts[prompts.length - echoed.length + position]
  if (!uuid) throw new Error('无法在 transcript 中定位这条消息')
  return uuid
}

/**
 * Re-adopts a session whose CLI process outlived the page.
 *
 * The runner table survives a reload; the store does not. Without this the
 * composer would offer a read-only replay of a session that is still working,
 * the stop button would be inert, and the next message would `session.create`
 * a *second* process appending to the same transcript.
 */
async function adoptRunner(set: Setter, get: () => Store, sessionId: string): Promise<void> {
  let state
  try {
    state = await call('session.state', { sessionId })
  } catch {
    // Treat an unreachable server as "not live"; the reconnect path re-checks.
    return
  }
  if (!state.live || !get().sessions[sessionId]) return
  set((draft) => {
    const session = draft.sessions[sessionId]
    if (!session) return
    session.attached = true
    session.status = state.status
    // Prompts raised while the page was gone are still parked on the CLI side.
    session.pendingPermissions = state.pendingPermissions
    // So is whatever the turn already streamed but the jsonl has not flushed
    // yet — replay it through the normal path; `seen` drops the overlap with
    // history and with live events that raced this snapshot.
    for (const message of state.backlog) applyMessage(session.transcript, message)
  })
  await loadSessionMeta(set, get, sessionId)
  // The reading normally refreshes on each `result`, all of which this page
  // missed — so the meter would sit empty until the next turn otherwise.
  void loadContextUsage(set, get, sessionId)
}

function handleEvent(set: Setter, get: () => Store, event: ServerEvent): void {
  let sawInit = false
  let sawResult = false

  set((state) => {
    const session = state.sessions[event.sessionId]
    if (!session) return

    switch (event.type) {
      case 'sdk': {
        const message = event.message
        applyMessage(session.transcript, message)

        // Every in-turn API round-trip streams an assistant message whose
        // usage *is* the current context size — realtime data the ring can
        // track without polling. Subagent messages are skipped: they burn
        // their own context window, not this session's.
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          const usage = message.message.usage
          session.liveTokens =
            usage.input_tokens +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            usage.output_tokens
        }

        // Turn status line: ↓ tokens ride the main thread's streaming usage
        // (subagents burn their own budget concurrently and would interleave
        // the counters). Created lazily so a reloaded page picks the turn back
        // up from the next delta.
        if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
          const stats = (session.turnStats ??= { startedAt: Date.now(), doneTokens: 0, currentTokens: 0 })
          if (message.event.type === 'message_delta') {
            stats.currentTokens = message.event.usage.output_tokens ?? stats.currentTokens
          } else if (message.event.type === 'message_stop') {
            stats.doneTokens += stats.currentTokens
            stats.currentTokens = 0
          }
        }

        if (message.type === 'system' && message.subtype === 'init') {
          sawInit = session.init === null
          session.init = {
            model: message.model,
            cwd: message.cwd,
            version: message.claude_code_version,
            tools: message.tools,
            mcpServers: message.mcp_servers,
            slashCommands: message.slash_commands,
            terminalSlashCommands: message.terminal_slash_commands ?? [],
          }
          session.model ??= message.model
        }
        if (message.type === 'system' && message.subtype === 'commands_changed') {
          session.commands = message.commands
        }
        if (message.type === 'system' && message.subtype === 'session_state_changed') {
          session.status = message.state === 'running' ? 'running' : 'idle'
        }
        if (message.type === 'result') {
          session.status = 'idle'
          session.turnStats = null
          sawResult = true
        }
        return
      }
      case 'permission_request':
        session.pendingPermissions.push(event.request)
        return
      case 'permission_resolved':
        session.pendingPermissions = session.pendingPermissions.filter((p) => p.requestId !== event.requestId)
        return
      case 'session_error':
        session.error = event.error
        session.status = 'idle'
        // No `result` follows an errored turn, so nothing else clears these.
        session.liveTokens = null
        session.turnStats = null
        return
      case 'session_closed':
        session.closed = true
        session.status = 'idle'
        session.liveTokens = null
        session.turnStats = null
        return
    }
  })

  // `init` opens every turn, not the CLI's boot — the lists are already
  // fetched at session creation. Re-fetching on the first one covers the case
  // where those control requests raced the CLI's startup and came back empty.
  if (sawInit) void loadSessionMeta(set, get, event.sessionId)
  // Context only moves when a turn completes, so that is the cheapest moment
  // to re-read it rather than polling.
  if (sawResult) void loadContextUsage(set, get, event.sessionId)
}

/**
 * Starts the CLI process behind a session opened from the sidebar. Called
 * eagerly by `openSession`, and again by `send`/`rewindFiles` as the retry
 * path if that eager attach failed.
 *
 * Whatever mode, model, or effort was picked while detached is handed to the
 * runner at startup, since there was no process to forward those calls to.
 */
async function attach(set: Setter, get: () => Store, sessionId: string): Promise<void> {
  const session = get().sessions[sessionId]
  if (!session || session.attached) return
  await call('session.create', {
    cwd: session.cwd,
    resume: sessionId,
    permissionMode: session.permissionMode,
    effort: session.effort,
    ...(session.model ? { model: session.model } : {}),
  })
  set((state) => {
    const target = state.sessions[sessionId]
    if (target) {
      target.attached = true
      target.closed = false
    }
  })
  await loadSessionMeta(set, get, sessionId)
  // A session opened read-only has never had a reading — fetch one so the
  // meter has a denominator during the turn that is about to start.
  void loadContextUsage(set, get, sessionId)
}

/**
 * Reconciles local session state against the server's runner table. Anything
 * the server no longer runs is marked closed rather than deleted, so the
 * transcript stays readable and the sidebar can reopen it.
 */
async function reconcileSessions(set: Setter): Promise<void> {
  const { projects } = await call('history.projects', {})
  const live = new Set(projects.flatMap((project) => project.sessions.filter((s) => s.live).map((s) => s.sessionId)))
  set((state) => {
    state.projects = projects
    if (!state.defaultCwd && projects[0]) state.defaultCwd = projects[0].cwd
    for (const session of Object.values(state.sessions)) {
      // A detached session has no runner by design, and one mid-creation does
      // not have one yet — neither is evidence the server dropped anything.
      if (!session.attached) continue
      if (!live.has(session.sessionId)) {
        session.closed = true
        session.status = 'idle'
      }
    }
  })
}

/**
 * Replays a session's on-disk transcript into the store.
 *
 * A failure here is worth surfacing: an empty pane is indistinguishable from a
 * session that genuinely has no history, and silently showing one for the other
 * is how the missing replay went unnoticed in the first place.
 */
async function loadHistory(set: Setter, get: () => Store, sessionId: string, cwd: string): Promise<void> {
  try {
    const { messages, permissionMode } = await call('history.messages', { sessionId, cwd })
    if (!get().sessions[sessionId]) return
    const transcript = emptyTranscript()
    for (const entry of messages) applyHistoryMessage(transcript, entry)
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return
      session.transcript = transcript
      // Only when the transcript actually recorded a toggle; otherwise the
      // remembered default already in place is the better guess.
      if (permissionMode) session.permissionMode = permissionMode
    })
  } catch (error) {
    set((state) => {
      const session = state.sessions[sessionId]
      if (session) session.error = `读取历史记录失败：${String(error)}`
    })
  }
}

async function loadContextUsage(set: Setter, get: () => Store, sessionId: string): Promise<void> {
  try {
    const { usage } = await call('session.contextUsage', { sessionId })
    if (!get().sessions[sessionId]) return
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return
      session.contextUsage = usage
      // The authoritative reading supersedes the mid-turn estimate.
      session.liveTokens = null
    })
  } catch {
    // A session that closed mid-flight is the normal case here; the panel just
    // keeps showing the last reading.
  }
}

async function loadSessionMeta(set: Setter, get: () => Store, sessionId: string): Promise<void> {
  const [commands, models] = await Promise.allSettled([
    call('session.commands', { sessionId }),
    call('session.models', { sessionId }),
  ])
  if (!get().sessions[sessionId]) return
  set((state) => {
    const session = state.sessions[sessionId]
    if (!session) return
    if (commands.status === 'fulfilled') session.commands = commands.value.commands
    if (models.status === 'fulfilled') session.models = models.value.models
  })
}

export function useActiveSession(): SessionState | null {
  return useStore((state) => (state.activeId ? (state.sessions[state.activeId] ?? null) : null))
}
