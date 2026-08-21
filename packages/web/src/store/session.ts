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
  SlashCommand,
} from '@ccw/shared'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import { call, connectEvents, type ConnectionStatus } from '../api/client.ts'
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
  status: 'idle' | 'running'
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

function newSession(sessionId: string, cwd: string): SessionState {
  return {
    sessionId,
    cwd,
    transcript: emptyTranscript(),
    status: 'idle',
    closed: false,
    error: null,
    init: null,
    commands: [],
    models: [],
    permissionMode: 'default',
    effort: 'high',
    model: null,
    pendingPermissions: [],
    contextUsage: null,
  }
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

    createSession: async (cwd) => {
      // Register locally BEFORE the request: the CLI can emit `init` before
      // the HTTP response lands, and an event for an unknown session is
      // dropped, which would leave the command and model lists empty.
      const sessionId = crypto.randomUUID()
      set((state) => {
        state.sessions[sessionId] = newSession(sessionId, cwd)
        state.activeId = sessionId
      })
      try {
        await call('session.create', { cwd, sessionId })
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

    // Resuming replays the transcript from disk by handing the CLI the same
    // session id; the runner streams it back as ordinary events.
    openSession: async (sessionId, cwd) => {
      if (get().sessions[sessionId]) {
        set((state) => {
          state.activeId = sessionId
        })
        return
      }
      const target = cwd ?? get().defaultCwd
      set((state) => {
        state.sessions[sessionId] = newSession(sessionId, target)
        state.activeId = sessionId
      })
      try {
        await call('session.create', { cwd: target, resume: sessionId })
      } catch (error) {
        set((state) => {
          delete state.sessions[sessionId]
          if (state.activeId === sessionId) state.activeId = null
        })
        throw error
      }
      void loadSessionMeta(set, get, sessionId)
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
      if (sessionId) await call('session.interrupt', { sessionId })
    },

    setPermissionMode: async (mode) => {
      const sessionId = get().activeId
      if (!sessionId) return
      await call('session.setPermissionMode', { sessionId, mode })
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.permissionMode = mode
      })
    },

    setEffort: async (effort) => {
      const sessionId = get().activeId
      if (!sessionId) return
      await call('session.setEffort', { sessionId, effort })
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.effort = effort
      })
    },

    setModel: async (model) => {
      const sessionId = get().activeId
      if (!sessionId) return
      await call('session.setModel', { sessionId, model })
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
      // A session mid-creation has no runner yet; leave it alone.
      if (session.init === null && session.commands.length === 0) continue
      if (!live.has(session.sessionId)) {
        session.closed = true
        session.status = 'idle'
      }
    }
  })
}

async function loadContextUsage(set: Setter, get: () => Store, sessionId: string): Promise<void> {  try {
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
