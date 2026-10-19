import type { AgentRun } from './nodes.ts'

/**
 * Where a subagent stands in the pixel office. Pure layout, kept apart from
 * the component so it can be tested without a DOM: the office maps what each
 * agent is doing right now onto a spot in the room.
 */

export type Station = 'desk' | 'shelf' | 'terminal' | 'window' | 'lounge'

export type Pose = 'stand' | 'sit' | 'slump'

export type Placement = {
  toolUseId: string
  station: Station
  pose: Pose
  /** Horizontal position as a percentage of the room's width (sprite centre). */
  x: number
  /** Vertical position in room pixels (sprite feet). */
  y: number
  /** This agent's own desk, which it returns to between jobs. */
  deskX: number
  /** Stable shirt colour, picked from the agent's id. */
  color: string
}

/** Room geometry, in the same units as Placement. */
export const ROOM = {
  height: 220,
  floorY: 64,
  deskY: 196,
  stations: {
    shelf: { x: 10, y: 92 },
    terminal: { x: 36, y: 92 },
    window: { x: 62, y: 92 },
    lounge: { x: 86, y: 100 },
  },
} as const

const SHIRTS = ['#c96442', '#2f7d9a', '#7c4dcc', '#2f7d4f', '#b8862b', '#c2457a', '#4a5fc1', '#3d8f86']

const SHELF_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const TERMINAL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Monitor'])
const WINDOW_TOOLS = new Set(['WebFetch', 'WebSearch'])

/** The spot an agent heads to for what it is doing now. */
export function stationFor(agent: Pick<AgentRun, 'status' | 'lastTool' | 'activity'>): Station {
  if (agent.status === 'completed') return 'lounge'
  if (agent.status === 'failed' || agent.status === 'stopped') return 'desk'
  const tool = agent.lastTool ?? toolFromActivity(agent.activity)
  if (!tool) return 'desk'
  if (SHELF_TOOLS.has(tool)) return 'shelf'
  if (TERMINAL_TOOLS.has(tool)) return 'terminal'
  if (WINDOW_TOOLS.has(tool) || tool.startsWith('mcp__')) return 'window'
  return 'desk'
}

/** `task_progress` text such as "Reading alpha.txt" when no tool name came with it. */
function toolFromActivity(activity: string | undefined): string | null {
  if (!activity) return null
  if (/^(Reading|Searching|Finding|Listing)\b/i.test(activity)) return 'Read'
  if (/^(Running|Executing)\b/i.test(activity)) return 'Bash'
  if (/^(Fetching|Browsing|Searching the web)\b/i.test(activity)) return 'WebFetch'
  return null
}

export function colorFor(toolUseId: string): string {
  let hash = 0
  for (let i = 0; i < toolUseId.length; i++) hash = (hash * 31 + toolUseId.charCodeAt(i)) | 0
  return SHIRTS[Math.abs(hash) % SHIRTS.length]!
}

/**
 * Lays every agent out: one desk each along the front row, and agents sharing
 * a station queue side by side instead of standing on top of each other.
 */
export function layoutOffice(agents: AgentRun[]): Placement[] {
  const n = agents.length
  const deskXs = agents.map((_, i) => (n === 1 ? 50 : 8 + (i * 84) / (n - 1)))
  const crowd: Partial<Record<Station, number>> = {}

  return agents.map((agent, i) => {
    const station = stationFor(agent)
    const deskX = deskXs[i]!
    const base = { toolUseId: agent.toolUseId, station, deskX, color: colorFor(agent.toolUseId) }
    if (station === 'desk') {
      const pose: Pose = agent.status === 'running' ? 'sit' : 'slump'
      return { ...base, pose, x: deskX, y: ROOM.deskY }
    }
    const slot = crowd[station] ?? 0
    crowd[station] = slot + 1
    const spot = ROOM.stations[station]
    // Alternate either side of the spot, a sprite's width apart.
    const offset = slot === 0 ? 0 : (slot % 2 === 1 ? 1 : -1) * Math.ceil(slot / 2) * 4.5
    const x = Math.min(96, Math.max(4, spot.x + offset))
    return { ...base, pose: station === 'lounge' ? 'sit' : 'stand', x, y: spot.y + (slot % 2) * 6 }
  })
}

/** What the speech bubble over an agent says. */
export function bubbleFor(agent: Pick<AgentRun, 'status' | 'lastTool' | 'activity'>): string {
  switch (agent.status) {
    case 'completed':
      return '☕ 完工'
    case 'failed':
      return '💥 出错了'
    case 'stopped':
      return '💤 已停止'
  }
  const text = agent.activity ?? (agent.lastTool ? `正在 ${agent.lastTool}` : '启动中…')
  return text.length > 22 ? `${text.slice(0, 21)}…` : text
}
