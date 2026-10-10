import type { WorkflowRecord } from '@ccw/shared'

import type { AgentRun, AgentStatus, Transcript } from './nodes.ts'
import { emptyTranscript } from './nodes.ts'

/**
 * Dynamic workflows (CLI ≥ 2.1.29x, ultracode or the `Workflow` tool): the
 * model writes a script that fans work out to many agents. The CLI reports a
 * run as one background task (`task_type: 'local_workflow'`) whose
 * `task_progress` events carry a `workflow_progress` snapshot — the phases
 * and every agent's state — which is exactly what the terminal's /workflows
 * view draws. The agents' own messages never reach the SDK stream; each one
 * is a transcript on disk under `subagents/workflows/<runId>/`.
 */

/** `start` covers both queued (no startedAt yet) and spawning. */
export type WorkflowAgentState = 'start' | 'progress' | 'done' | 'error' | (string & {})

export type WorkflowAgent = {
  /** 1-based position in the script's call order — the stable key. */
  index: number
  label: string
  phaseIndex?: number
  phaseTitle?: string
  agentId?: string
  agentType?: string
  model?: string
  state: WorkflowAgentState
  queuedAt?: number
  startedAt?: number
  attempt?: number
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  resultPreview?: string
  error?: string
  tokens: number
  toolCalls: number
  durationMs: number
  /** Served from a resumed run's journal rather than run again. */
  cached?: boolean
  blocked?: boolean
}

export type WorkflowPhase = { index: number; title: string; detail?: string }

export type WorkflowRun = {
  /** The Workflow tool_use id — the card this run renders in. */
  toolUseId: string
  /** Background task id, the one `stop_task` takes. */
  taskId?: string
  /** `wf_…`, the run's directory name on disk. */
  runId?: string
  name: string
  description: string
  status: AgentStatus
  phases: WorkflowPhase[]
  agents: WorkflowAgent[]
  totalTokens: number
  toolCalls: number
  durationMs: number
  script?: string
  scriptPath?: string
  summary?: string
  error?: string
  /** Whether the on-disk run record has been folded in (reload path). */
  historyLoaded: boolean
}

/** The tool the model calls to launch one. */
export const WORKFLOW_TOOL = 'Workflow'

/** Agents opened from a workflow live in `transcript.agents` under this key. */
export function workflowAgentKey(agentId: string): string {
  return `wf:${agentId}`
}

export function findWorkflow(transcript: Transcript, toolUseId: string): WorkflowRun | null {
  return transcript.workflows[toolUseId] ?? null
}

function findWorkflowByTask(transcript: Transcript, taskId: string): WorkflowRun | null {
  return Object.values(transcript.workflows).find((run) => run.taskId === taskId) ?? null
}

/** `export const meta = { name: '…', description: '…' }` at the top of the script. */
function metaField(script: string, field: string): string | undefined {
  const match = new RegExp(`\\b${field}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(script.slice(0, 4000))
  return match?.[2]
}

export function registerWorkflow(transcript: Transcript, toolUseId: string, input: Record<string, unknown>): WorkflowRun {
  const script = typeof input['script'] === 'string' ? input['script'] : undefined
  const scriptPath = typeof input['scriptPath'] === 'string' ? input['scriptPath'] : undefined
  const existing = transcript.workflows[toolUseId]
  if (existing) return existing
  const fromPath = scriptPath ? /([^/\\]+?)(?:-wf_[\w-]+)?\.js$/.exec(scriptPath)?.[1] : undefined
  const run: WorkflowRun = {
    toolUseId,
    name: (script && metaField(script, 'name')) || fromPath || 'workflow',
    description: (script && metaField(script, 'description')) || '',
    status: 'running',
    phases: [],
    agents: [],
    totalTokens: 0,
    toolCalls: 0,
    durationMs: 0,
    ...(script ? { script } : {}),
    ...(scriptPath ? { scriptPath } : {}),
    historyLoaded: false,
  }
  transcript.workflows[toolUseId] = run
  return run
}

/** The launch receipt names the task, the run, and where the script was saved. */
export function settleWorkflowLaunch(run: WorkflowRun, isError: boolean, output: string): void {
  const taskId = /Task ID: ([\w-]+)/.exec(output)?.[1]
  const runId = /Run ID: (wf_[\w-]+)/.exec(output)?.[1] ?? /workflows\/(wf_[\w-]+)/.exec(output)?.[1]
  const scriptPath = /Script file: (.+)/.exec(output)?.[1]?.trim()
  if (taskId) run.taskId ??= taskId
  if (runId) run.runId ??= runId
  if (scriptPath) run.scriptPath ??= scriptPath
  if (isError) {
    run.status = 'failed'
    run.error = output.trim().slice(0, 2000)
  } else if (!/launched in background/i.test(output) && run.status === 'running' && !taskId) {
    // A foreground run returns its result directly.
    run.status = 'completed'
    run.summary ??= output.trim()
  }
}

type TaskEvent = {
  subtype: string
  task_id?: string
  tool_use_id?: string
  task_type?: string
  workflow_name?: string
  description?: string
  summary?: string
  status?: string
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  patch?: { status?: string; error?: string }
  workflow_progress?: unknown[]
}

/**
 * A `task_*` event for a workflow. Returns false when the event belongs to
 * something else (a subagent, a shell), so the caller keeps looking.
 */
export function applyWorkflowEvent(transcript: Transcript, event: TaskEvent): boolean {
  let run = (event.tool_use_id && transcript.workflows[event.tool_use_id]) || (event.task_id && findWorkflowByTask(transcript, event.task_id)) || null
  if (!run) {
    if (event.task_type !== 'local_workflow' || !event.tool_use_id) return false
    run = registerWorkflow(transcript, event.tool_use_id, {})
  }
  if (event.task_id) run.taskId = event.task_id
  if (event.workflow_name) run.name = event.workflow_name
  if (event.usage) {
    run.totalTokens = event.usage.total_tokens
    run.toolCalls = event.usage.tool_uses
    run.durationMs = event.usage.duration_ms
  }
  switch (event.subtype) {
    case 'task_started':
      if (event.description) run.description = event.description
      if (run.status !== 'running' && !run.summary) run.status = 'running'
      break
    case 'task_progress':
      if (event.workflow_progress) applyWorkflowProgress(transcript, run, event.workflow_progress)
      break
    case 'task_updated':
      if (event.patch?.status) setRunStatus(transcript, run, event.patch.status)
      if (event.patch?.error) run.error = event.patch.error
      break
    case 'task_notification':
      if (event.status) setRunStatus(transcript, run, event.status)
      if (event.summary) run.summary = event.summary
      break
  }
  return true
}

function setRunStatus(transcript: Transcript, run: WorkflowRun, status: string): void {
  const mapped: AgentStatus | null =
    status === 'completed'
      ? 'completed'
      : status === 'failed'
        ? 'failed'
        : status === 'killed' || status === 'stopped'
          ? 'stopped'
          : status === 'running' || status === 'pending' || status === 'paused'
            ? 'running'
            : null
  if (!mapped) return
  run.status = mapped
  if (mapped === 'running') return
  // An agent cut off by a stop or failure never reports done; do not leave
  // it spinning forever.
  for (const agent of run.agents) {
    if (agent.state === 'done' || agent.state === 'error') continue
    agent.state = mapped === 'completed' ? 'done' : 'error'
    syncAgentRun(transcript, run, agent)
  }
}

/**
 * Folds one `workflow_progress` snapshot. It lists the phases and the agents
 * that have been queued so far; later snapshots only add and update, so
 * merge by index rather than replace.
 */
export function applyWorkflowProgress(transcript: Transcript, run: WorkflowRun, items: unknown[]): void {
  for (const raw of items) {
    const item = raw as Record<string, unknown>
    if (item['type'] === 'workflow_phase') {
      const index = num(item['index'])
      if (index === undefined) continue
      const phase: WorkflowPhase = { index, title: str(item['title']) ?? `阶段 ${index}` }
      const detail = str(item['detail'])
      if (detail) phase.detail = detail
      const at = run.phases.findIndex((existing) => existing.index === index)
      if (at >= 0) run.phases[at] = { ...run.phases[at], ...phase }
      else run.phases.push(phase)
      continue
    }
    if (item['type'] !== 'workflow_agent') continue
    const index = num(item['index'])
    if (index === undefined) continue
    let agent = run.agents.find((existing) => existing.index === index)
    if (!agent) {
      agent = { index, label: str(item['label']) ?? `agent ${index}`, state: 'start', tokens: 0, toolCalls: 0, durationMs: 0 }
      run.agents.push(agent)
    }
    mergeAgent(agent, item)
    syncAgentRun(transcript, run, agent)
  }
  run.phases.sort((a, b) => a.index - b.index)
  run.agents.sort((a, b) => a.index - b.index)
}

function mergeAgent(agent: WorkflowAgent, item: Record<string, unknown>): void {
  const strings = ['label', 'phaseTitle', 'agentId', 'agentType', 'model', 'lastToolName', 'lastToolSummary', 'promptPreview', 'resultPreview', 'error'] as const
  for (const key of strings) {
    const value = str(item[key])
    if (value !== undefined) agent[key] = value
  }
  const state = str(item['state'])
  // A late frame for an attempt never moves a finished agent back.
  if (state && !(agent.state === 'done' && state !== 'done')) agent.state = state
  const numbers = ['phaseIndex', 'queuedAt', 'startedAt', 'attempt'] as const
  for (const key of numbers) {
    const value = num(item[key])
    if (value !== undefined) agent[key] = value
  }
  const tokens = num(item['tokens'])
  if (tokens !== undefined) agent.tokens = tokens
  const toolCalls = num(item['toolCalls'])
  if (toolCalls !== undefined) agent.toolCalls = toolCalls
  const durationMs = num(item['durationMs'])
  if (durationMs !== undefined) agent.durationMs = durationMs
  if (item['cached'] === true) agent.cached = true
  if (item['blocked'] === true) agent.blocked = true
}

export function workflowAgentStatus(agent: WorkflowAgent): AgentStatus {
  if (agent.state === 'done') return 'completed'
  if (agent.state === 'error') return 'failed'
  return 'running'
}

/**
 * Mirrors a workflow agent as an `AgentRun`, so it opens in the same
 * read-only conversation view a subagent does.
 */
function syncAgentRun(transcript: Transcript, run: WorkflowRun, agent: WorkflowAgent): void {
  if (!agent.agentId) return
  const key = workflowAgentKey(agent.agentId)
  let mirror: AgentRun | undefined = transcript.agents[key]
  if (!mirror) {
    mirror = {
      toolUseId: key,
      agentId: agent.agentId,
      workflow: run.toolUseId,
      description: agent.label,
      prompt: agent.promptPreview ?? '',
      status: 'running',
      // Never settled by a turn's result: the run owns its lifecycle.
      backgrounded: true,
      toolUses: 0,
      totalTokens: 0,
      durationMs: 0,
      transcript: emptyTranscript(),
      historyLoaded: false,
    }
    transcript.agents[key] = mirror
    transcript.agentOrder.push(key)
  }
  mirror.description = agent.label
  if (agent.agentType) mirror.subagentType = agent.agentType
  if (agent.promptPreview && !mirror.prompt) mirror.prompt = agent.promptPreview
  mirror.status = workflowAgentStatus(agent)
  mirror.toolUses = agent.toolCalls
  mirror.totalTokens = agent.tokens
  mirror.durationMs = agent.durationMs
  if (agent.model) mirror.model = agent.model
  if (agent.lastToolName) mirror.lastTool = agent.lastToolName
  mirror.activity = agent.lastToolSummary ? `${agent.lastToolName ?? ''} ${agent.lastToolSummary}`.trim() : undefined
  if (agent.resultPreview) mirror.summary = agent.resultPreview
  else if (agent.error) mirror.summary = agent.error
}

/** Rebuilds a reloaded run from its saved record. */
export function applyWorkflowRecord(transcript: Transcript, run: WorkflowRun, record: WorkflowRecord): void {
  run.runId ??= record.runId
  if (record.taskId) run.taskId ??= record.taskId
  if (record.workflowName) run.name = record.workflowName
  if (record.summary && !run.description) run.description = record.summary
  if (record.script) run.script ??= record.script
  if (record.scriptPath) run.scriptPath ??= record.scriptPath
  if (record.phases) {
    record.phases.forEach((phase, at) => {
      if (!run.phases.some((existing) => existing.index === at + 1)) {
        run.phases.push({ index: at + 1, title: phase.title, ...(phase.detail ? { detail: phase.detail } : {}) })
      }
    })
  }
  if (record.workflowProgress) applyWorkflowProgress(transcript, run, record.workflowProgress)
  if (record.totalTokens !== undefined) run.totalTokens = record.totalTokens
  if (record.totalToolCalls !== undefined) run.toolCalls = record.totalToolCalls
  if (record.durationMs !== undefined) run.durationMs = record.durationMs
  if (record.status) setRunStatus(transcript, run, record.status)
  run.historyLoaded = true
}

/**
 * `<task-notification>` is how a finished background task reaches the model;
 * on disk it is a plain user message. It is not something the user typed, so
 * history folds it into the card it settles instead of drawing a bubble.
 */
export function parseTaskNotification(text: string): { taskId?: string; toolUseId?: string; status?: string; summary?: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('<task-notification>')) return null
  const tag = (name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(trimmed)?.[1]?.trim()
  const out: { taskId?: string; toolUseId?: string; status?: string; summary?: string } = {}
  const taskId = tag('task-id')
  const toolUseId = tag('tool-use-id')
  const status = tag('status')
  const summary = tag('summary')
  if (taskId) out.taskId = taskId
  if (toolUseId) out.toolUseId = toolUseId
  if (status) out.status = status
  if (summary) out.summary = summary
  return out
}

/**
 * The harness wraps a workflow agent's task in a provenance frame and
 * indents every line of it; show the task the script actually wrote.
 */
export function unframeWorkflowPrompt(text: string): string {
  if (!text.startsWith('[Workflow harness')) return text
  const marker = text.indexOf('follows:\n')
  if (marker < 0) return text
  return text
    .slice(marker + 'follows:\n'.length)
    .split('\n')
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n')
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
