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
  SessionMessage,
  SessionStatus,
  SessionFlags,
  SessionSummary,
  SlashCommand,
  SubagentMeta,
  TurnTotals,
  UpdateStatus,
} from '@ccw/shared'
import { mergeProjectSessions, PERMISSION_MODES } from '@ccw/shared'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import { call, connectEvents, type ConnectionStatus } from '../api/client.ts'
import { bashDisplay, bashEcho, bashPrompt } from '../render/bash.ts'
import { appendTranscript, applyHistoryMessage, applyTurnTotals, listUserPromptUuids, prependTranscript } from '../render/history.ts'
import { applyMessage, emptyTranscript, findAgent, type AgentRun, type Transcript } from '../render/nodes.ts'
import { applyWorkflowRecord } from '../render/workflows.ts'

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
  /**
   * Uuid of the oldest history entry shown while older ones remain on disk;
   * null once the transcript is complete. History arrives a page at a time,
   * newest first, as the reader scrolls up.
   */
  historyCursor: string | null
  historyLoading: boolean
  /** The last page read failed; shown where that page would go, with a retry. */
  historyError: string | null
  /**
   * Uuid of the newest entry shown while newer ones are on disk — the session
   * was opened at an older entry; null once the transcript reaches the end.
   * Live output has nowhere to go meanwhile, so it is held back, and the
   * runner's backlog replays the turn in flight once the end is reached.
   */
  newerCursor: string | null
  newerLoading: boolean
  newerError: string | null
  /**
   * Where the main thread's view goes: the user message with this uuid, or
   * the end for a null id. A fresh object per request, so asking for the same
   * place again moves the view again; null when nothing asked yet.
   */
  anchor: { id: string | null } | null
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
  /**
   * The project last picked in the sidebar's switcher, kept across reloads.
   * Null until one is picked; `useProjectCwd` fills the gap.
   */
  selectedCwd: string | null
  /** The server's release status; null until the first connect answers. */
  update: UpdateStatus | null
  /**
   * The settings page at `/settings`, opened from the sidebar and from the
   * model menu. It covers the workspace, whose sessions keep running beneath.
   */
  settingsOpen: boolean
  /**
   * Passages picked out of the conversation to reply to, shown over the
   * composer and sent ahead of the next prompt. Like the typed text, they stay
   * through a session switch.
   */
  quotes: string[]

  connect: () => () => void
  createSession: (cwd: string) => Promise<string>
  /** `at`: an entry to open at — a user message's uuid, or a subagent's tool call — instead of the newest. */
  openSession: (sessionId: string, cwd?: string, at?: string) => Promise<void>
  /** Puts the next page of on-disk history above what is shown. No-op while one is loading. */
  loadOlderHistory: (sessionId: string) => Promise<void>
  /** Puts the next page below what is shown, for a session opened at an older entry. */
  loadNewerHistory: (sessionId: string) => Promise<void>
  /** Moves the view to the end of the transcript, where replies land — reading it in first if it is not shown. */
  jumpToLatest: (sessionId: string) => Promise<void>
  /** Reads again the history page that failed — the newest one, or the next older one. */
  retryHistory: (sessionId: string) => Promise<void>
  setActive: (sessionId: string | null) => void
  /** Makes `cwd` the project the sidebar lists and the details panel works in. */
  selectProject: (cwd: string) => void
  closeSession: (sessionId: string) => Promise<void>
  refreshProjects: () => Promise<void>

  send: (text: string, attachments?: Attachment[]) => Promise<void>
  /** `!` mode: runs the command, shows its output, then sends both on to the model as the terminal does. */
  runShell: (command: string) => Promise<void>
  renameSession: (title: string) => Promise<void>
  /** Retitles any session on disk, open or not — the sidebar's rename. Throws on failure. */
  renameSavedSession: (sessionId: string, cwd: string, title: string) => Promise<void>
  /** `/branch`: forks the active session and switches to the copy. */
  forkSession: (title?: string) => Promise<void>
  /** A transient line in the active transcript — feedback for commands the browser handles itself. */
  addNotice: (level: 'info' | 'error', text: string) => void
  interrupt: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setEffort: (effort: EffortLevel) => Promise<void>
  setUltracode: (on: boolean) => Promise<void>
  setModel: (model: string) => Promise<void>
  refreshModels: () => Promise<void>
  respondToPermission: (requestId: string, decision: PermissionDecision) => Promise<void>
  /** The address that opens the active session at this user message. */
  messageLink: (nodeId: string) => Promise<string>
  /** dryRun previews; a real run bumps `fsVersion` and posts a notice node. */
  rewindFiles: (nodeId: string, dryRun: boolean) => Promise<RewindFilesResult>
  /** Bumps `fsVersion` after an out-of-band write (editor-tab save). */
  touchFs: (sessionId: string) => void
  /** Shows a subagent's conversation in the chat pane; null goes back to the main thread. */
  openAgent: (toolUseId: string | null) => Promise<void>
  stopAgent: (toolUseId: string) => Promise<void>
  backgroundAgent: (toolUseId: string) => Promise<void>
  /** Re-reads a running workflow agent's transcript, which the stream never carries. */
  refreshAgent: (toolUseId: string) => Promise<void>
  /** Stops a whole dynamic workflow run (its background task). */
  stopWorkflow: (toolUseId: string) => Promise<void>
  /** Installs the release in `update.latest`; the server restarts when it is done. */
  applyUpdate: () => Promise<void>
  /** Asks the server to look for a release now; resolves with what it found. */
  checkUpdate: () => Promise<UpdateStatus>
  setSettingsOpen: (open: boolean) => void
  setQuotes: (quotes: string[]) => void
}

function newSession(sessionId: string, cwd: string, attached: boolean): SessionState {
  snapshotVersions.set(sessionId, newSnapshotVersions())
  return {
    sessionId,
    cwd,
    transcript: emptyTranscript(),
    historyCursor: null,
    historyLoading: false,
    historyError: null,
    newerCursor: null,
    newerLoading: false,
    newerError: null,
    anchor: null,
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

/** The sidebar's project survives a reload, even with no session open. */
const SELECTED_PROJECT_KEY = 'ccw.selectedProject'

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
/**
 * Sessions with a `session.flags` call in flight. The 2 s model poll fires one
 * per tick without waiting for it, so a CLI that stops answering control
 * requests would otherwise collect one stuck call per tick until close.
 */
const flagRequests = new Set<string>()

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
    selectedCwd: localStorage.getItem(SELECTED_PROJECT_KEY),
    update: null,
    settingsOpen: false,
    quotes: [],

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
            void loadUpdateStatus(set, get).catch(() => {})
          }
        },
        onEvent: (event) => handleEvent(set, get, event),
      }),

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
      // The boot cost (system prompt, tools, memory files) is context already
      // spent — read it so the ring shows during the first turn, not after.
      // The CLI answers control requests one at a time and context usage
      // tokenizes the transcript, so it goes after the model menu, not beside it.
      void loadSessionMeta(set, get, sessionId).finally(() => loadContextUsage(set, get, sessionId))
      return sessionId
    },

    // Opening eagerly attaches, VS Code style: the transcript renders from
    // disk first, then the runner resumes in the background so slash commands
    // and models are ready before the first message. The tradeoff is a CLI
    // process per opened session — and, as in VS Code, resuming a session a
    // terminal still has open means two writers on one JSONL.
    openSession: async (sessionId, cwd, at) => {
      // An address names only the session; the server knows where it runs.
      const target = cwd ?? get().sessions[sessionId]?.cwd ?? (await locateSession(sessionId))
      const known = get().sessions[sessionId]
      if (known) {
        // e.g. opened before the runner existed, the eager attach failed, or
        // the runner has since gone away (server restart) — reopening from the
        // sidebar is how a closed session is meant to come back, and the only
        // automatic caller follows the address bar (once per load, then per
        // back/forward), so a doomed CLI is never spawned in a loop.
        const retrying = !known.attached
        set((state) => {
          state.activeId = sessionId
          // Cleared only when this click really starts a new attempt, so the
          // row does not keep a stale error while it runs. Every switch between
          // sessions comes through here, so clearing unconditionally would
          // wipe a live failure (a failed send, a `session_error`) on a plain
          // switch away and back, with nothing
          // taking over the display.
          if (retrying) {
            const session = state.sessions[sessionId]
            if (session) session.error = null
          }
        })
        if (retrying) void eagerAttach(set, get, sessionId)
        // Already read in: only the view moves. Otherwise the transcript does.
        if (at && holdsEntry(known.transcript, at)) {
          if (isUserNode(known.transcript, at)) {
            set((state) => {
              state.sessions[sessionId]!.anchor = { id: at }
            })
          }
        } else if (at) {
          await moveWindow(set, get, sessionId, at).catch((error: unknown) => {
            pushNotice(set, sessionId, 'error', `读取历史记录失败：${String(error)}`)
            // Still where it was asked to go, not "gone from the session".
            set((state) => {
              const session = state.sessions[sessionId]
              if (session) session.anchor = { id: at }
            })
          })
        }
        return
      }
      set((state) => {
        state.sessions[sessionId] = newSession(sessionId, target, false)
        state.activeId = sessionId
      })
      // Ordered, not raced: adopting can start delivering live events, and the
      // history replay overwrites the whole transcript when it lands.
      await loadHistory(set, get, sessionId, target, at)
      await adoptRunner(set, get, sessionId)
      // Fire-and-forget: rendering must not wait for a CLI to boot. A failure
      // leaves the session detached, and `send` retries the attach anyway.
      if (!get().sessions[sessionId]?.attached) void eagerAttach(set, get, sessionId)
    },

    loadOlderHistory: async (sessionId) => {
      const session = get().sessions[sessionId]
      const before = session?.historyCursor
      if (!session || !before || session.historyLoading) return
      set((state) => {
        state.sessions[sessionId]!.historyLoading = true
      })
      try {
        const [{ messages, hasMore, turns }, subagents] = await Promise.all([
          call('history.messages', { sessionId, cwd: session.cwd, limit: HISTORY_PAGE, before }),
          call('history.subagents', { sessionId }).catch(() => ({ agents: [] })),
        ])
        const older = await replayHistory(sessionId, messages, subagents.agents, turns)
        set((state) => {
          const current = state.sessions[sessionId]
          // Reopened meanwhile: that replay owns the transcript now.
          if (current?.historyCursor !== before) return
          prependTranscript(current.transcript, older)
          current.historyCursor = hasMore ? (messages[0]?.uuid ?? null) : null
          current.historyError = null
        })
      } catch (error) {
        set((state) => {
          const current = state.sessions[sessionId]
          if (current) current.historyError = `读取更早的历史记录失败：${String(error)}`
        })
      } finally {
        set((state) => {
          const current = state.sessions[sessionId]
          if (current) current.historyLoading = false
        })
      }
    },

    loadNewerHistory: async (sessionId) => {
      const session = get().sessions[sessionId]
      const after = session?.newerCursor
      if (!session || !after || session.newerLoading) return
      set((state) => {
        state.sessions[sessionId]!.newerLoading = true
      })
      try {
        const [{ messages, hasNewer, turns }, subagents] = await Promise.all([
          call('history.messages', { sessionId, cwd: session.cwd, limit: HISTORY_PAGE, after }),
          call('history.subagents', { sessionId }).catch(() => ({ agents: [] })),
        ])
        const newer = await replayHistory(sessionId, messages, subagents.agents, turns)
        set((state) => {
          const current = state.sessions[sessionId]
          // Moved meanwhile: that replay owns the transcript now.
          if (current?.newerCursor !== after) return
          appendTranscript(current.transcript, newer)
          current.newerCursor = hasNewer ? (messages.at(-1)?.uuid ?? null) : null
          current.newerError = null
        })
        // At the end again: the turn in flight streamed past the held-back view.
        if (!hasNewer) await adoptRunner(set, get, sessionId)
      } catch (error) {
        set((state) => {
          const current = state.sessions[sessionId]
          if (current) current.newerError = `读取更新的历史记录失败：${String(error)}`
        })
      } finally {
        set((state) => {
          const current = state.sessions[sessionId]
          if (current) current.newerLoading = false
        })
      }
    },

    jumpToLatest: async (sessionId) => {
      const session = get().sessions[sessionId]
      if (!session) return
      if (!session.newerCursor) {
        set((state) => {
          state.sessions[sessionId]!.anchor = { id: null }
        })
        return
      }
      set((state) => {
        state.sessions[sessionId]!.newerLoading = true
      })
      try {
        await moveWindow(set, get, sessionId)
      } catch (error) {
        pushNotice(set, sessionId, 'error', `回到最新的消息失败：${String(error)}`)
      } finally {
        set((state) => {
          const current = state.sessions[sessionId]
          if (current) current.newerLoading = false
        })
      }
    },

    retryHistory: async (sessionId) => {
      const session = get().sessions[sessionId]
      if (!session || session.historyLoading) return
      if (session.historyCursor) return get().loadOlderHistory(sessionId)
      set((state) => {
        state.sessions[sessionId]!.historyLoading = true
      })
      // The first page never arrived: replay it as opening the session does,
      // then re-adopt, so a running turn's backlog lands on top of it again.
      await loadHistory(set, get, sessionId, session.cwd, session.anchor?.id ?? undefined)
      set((state) => {
        const current = state.sessions[sessionId]
        if (current) current.historyLoading = false
      })
      await adoptRunner(set, get, sessionId)
    },

    setActive: (sessionId) =>
      set((state) => {
        state.activeId = sessionId
      }),

    selectProject: (cwd) => {
      localStorage.setItem(SELECTED_PROJECT_KEY, cwd)
      set((state) => {
        state.selectedCwd = cwd
      })
    },

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

    applyUpdate: async () => {
      const status = await call('update.apply', {})
      set((state) => {
        state.update = status
      })
    },

    checkUpdate: async () => {
      const status = await call('update.check', {})
      set((state) => {
        state.update = status
      })
      return status
    },

    setSettingsOpen: (open) => {
      set((state) => {
        state.settingsOpen = open
      })
    },

    setQuotes: (quotes) => {
      set((state) => {
        state.quotes = quotes
      })
    },

    send: async (text, attachments) => {
      const sessionId = get().activeId
      if (!sessionId) return
      if (!(await toTheEnd(get, sessionId))) return pushNotice(set, sessionId, 'error', `没能回到最新的消息，这条没有发出：${text}`)
      if (!(await attachToSend(set, get, sessionId))) return
      // Optimistic echo: the CLI does not replay user messages by default.
      echoPrompt(set, sessionId, text, attachments?.length ?? 0)
      await startTurn(set, sessionId, text, attachments)
    },

    runShell: async (command) => {
      const sessionId = get().activeId
      if (!sessionId) return
      if (!(await toTheEnd(get, sessionId))) return pushNotice(set, sessionId, 'error', `没能回到最新的消息，这条命令没有执行：${command}`)
      if (!(await attachToSend(set, get, sessionId))) return
      const echoId = echoPrompt(set, sessionId, bashEcho(command), 0)
      let output: { stdout: string; stderr: string }
      try {
        output = await call('session.shell', { sessionId, command })
      } catch (error) {
        // Nothing reaches the transcript, so the bubble must go too: rewind
        // pairs local bubbles with on-disk prompts by position.
        set((state) => {
          const session = state.sessions[sessionId]
          if (session) session.transcript.nodes = session.transcript.nodes.filter((node) => node.id !== echoId)
        })
        pushNotice(set, sessionId, 'error', `命令执行失败（${command}）：${String(error)}`)
        return
      }
      set((state) => {
        const session = state.sessions[sessionId]
        session?.transcript.nodes.push({
          kind: 'localOutput',
          id: `${echoId}:out`,
          content: bashDisplay(output.stdout, output.stderr),
        })
      })
      await startTurn(set, sessionId, bashPrompt(command, output.stdout, output.stderr))
    },

    renameSession: async (title) => {
      const sessionId = get().activeId
      const session = sessionId ? get().sessions[sessionId] : undefined
      if (!sessionId || !session) return
      try {
        await get().renameSavedSession(sessionId, session.cwd, title)
      } catch (error) {
        pushNotice(set, sessionId, 'error', `重命名失败：${String(error)}`)
        return
      }
      pushNotice(set, sessionId, 'info', `会话已重命名为「${title.trim()}」`)
      // The title lives on disk; the live runner's summary does not carry it.
      await get().refreshProjects()
    },

    renameSavedSession: async (sessionId, cwd, title) => {
      await call('session.rename', { sessionId, title, cwd })
      // Shown at once rather than after the whole list is read back.
      const name = title.trim()
      const saved = get().projects.flatMap((project) => project.sessions).find((entry) => entry.sessionId === sessionId)
      if (saved) updateProjectSession(set, { ...saved, customTitle: name, summary: name })
    },

    forkSession: async (title) => {
      const sessionId = get().activeId
      const session = sessionId ? get().sessions[sessionId] : undefined
      if (!sessionId || !session) return
      let forked: string
      try {
        ;({ sessionId: forked } = await call('session.fork', {
          sessionId,
          cwd: session.cwd,
          ...(title ? { title } : {}),
        }))
      } catch (error) {
        pushNotice(set, sessionId, 'error', `分叉失败：${String(error)}`)
        return
      }
      await get().openSession(forked, session.cwd)
      pushNotice(set, forked, 'info', `已从会话 ${sessionId.slice(0, 8)} 分叉；原会话保持不变，可从侧栏切回`)
      void get().refreshProjects().catch(() => {})
    },

    addNotice: (level, text) => {
      const sessionId = get().activeId
      if (sessionId) pushNotice(set, sessionId, level, text)
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

    messageLink: async (nodeId) => {
      const sessionId = get().activeId
      if (!sessionId) throw new Error('没有活跃会话')
      const uuid = nodeId.startsWith('local-') ? await resolveUserUuid(get, sessionId, nodeId) : nodeId
      return new URL(`${sessionHref(sessionId)}#m-${uuid}`, window.location.origin).href
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

    refreshAgent: async (toolUseId) => {
      const sessionId = get().activeId
      if (sessionId) await loadAgentHistory(set, get, sessionId, toolUseId, true)
    },

    stopWorkflow: async (toolUseId) => {
      const sessionId = get().activeId
      const session = sessionId ? get().sessions[sessionId] : undefined
      const run = session?.transcript.workflows[toolUseId]
      if (!sessionId || !session?.attached || !run?.taskId) return
      await call('session.stopTask', { sessionId, taskId: run.taskId })
    },
  })),
)

type Setter = (updater: (state: Store) => void) => void

/**
 * The session this browser last had open, so a bare `/` lands back on it.
 * Every tab shares it; a reload follows the tab's own address instead (see
 * `followAddressBar`).
 *
 * Subscribed rather than written from each action: `activeId` moves in four
 * places, and only one of them is `setActive`.
 */
const ACTIVE_KEY = 'ccw.activeSession'

useStore.subscribe((state, previous) => {
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
    // elsewhere (`followAddressBar` clearing a dead session) is written again.
    if (value === localStorage.getItem(ACTIVE_KEY)) return
    localStorage.setItem(ACTIVE_KEY, value)
  } else if (state.activeId === null && previous.activeId !== null) {
    // Only on closing what was open: a tab that never opened anything — an
    // address naming nothing, or one still asking where its session runs —
    // must not wipe what another tab left here.
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

type Address = { sessionId: string; agent?: string; anchor?: string }

/**
 * Opens of an address still in flight. The states they pass through — the
 * session open, its agent not yet — are no place to go back to, and the bar
 * already names where they end. Module-wide, not per `followAddressBar`: an
 * open outlives the teardown that StrictMode's remount runs in between.
 */
let following = 0

/** Where a session lives in the address bar. */
export function sessionHref(sessionId: string): string {
  return `/s/${sessionId}`
}

const SETTINGS_HREF = '/settings'

/**
 * The `history.state` of a settings page entry pushed from within the tab:
 * leaving the page steps back to the entry behind it rather than adding one.
 * Kept by the browser across a reload, unlike anything in memory.
 */
const OPENED_HERE = { settings: 'opened-here' }

const onSettingsPage = (): boolean => /^\/settings\/?$/.test(window.location.pathname)

/**
 * Leaves the settings page for the session beneath it, as the browser's back
 * would when the page was opened from within the tab.
 */
export function leaveSettings(): void {
  const state: unknown = window.history.state
  if (typeof state === 'object' && state !== null && 'settings' in state && state.settings === OPENED_HERE.settings) {
    window.history.back()
  } else {
    useStore.getState().setSettingsOpen(false)
  }
}

/**
 * What the tab shows, as an address: the settings page, the session, the
 * subagent whose conversation is open, or else the user message the view was
 * sent to.
 */
function addressOf(state: Store): string {
  if (state.settingsOpen) return SETTINGS_HREF
  const session = state.activeId ? state.sessions[state.activeId] : undefined
  if (!session) return '/'
  if (session.viewAgent) return `${sessionHref(session.sessionId)}?${new URLSearchParams({ agent: session.viewAgent })}`
  return sessionHref(session.sessionId) + (session.anchor?.id ? `#m-${session.anchor.id}` : '')
}

function readAddress(): Address | null {
  const sessionId = /^\/s\/([^/]+)\/?$/.exec(window.location.pathname)?.[1]
  if (!sessionId) return null
  const agent = new URLSearchParams(window.location.search).get('agent')
  const anchor = /^#m-(.+)$/.exec(window.location.hash)?.[1]
  return { sessionId, ...(agent ? { agent } : {}), ...(anchor ? { anchor } : {}) }
}

/**
 * Keeps the address bar on what the tab shows, and the tab on what the bar
 * names. A reload or a link opens that session in this tab whatever the
 * others are on, and back/forward step through what was viewed. A bare `/`
 * opens the session this browser last had open, and so does `/settings`,
 * beneath its page. Returns the teardown.
 */
export function followAddressBar(): () => void {
  const follow = async (address: Address | null, settings: boolean): Promise<void> => {
    const remembered = readRememberedSession()
    following += 1
    // At once: the page does not wait for the session beneath it.
    useStore.getState().setSettingsOpen(settings)
    try {
      // The remembered cwd spares asking the server on a plain reload.
      await openAddress(address, remembered?.sessionId === address?.sessionId ? remembered?.cwd : undefined)
    } catch {
      // Deleted, or its project directory moved: stop landing on it.
      if (remembered && remembered.sessionId === address?.sessionId) localStorage.removeItem(ACTIVE_KEY)
    } finally {
      following -= 1
    }
    // The bar may name something that did not open; the last open to settle
    // puts what did in its place. Its state stays: it may be OPENED_HERE.
    if (following === 0) window.history.replaceState(window.history.state, '', addressOf(useStore.getState()))
  }
  const onPopState = (): void => {
    if (!onSettingsPage()) return void follow(readAddress(), false)
    // Forward onto the settings page: the session beneath stays as it is.
    following += 1
    useStore.getState().setSettingsOpen(true)
    following -= 1
  }

  const unsubscribe = useStore.subscribe((state, previous) => {
    if (following > 0) return
    const address = addressOf(state)
    if (address === addressOf(previous)) return
    // Moving off a session that was just closed: no place to come back to.
    const closed = previous.activeId !== null && !state.sessions[previous.activeId]
    if (closed) window.history.replaceState(null, '', address)
    else window.history.pushState(state.settingsOpen ? OPENED_HERE : null, '', address)
  })
  window.addEventListener('popstate', onPopState)
  const settings = onSettingsPage()
  void follow(settings ? readRememberedSession() : (readAddress() ?? readRememberedSession()), settings)
  return () => {
    unsubscribe()
    window.removeEventListener('popstate', onPopState)
  }
}

async function openAddress(address: Address | null, cwd: string | undefined): Promise<void> {
  const { openSession, openAgent, setActive, addNotice, jumpToLatest } = useStore.getState()
  if (!address) return setActive(null)
  // A subagent opens where its card is, which may be far back.
  await openSession(address.sessionId, cwd, address.agent ?? address.anchor)
  const { activeId, sessions } = useStore.getState()
  // Another open took over meanwhile; the agent would land in its session.
  if (activeId !== address.sessionId) return
  const session = sessions[activeId]
  if (address.anchor && !address.agent && session?.anchor?.id === null) {
    addNotice('info', '链接指向的那条消息已不在这个会话里（可能被回退了），已打开最新的消息')
  }
  // Naming no message is naming the end — say, forward again after going
  // back to one — wherever the view was sent before.
  if (!address.anchor && !address.agent && (session?.anchor?.id || session?.newerCursor)) await jumpToLatest(activeId)
  const agent = address.agent ?? null
  if ((session?.viewAgent ?? null) !== agent) await openAgent(agent).catch(() => {})
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
    if (!session.newerCursor) for (const message of state.backlog) applyMessage(session.transcript, message)
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
  if (event.type === 'update_status') {
    set((state) => {
      state.update = event.status
    })
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
        // Held back while an older stretch is shown: there is no end to put
        // it at. The runner's backlog replays it once the end is read in.
        if (!session.newerCursor) applyMessage(session.transcript, message)

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
 * `attach` for a prompt about to go out. On failure nothing has been echoed
 * yet, so the message is simply not sent — say so instead of letting the
 * click look like it worked.
 */
async function attachToSend(set: Setter, get: () => Store, sessionId: string): Promise<boolean> {
  try {
    await attach(set, get, sessionId)
    return true
  } catch (error) {
    set((state) => {
      const session = state.sessions[sessionId]
      if (session) session.error = `无法启动会话：${String(error)}`
    })
    return false
  }
}

/** Appends a user bubble and returns its id. The `local-` prefix is what rewind keys on. */
function echoPrompt(set: Setter, sessionId: string, text: string, attachments: number): string {
  let id = ''
  set((state) => {
    const session = state.sessions[sessionId]
    if (!session) return
    id = `local-${Date.now()}-${session.transcript.nodes.length}`
    session.transcript.nodes.push({ kind: 'user', id, text, attachments })
  })
  return id
}

async function startTurn(set: Setter, sessionId: string, text: string, attachments?: Attachment[]): Promise<void> {
  set((state) => {
    const session = state.sessions[sessionId]
    if (!session) return
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
}

function pushNotice(set: Setter, sessionId: string, level: 'info' | 'error', text: string): void {
  set((state) => {
    const session = state.sessions[sessionId]
    if (!session) return
    session.transcript.nodes.push({ kind: 'notice', id: `notice-${Date.now()}-${session.transcript.nodes.length}`, level, text })
  })
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
 * Re-reads the release status on every (re)connect. A different `current`
 * means the server came back as another version — usually after our own
 * update — so the page reloads to match it.
 */
async function loadUpdateStatus(set: Setter, get: () => Store): Promise<void> {
  const status = await call('update.status', {})
  const previous = get().update
  if (previous && previous.current !== status.current) {
    window.location.reload()
    return
  }
  set((state) => {
    state.update = status
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

async function locateSession(sessionId: string): Promise<string> {
  const { cwd } = await call('history.locate', { sessionId })
  if (!cwd) throw new Error(`找不到会话 ${sessionId.slice(0, 8)}`)
  return cwd
}

/**
 * Entries per history page. Measured on a 52 MB transcript: the newest 100
 * came to ~100 KB of JSON, against 22 MB for the whole thing.
 */
const HISTORY_PAGE = 100

/**
 * Replays the newest page of a session's on-disk transcript into the store;
 * `loadOlderHistory` fetches the rest as the reader scrolls up.
 *
 * A failure here is worth surfacing: an empty pane is indistinguishable from a
 * session that genuinely has no history, and silently showing one for the other
 * is how the missing replay went unnoticed in the first place.
 */
async function loadHistory(set: Setter, get: () => Store, sessionId: string, cwd: string, at?: string): Promise<void> {
  try {
    await readWindow(set, get, sessionId, cwd, at)
  } catch (error) {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return
      session.historyError = `读取历史记录失败：${String(error)}`
      // For the retry, which should land where this was meant to.
      if (at) session.anchor = { id: at }
    })
  }
}

/** Replaces the transcript with the newest page of history, or the page around `at`. */
async function readWindow(set: Setter, get: () => Store, sessionId: string, cwd: string, at?: string): Promise<void> {
  const [{ messages, hasMore, hasNewer, turns, permissionMode }, subagents] = await Promise.all([
    call('history.messages', { sessionId, cwd, limit: HISTORY_PAGE, ...(at ? { around: at } : {}) }),
    // Optional: without it the cards still render, they just cannot open
    // a conversation until a live event names the agent.
    call('history.subagents', { sessionId }).catch(() => ({ agents: [] })),
  ])
  if (!get().sessions[sessionId]) return
  const transcript = await replayHistory(sessionId, messages, subagents.agents, turns)
  set((state) => {
    const session = state.sessions[sessionId]
    if (!session) return
    session.transcript = transcript
    session.historyCursor = hasMore ? (messages[0]?.uuid ?? null) : null
    session.newerCursor = hasNewer ? (messages.at(-1)?.uuid ?? null) : null
    session.historyError = null
    session.newerError = null
    // A message the page lacks — rewound away — leaves the view at the end.
    session.anchor = { id: at && isUserNode(transcript, at) ? at : null }
    // Only when the transcript actually recorded a toggle; otherwise the
    // remembered default already in place is the better guess.
    if (permissionMode) session.permissionMode = permissionMode
  })
}

/**
 * Moves an open session's transcript to the newest page, or the page around
 * `at`, and replays the turn in flight onto it. Throws when it cannot be read.
 */
async function moveWindow(set: Setter, get: () => Store, sessionId: string, at?: string): Promise<void> {
  const session = get().sessions[sessionId]
  if (!session) return
  await readWindow(set, get, sessionId, session.cwd, at)
  await adoptRunner(set, get, sessionId)
}

/**
 * Replies land at the end, so a send goes there first: one written while an
 * older stretch is shown would never be seen arriving. False when it cannot.
 */
async function toTheEnd(get: () => Store, sessionId: string): Promise<boolean> {
  const session = get().sessions[sessionId]
  if (session?.anchor?.id || session?.newerCursor) await get().jumpToLatest(sessionId)
  return !get().sessions[sessionId]?.newerCursor
}

function isUserNode(transcript: Transcript, id: string): boolean {
  return transcript.nodes.some((node) => node.kind === 'user' && node.id === id)
}

/** Whether an entry to open at is already read in: a user message, or a subagent's card. */
function holdsEntry(transcript: Transcript, id: string): boolean {
  return isUserNode(transcript, id) || findAgent(transcript, id) !== null
}

/** One page of history as a transcript of its own, its cards filled in from their saved records. */
async function replayHistory(
  sessionId: string,
  messages: SessionMessage[],
  subagents: SubagentMeta[],
  turns: TurnTotals[] = [],
): Promise<Transcript> {
  const transcript = emptyTranscript()
  const ends = new Map(turns.map((turn) => [turn.after, turn]))
  for (const entry of messages) {
    applyHistoryMessage(transcript, entry)
    const turn = ends.get(entry.uuid)
    if (turn) applyTurnTotals(transcript, turn)
  }
  // Workflow cards: the saved run record has the phases and every agent.
  await Promise.all(
    Object.values(transcript.workflows).map(async (run) => {
      if (!run.runId) return
      const { run: record } = await call('history.workflow', { sessionId, runId: run.runId }).catch(() => ({ run: null }))
      if (record) applyWorkflowRecord(transcript, run, record)
    }),
  )
  for (const meta of subagents) {
    const agent = meta.toolUseId ? findAgent(transcript, meta.toolUseId) : null
    if (!agent) continue
    agent.agentId ??= meta.agentId
    if (!agent.subagentType && meta.agentType) agent.subagentType = meta.agentType
    if (!agent.description && meta.description) agent.description = meta.description
  }
  return transcript
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
  if (flagRequests.has(sessionId)) return
  flagRequests.add(sessionId)
  try {
    const flags = await call('session.flags', { sessionId })
    set((state) => applyFlags(state.sessions[sessionId], flags))
  } catch {
    // An older CLI without get_settings: the Ultracode row just stays hidden.
  } finally {
    flagRequests.delete(sessionId)
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
 * The project in front: the one last picked in the sidebar, else the open
 * session's, else the most recently used. The sidebar lists its sessions, and
 * the details panel works in it even when no session is open.
 */
export function useProjectCwd(): string | null {
  return useStore((state) => {
    const activeCwd = state.activeId ? state.sessions[state.activeId]?.cwd : undefined
    return state.selectedCwd ?? activeCwd ?? (state.defaultCwd || state.projects[0]?.cwd || null)
  })
}

/**
 * Whether nothing in the open session can still be making progress.
 *
 * A card leaves `running` only when its tool_result arrives, and a runner that
 * died mid-call — the server restarted, the container was recycled — never
 * sends one, so the card would read as 执行中 forever. The session not running
 * is what says so, but only once its runner has actually been asked about:
 * between the history read and `adoptRunner` a live turn also looks idle, and
 * claiming 已中断 there would flash it over output that is still coming.
 */
export function useSessionSettled(): boolean {
  const running = useActiveSessionValue((session) => session.status === 'running') ?? false
  const attached = useActiveSessionValue((session) => session.attached) ?? false
  const closed = useActiveSessionValue((session) => session.closed) ?? false
  return !running && (attached || closed)
}

/**
 * Folds a subagent's on-disk transcript into its view the first time it is
 * opened. A subagent still streaming into a live view is left alone: its
 * events already built the view, and the JSONL may lag behind them.
 */
async function loadAgentHistory(
  set: Setter,
  get: () => Store,
  sessionId: string,
  toolUseId: string,
  refresh = false,
): Promise<void> {
  const session = get().sessions[sessionId]
  const agent: AgentRun | null = session ? findAgent(session.transcript, toolUseId) : null
  if (!session || !agent) return
  // A workflow agent's output never streams, so its file is the only view:
  // always read it, and re-read it while the agent runs.
  if (!agent.workflow) {
    if (agent.historyLoaded) return
    if (agent.status === 'running' && agent.transcript.nodes.length > 0) return
  } else if (agent.historyLoaded && !refresh && agent.status !== 'running') {
    return
  }
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
    // A poll that found nothing new must not churn the view.
    const before = draft.transcript.nodes
    if (
      before.length === rebuilt.nodes.length &&
      JSON.stringify(before.at(-1)) === JSON.stringify(rebuilt.nodes.at(-1))
    ) {
      return
    }
    // History is the complete record; live-only nodes it does not know of
    // would be newer output, which `seen` lets the stream re-add on arrival.
    rebuilt.agents = { ...rebuilt.agents, ...draft.transcript.agents }
    rebuilt.agentOrder = [...new Set([...rebuilt.agentOrder, ...draft.transcript.agentOrder])]
    draft.transcript = rebuilt
  })
}
