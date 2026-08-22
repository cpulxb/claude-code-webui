import type {
  Attachment,
  ContextUsage,
  EffortLevel,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ProjectGroup,
  ServerEvent,
  SessionStatus,
  SlashCommand,
} from '@ccw/shared'
import { PERMISSION_MODES } from '@ccw/shared'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import { call, connectEvents, type ConnectionStatus } from '../api/client.ts'
import { applyHistoryMessage } from '../render/history.ts'
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
      return sessionId
    },

    // Opening is read-only *unless the server is already running this session*.
    // Resuming one it is not would spawn a CLI process that appends to the very
    // JSONL the terminal may have open, and two writers clobber each other — so
    // the transcript is read off disk and the runner is deferred until the user
    // actually says something.
    openSession: async (sessionId, cwd) => {
      if (get().sessions[sessionId]) {
        set((state) => {
          state.activeId = sessionId
        })
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
        return
      case 'session_closed':
        session.closed = true
        session.status = 'idle'
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
 * Starts the CLI process behind a session opened read-only from the sidebar.
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
      if (session) session.contextUsage = usage
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
