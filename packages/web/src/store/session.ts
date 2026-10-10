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
  SessionFlags,
  SessionSummary,
  SlashCommand,
} from '@ccw/shared'
import { mergeProjectSessions, PERMISSION_MODES } from '@ccw/shared'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import { call, connectEvents, type ConnectionStatus } from '../api/client.ts'
import { applyHistoryMessage, listUserPromptUuids } from '../render/history.ts'
import { applyMessage, emptyTranscript, findAgent, type AgentRun, type Transcript } from '../render/nodes.ts'

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
  /** Ultracode on for this session (dynamic workflows at the picked effort). */
  ultracode: boolean
  /** The CLI says ultracode can be turned on: workflows enabled and the model supports it. */
  ultracodeAvailable: boolean
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
  /**
   * The subagent whose conversation the chat pane shows instead of the main
   * thread, by the Agent tool_use id that spawned it. Null for the main thread.
   */
  viewAgent: string | null
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
  setUltracode: (on: boolean) => Promise<void>
  setModel: (model: string) => Promise<void>
  refreshModels: () => Promise<void>
  respondToPermission: (requestId: string, decision: PermissionDecision) => Promise<void>
  /** dryRun previews; a real run bumps `fsVersion` and posts a notice node. */
  rewindFiles: (nodeId: string, dryRun: boolean) => Promise<RewindFilesResult>
  /** Bumps `fsVersion` after an out-of-band write (editor-tab save). */
  touchFs: (sessionId: string) => void
  /** Shows a subagent's conversation in the chat pane; null goes back to the main thread. */
  openAgent: (toolUseId: string | null) => Promise<void>
  stopAgent: (toolUseId: string) => Promise<void>
  backgroundAgent: (toolUseId: string) => Promise<void>
}

function newSession(sessionId: string, cwd: string, attached: boolean): SessionState {
  snapshotVersions.set(sessionId, newSnapshotVersions())
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
    ultracode: false,
    ultracodeAvailable: false,
    model: null,
    pendingPermissions: [],
    contextUsage: null,
    liveTokens: null,
    turnStats: null,
    fsVersion: 0,
    viewAgent: null,
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

/**
 * Sessions whose runner is being spawned right now. They already read as
 * attached, but the server does not list them yet — reconciliation has to leave
 * them alone for the ~1s the CLI takes to come up.
 */
const starting = new Set<string>()

/**
 * Sessions where the user picked an effort level in this tab. `effort` starts
 * at the store's guess, which is not what the CLI is actually on, so resuming
 * only forwards a level that was really chosen.
 */
const effortPicked = new Set<string>()
/** Same for ultracode: session-only, so a resume must replay a choice made here. */
const ultracodePicked = new Set<string>()
/** Latest effort request per session; older ones still in their delay are dropped. */
const effortSeq = new Map<string, number>()
const EFFORT_SEND_DELAY_MS = 120
const modelRequests = new Map<string, object>()

// A history read can finish after a new session or prompt arrives. Replay only
// those newer sidebar updates on top of it, and ignore older overlapping reads.
const projectReads = new Set<Map<string, SessionSummary | null>>()
let projectReadVersion = 0

function updateProjectSession(set: Setter, summary: SessionSummary): void {
  for (const changes of projectReads) changes.set(summary.sessionId, summary)
  set((state) => { state.projects = mergeProjectSessions(state.projects, [summary]) })
}

function removeProjectSession(set: Setter, sessionId: string): void {
  for (const changes of projectReads) changes.set(sessionId, null)
  set((state) => {
    state.projects = state.projects.map((project) => ({
      ...project, sessions: project.sessions.filter((session) => session.sessionId !== sessionId),
    })).filter((project) => project.sessions.length > 0)
  })
}

/**
 * Bumped every time a `session_closed` event lands for a session. `attach`
 * samples it before spawning and again before marking the session attached: a
 * CLI that dies on startup (bad cwd, bad model) emits `session_closed` right
 * after the create response, and without this the stale `attached = true`
 * would win and leave the session unrecoverable from the sidebar.
 *
 * Grows monotonically: the bump in `handleEvent` is deliberately unfiltered, so
 * this also records sessions this tab never opened, while `forgetSession` only
 * drops the ones closed from here. Left uncapped on purpose — an entry is a
 * uuid and an int, the bound is "sessions that closed during this page's life",
 * and a reload clears it. Any eviction rule could drop an epoch an in-flight
 * `attach` is about to compare against, which is the wedge this map prevents.
 */
const closedEpoch = new Map<string, number>()

type PermissionChanges = Map<string, PermissionRequest | null>
type SnapshotVersions = { status: number; permissions: number; pending: Set<PermissionChanges> }

// Kept separate from streaming data: token deltas must not prevent a reconnect
// from adopting a snapshot. A fresh object also identifies a reopened session.
const snapshotVersions = new Map<string, SnapshotVersions>()

function newSnapshotVersions(): SnapshotVersions {
  return { status: 0, permissions: 0, pending: new Set() }
}

function versionsFor(sessionId: string): SnapshotVersions {
  let versions = snapshotVersions.get(sessionId)
  if (!versions) {
    versions = newSnapshotVersions()
    snapshotVersions.set(sessionId, versions)
  }
  return versions
}

function setSessionStatus(session: SessionState, status: SessionStatus): void {
  session.status = status
  versionsFor(session.sessionId).status += 1
}

// Record only while a snapshot is in flight. Per-request changes let it recover
// prompts missed offline without reviving a prompt resolved during the read.
function recordPermissionChange(sessionId: string, requestId: string, request: PermissionRequest | null): void {
  for (const changes of versionsFor(sessionId).pending) changes.set(requestId, request)
}

/** Drops the per-session bookkeeping held outside the store. */
function forgetSession(sessionId: string): void {
  starting.delete(sessionId)
  effortPicked.delete(sessionId)
  ultracodePicked.delete(sessionId)
  modelRequests.delete(sessionId)
  closedEpoch.delete(sessionId)
  snapshotVersions.delete(sessionId)
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
          if (status === 'open') {
            // Without a catch this is an unhandled rejection. Nothing is
            // reset on failure: a `history.projects` that did not answer is no
            // evidence about which runners are alive, and the next reconnect
            // runs this again.
            void reconcileSessions(set, get).catch(() => {})
          }
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
        if (remembered.agent) await get().openAgent(remembered.agent).catch(() => {})
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
      updateProjectSession(set, { sessionId, cwd, summary: '', lastModified: Date.now(), live: true })
      starting.add(sessionId)
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
        removeProjectSession(set, sessionId)
        forgetSession(sessionId)
        throw error
      } finally {
        starting.delete(sessionId)
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
        // e.g. opened before the runner existed, the eager attach failed, or
        // the runner has since gone away (server restart) — reopening from the
        // sidebar is how a closed session is meant to come back, and is also
        // the only automatic caller (`restoreActive`, once per reload), so a
        // doomed CLI is never spawned in a loop.
        const retrying = !known.attached
        set((state) => {
          state.activeId = sessionId
          // Cleared only when this click really starts a new attempt, so the
          // row does not keep a stale error while it runs. The sidebar is also
          // the only way to switch sessions, so clearing unconditionally would
          // wipe a live failure (a failed send, a failed history read, a
          // `session_error`) on a plain switch away and back, with nothing
          // taking over the display.
          if (retrying) {
            const session = state.sessions[sessionId]
            if (session) session.error = null
          }
        })
        if (retrying) void eagerAttach(set, get, sessionId)
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
      if (!get().sessions[sessionId]?.attached) void eagerAttach(set, get, sessionId)
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
      forgetSession(sessionId)
      // The sidebar's live dots come from the runner table, so they only go
      // stale if the list is not re-read here.
      await get().refreshProjects()
    },

    refreshProjects: async () => {
      await loadProjects(set)
    },

    send: async (text, attachments) => {
      const sessionId = get().activeId
      if (!sessionId) return
      try {
        await attach(set, get, sessionId)
      } catch (error) {
        // Nothing was echoed yet, so the message is simply not sent — say so
        // instead of letting the click look like it worked.
        set((state) => {
          const session = state.sessions[sessionId]
          if (session) session.error = `无法启动会话：${String(error)}`
        })
        return
      }
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
        setSessionStatus(session, 'running')
        session.error = null
        session.turnStats = { startedAt: Date.now(), doneTokens: 0, currentTokens: 0 }
      })
      try {
        await call('session.send', { sessionId, text, ...(attachments?.length ? { attachments } : {}) })
      } catch (error) {
        // No turn was started, so no `result` will ever clear the running state.
        set((state) => {
          const session = state.sessions[sessionId]
          if (!session) return
          setSessionStatus(session, 'idle')
          session.turnStats = null
          session.error = `发送失败：${String(error)}`
        })
      }
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
      // Optimistic: the slider must move under the pointer, not one CLI
      // round-trip later. Rapid drags send only the newest level.
      effortPicked.add(sessionId)
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.effort = effort
      })
      if (!get().sessions[sessionId]?.attached) return
      const seq = (effortSeq.get(sessionId) ?? 0) + 1
      effortSeq.set(sessionId, seq)
      await new Promise((resolve) => setTimeout(resolve, EFFORT_SEND_DELAY_MS))
      if (effortSeq.get(sessionId) !== seq) return
      await call('session.setEffort', { sessionId, effort })
    },

    setUltracode: async (on) => {
      const sessionId = get().activeId
      if (!sessionId) return
      ultracodePicked.add(sessionId)
      // Flip first so the switch animates on click rather than after the round-trip.
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.ultracode = on
      })
      if (!get().sessions[sessionId]?.attached) return
      try {
        const flags = await call('session.setUltracode', { sessionId, on })
        set((state) => applyFlags(state.sessions[sessionId], flags))
      } catch (error) {
        set((state) => {
          const session = state.sessions[sessionId]
          if (!session) return
          session.ultracode = !on
          session.error = `切换 Ultracode 失败：${String(error)}`
        })
      }
    },

    setModel: async (model) => {
      const sessionId = get().activeId
      if (!sessionId) return
      modelRequests.delete(sessionId)
      if (get().sessions[sessionId]?.attached) await call('session.setModel', { sessionId, model })
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.model = model
      })
    },

    refreshModels: async () => {
      const sessionId = get().activeId
      if (!sessionId || !get().sessions[sessionId]?.attached) return
      try {
        await loadSessionModels(set, get, sessionId)
      } catch (error) {
        set((state) => {
          const session = state.sessions[sessionId]
          if (session) session.error = `读取模型列表失败：${String(error)}`
        })
      }
    },

    respondToPermission: async (requestId, decision) => {
      const sessionId = get().activeId
      if (!sessionId) return
      // Drop it locally right away so a double-click cannot answer twice.
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) {
          session.pendingPermissions = session.pendingPermissions.filter((p) => p.requestId !== requestId)
          recordPermissionChange(sessionId, requestId, null)
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

    openAgent: async (toolUseId) => {
      const sessionId = get().activeId
      if (!sessionId) return
      set((state) => {
        const session = state.sessions[sessionId]
        if (session) session.viewAgent = toolUseId && findAgent(session.transcript, toolUseId) ? toolUseId : null
      })
      if (toolUseId) await loadAgentHistory(set, get, sessionId, toolUseId)
    },

    stopAgent: async (toolUseId) => {
      const sessionId = get().activeId
      const session = sessionId ? get().sessions[sessionId] : undefined
      const agent = session && findAgent(session.transcript, toolUseId)
      if (!sessionId || !session?.attached || !agent?.agentId) return
      await call('session.stopTask', { sessionId, taskId: agent.agentId })
    },

    backgroundAgent: async (toolUseId) => {
      const sessionId = get().activeId
      if (!sessionId || !get().sessions[sessionId]?.attached) return
      await call('session.backgroundTask', { sessionId, toolUseId })
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
    const value = JSON.stringify({
      sessionId: session.sessionId,
      cwd: session.cwd,
      ...(session.viewAgent ? { agent: session.viewAgent } : {}),
    })
    // The subscription fires on every streamed token; only the two fields
    // above are persisted, so skip the synchronous write when they are
    // unchanged. Compared against what is actually stored, so a removal from
    // elsewhere (`restoreActive` clearing a dead session) is written again.
    if (value === localStorage.getItem(ACTIVE_KEY)) return
    localStorage.setItem(ACTIVE_KEY, value)
  } else if (state.activeId === null) {
    localStorage.removeItem(ACTIVE_KEY)
  }
})

function readRememberedSession(): { sessionId: string; cwd: string; agent?: string } | null {
  const raw = localStorage.getItem(ACTIVE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { sessionId?: unknown; cwd?: unknown; agent?: unknown }
    if (typeof parsed.sessionId !== 'string' || typeof parsed.cwd !== 'string') return null
    return {
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      ...(typeof parsed.agent === 'string' ? { agent: parsed.agent } : {}),
    }
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
  if (!get().sessions[sessionId]) return
  const versions = versionsFor(sessionId)
  const { status: statusVersion, permissions: permissionsVersion } = versions
  const epoch = closedEpoch.get(sessionId) ?? 0
  const permissionChanges: PermissionChanges = new Map()
  versions.pending.add(permissionChanges)
  let state
  try {
    state = await call('session.state', { sessionId })
  } catch {
    // Treat an unreachable server as "not live"; the reconnect path re-checks.
    return
  } finally {
    versions.pending.delete(permissionChanges)
  }
  // A close or a new local instance invalidates the entire snapshot. Other
  // events only invalidate their own fields, so missed messages still replay.
  if (!state.live || snapshotVersions.get(sessionId) !== versions || (closedEpoch.get(sessionId) ?? 0) !== epoch) return
  set((draft) => {
    const session = draft.sessions[sessionId]
    if (!session || session.closed) return
    session.attached = true
    if (versions.status === statusVersion) setSessionStatus(session, state.status)
    // Merge events received during the read over its permission list. The
    // version excludes older overlapping snapshots that finish after this one.
    if (versions.permissions === permissionsVersion) {
      const pending = new Map(state.pendingPermissions.map((request) => [request.requestId, request]))
      for (const [requestId, request] of permissionChanges) {
        if (request) pending.set(requestId, request)
        else pending.delete(requestId)
      }
      session.pendingPermissions = [...pending.values()]
      versions.permissions += 1
    }
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
  if (event.type === 'session_updated') {
    updateProjectSession(set, event.summary)
    return
  }
  let sawInit = false
  let sawResult = false

  // Recorded outside the store update so `attach` can see it even for a
  // session the store has already dropped.
  if (event.type === 'session_closed') {
    closedEpoch.set(event.sessionId, (closedEpoch.get(event.sessionId) ?? 0) + 1)
  }

  set((state) => {
    const session = state.sessions[event.sessionId]
    if (!session) return

    switch (event.type) {
      case 'session_flags':
        applyFlags(session, event)
        return
      case 'session_models':
        modelRequests.delete(event.sessionId)
        if (JSON.stringify(session.models) !== JSON.stringify(event.models)) session.models = event.models
        session.model = event.model
        return
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
          // Same rule the runner applies: assistant output only happens inside
          // a turn. A turn the CLI started on its own — a queued prompt that
          // survived an interrupt — would otherwise leave the composer idle
          // with no way to stop it. Subagent output is excluded because it
          // keeps streaming after the main thread has stopped.
          setSessionStatus(session, 'running')
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
          setSessionStatus(session, message.state === 'running' ? 'running' : 'idle')
        }
        if (message.type === 'result') {
          setSessionStatus(session, 'idle')
          session.turnStats = null
          sawResult = true
        }
        return
      }
      case 'permission_request':
        session.pendingPermissions.push(event.request)
        recordPermissionChange(event.sessionId, event.request.requestId, event.request)
        return
      case 'permission_resolved':
        session.pendingPermissions = session.pendingPermissions.filter((p) => p.requestId !== event.requestId)
        recordPermissionChange(event.sessionId, event.requestId, null)
        return
      case 'session_error':
        session.error = event.error
        setSessionStatus(session, 'idle')
        // No `result` follows an errored turn, so nothing else clears these.
        session.liveTokens = null
        session.turnStats = null
        return
      case 'session_closed':
        session.closed = true
        // The runner is gone, so nothing is attached any more. Without this the
        // session could never be re-attached: `attach` early-returns on
        // `attached`, and reopening from the sidebar would be a no-op.
        session.attached = false
        setSessionStatus(session, 'idle')
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
  if (event.type === 'session_closed' || (event.type === 'sdk' && event.message.type === 'result')) {
    // Also refresh for sessions opened in another tab. Their saved titles and
    // live indicators belong in this sidebar even without a local transcript.
    void get().refreshProjects().catch(() => {})
  }
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
  starting.add(sessionId)
  const epoch = closedEpoch.get(sessionId) ?? 0
  try {
    await call('session.create', {
      cwd: session.cwd,
      resume: sessionId,
      permissionMode: session.permissionMode,
      // Only when it was really chosen here: forwarding the store's default
      // would silently reset whatever the resumed session was running on.
      ...(effortPicked.has(sessionId) ? { effort: session.effort } : {}),
      ...(ultracodePicked.has(sessionId) ? { ultracode: session.ultracode } : {}),
      ...(session.model ? { model: session.model } : {}),
    })
  } finally {
    starting.delete(sessionId)
  }
  // A `session_closed` that arrived while the create request was in flight
  // means the runner is already gone; overwriting it here is what used to
  // wedge the session as permanently "attached" with no process behind it.
  if ((closedEpoch.get(sessionId) ?? 0) !== epoch) {
    throw new Error('会话进程刚启动就退出了')
  }
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
 * The eager attach `openSession` fires without waiting. Rendering must not
 * block on a CLI boot, but the failure must not vanish either: a session that
 * silently stayed detached looked open while nothing could be sent.
 */
function eagerAttach(set: Setter, get: () => Store, sessionId: string): void {
  attach(set, get, sessionId).catch((error: unknown) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (session) session.error = `无法恢复会话：${String(error)}`
    })
  })
}

/**
 * Reconciles local session state against the server's runner table. Anything
 * the server no longer runs is marked closed rather than deleted, so the
 * transcript stays readable and the sidebar can reopen it.
 */
async function reconcileSessions(set: Setter, get: () => Store): Promise<void> {
  const projects = await loadProjects(set)
  if (!projects) return
  const live = new Set(projects.flatMap((project) => project.sessions.filter((s) => s.live).map((s) => s.sessionId)))
  const resync: string[] = []
  set((state) => {
    for (const session of Object.values(state.sessions)) {
      // A detached session has no runner by design, and one mid-creation does
      // not have one yet — neither is evidence the server dropped anything.
      if (!session.attached || starting.has(session.sessionId)) continue
      if (live.has(session.sessionId)) {
        resync.push(session.sessionId)
      } else {
        session.closed = true
        session.attached = false
        setSessionStatus(session, 'idle')
      }
    }
  })
  // The downlink was down while these kept working: re-adopt them so the turn
  // they streamed meanwhile is replayed instead of leaving a hole.
  for (const sessionId of resync) {
    // Its immer recipe runs `applyMessage` over the server's backlog, so a
    // message shape the renderer chokes on would be an unhandled rejection on
    // every reconnect. Immer commits no partial draft, so the session keeps the
    // attached state it already had and only this re-adoption is lost — logged
    // rather than surfaced, since the next reconnect runs it again.
    adoptRunner(set, get, sessionId).catch((error: unknown) => {
      console.error('[ccw] session resync failed', sessionId, error)
    })
  }
}

async function loadProjects(set: Setter): Promise<ProjectGroup[] | undefined> {
  const version = ++projectReadVersion
  const changes = new Map<string, SessionSummary | null>()
  projectReads.add(changes)
  try {
    const { projects } = await call('history.projects', {})
    if (version !== projectReadVersion) return
    const merged = mergeProjectSessions(projects, [...changes.values()].filter((value): value is SessionSummary => value !== null))
      .map((project) => ({
        ...project, sessions: project.sessions.filter((session) => changes.get(session.sessionId) !== null),
      })).filter((project) => project.sessions.length > 0)
    set((state) => {
      state.projects = merged
      if (!state.defaultCwd && merged[0]) state.defaultCwd = merged[0].cwd
    })
    return merged
  } finally {
    projectReads.delete(changes)
  }
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
    const [{ messages, permissionMode }, subagents] = await Promise.all([
      call('history.messages', { sessionId, cwd }),
      // Optional: without it the cards still render, they just cannot open
      // a conversation until a live event names the agent.
      call('history.subagents', { sessionId }).catch(() => ({ agents: [] })),
    ])
    if (!get().sessions[sessionId]) return
    const transcript = emptyTranscript()
    for (const entry of messages) applyHistoryMessage(transcript, entry)
    for (const meta of subagents.agents) {
      const agent = meta.toolUseId ? findAgent(transcript, meta.toolUseId) : null
      if (!agent) continue
      agent.agentId ??= meta.agentId
      if (!agent.subagentType && meta.agentType) agent.subagentType = meta.agentType
      if (!agent.description && meta.description) agent.description = meta.description
    }
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
  const [commands] = await Promise.allSettled([
    call('session.commands', { sessionId }),
    loadSessionModels(set, get, sessionId),
  ])
  if (!get().sessions[sessionId]) return
  set((state) => {
    const session = state.sessions[sessionId]
    if (!session) return
    if (commands.status === 'fulfilled') session.commands = commands.value.commands
  })
}

/**
 * Takes the CLI's own reading of effort and ultracode. A null effort (no
 * effort parameter will be sent) keeps the slider where it was.
 */
function applyFlags(session: SessionState | undefined, flags: SessionFlags): void {
  if (!session) return
  if (flags.effort !== null && session.effort !== flags.effort) session.effort = flags.effort
  if (session.ultracode !== flags.ultracode) session.ultracode = flags.ultracode
  if (session.ultracodeAvailable !== flags.ultracodeAvailable) session.ultracodeAvailable = flags.ultracodeAvailable
}

async function loadSessionFlags(set: Setter, sessionId: string): Promise<void> {
  try {
    const flags = await call('session.flags', { sessionId })
    set((state) => applyFlags(state.sessions[sessionId], flags))
  } catch {
    // An older CLI without get_settings: the Ultracode row just stays hidden.
  }
}

async function loadSessionModels(set: Setter, get: () => Store, sessionId: string): Promise<void> {
  void loadSessionFlags(set, sessionId)
  const request = {}
  const selected = get().sessions[sessionId]?.model
  const lifetime = snapshotVersions.get(sessionId)
  modelRequests.set(sessionId, request)
  try {
    const { models, model } = await call('session.models', { sessionId })
    if (modelRequests.get(sessionId) !== request || snapshotVersions.get(sessionId) !== lifetime) return
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return
      // Background configuration checks must not reset a keyboard selection
      // or rerender the menu when its rows have not changed.
      if (JSON.stringify(session.models) !== JSON.stringify(models)) session.models = models
      if (model !== undefined && session.model === selected) session.model = model
    })
  } finally {
    if (modelRequests.get(sessionId) === request) modelRequests.delete(sessionId)
  }
}

/**
 * Subscribes to one slice of the active session. Immer replaces the session
 * object on every transcript mutation, so subscribing to the whole session
 * re-renders the caller once per streamed token; a primitive slice does not.
 */
export function useActiveSessionValue<T>(select: (session: SessionState) => T): T | undefined {
  return useStore((state) => {
    const session = state.activeId ? state.sessions[state.activeId] : undefined
    return session ? select(session) : undefined
  })
}

/**
 * Folds a subagent's on-disk transcript into its view the first time it is
 * opened. A subagent still streaming into a live view is left alone: its
 * events already built the view, and the JSONL may lag behind them.
 */
async function loadAgentHistory(set: Setter, get: () => Store, sessionId: string, toolUseId: string): Promise<void> {
  const session = get().sessions[sessionId]
  const agent: AgentRun | null = session ? findAgent(session.transcript, toolUseId) : null
  if (!session || !agent || agent.historyLoaded) return
  if (agent.status === 'running' && agent.transcript.nodes.length > 0) return
  let agentId = agent.agentId
  if (!agentId) {
    const { agents } = await call('history.subagents', { sessionId })
    agentId = agents.find((meta) => meta.toolUseId === toolUseId)?.agentId
  }
  if (!agentId) return
  const { messages } = await call('history.subagent', { sessionId, agentId })
  const rebuilt = emptyTranscript()
  for (const entry of messages) applyHistoryMessage(rebuilt, entry)
  set((state) => {
    const target = state.sessions[sessionId]
    const draft = target && findAgent(target.transcript, toolUseId)
    if (!draft) return
    draft.agentId ??= agentId
    draft.historyLoaded = true
    // Nothing on disk yet (still spawning) — keep whatever streamed live.
    if (rebuilt.nodes.length === 0) return
    // History is the complete record; live-only nodes it does not know of
    // would be newer output, which `seen` lets the stream re-add on arrival.
    rebuilt.agents = { ...rebuilt.agents, ...draft.transcript.agents }
    rebuilt.agentOrder = [...new Set([...rebuilt.agentOrder, ...draft.transcript.agentOrder])]
    draft.transcript = rebuilt
  })
}
