import { memo, useEffect, useRef, useState } from 'react'

import type { AgentRun } from '../../render/nodes.ts'
import { bubbleFor, layoutOffice, ROOM, type Placement, type Pose } from '../../render/office.ts'
import { useStore } from '../../store/session.ts'
import { STATUS_LABEL } from './AgentCard.tsx'
import styles from './PixelOffice.module.css'

/** How long a walk across the room takes, matching the CSS transition. */
const WALK_MS = 1400

/**
 * The session's subagents as little people in a pixel office. Each one has a
 * desk on the front row and walks to the bookshelf to read, the terminal to
 * run commands, the window to browse the web, and the coffee corner once it
 * hands its report back. Clicking someone opens their conversation.
 */
export function PixelOffice({ agents }: { agents: AgentRun[] }): JSX.Element {
  const openAgent = useStore((state) => state.openAgent)
  const placements = layoutOffice(agents)
  const byId = new Map(agents.map((agent) => [agent.toolUseId, agent]))
  const desks = placements.map((place) => place.deskX)

  return (
    <div className={styles.room} style={{ height: ROOM.height }} aria-label="像素办公室">
      <div className={styles.wall} style={{ height: ROOM.floorY }}>
        <Shelf x={ROOM.stations.shelf.x} />
        <Terminal x={ROOM.stations.terminal.x} />
        <Window x={ROOM.stations.window.x} />
        <Coffee x={ROOM.stations.lounge.x} />
      </div>
      {desks.map((x, i) => (
        <Desk key={i} x={x} />
      ))}
      {placements.map((place) => {
        const agent = byId.get(place.toolUseId)!
        return (
          <Worker key={place.toolUseId} agent={agent} place={place} onOpen={() => void openAgent(place.toolUseId)} />
        )
      })}
    </div>
  )
}

const Worker = memo(function Worker({
  agent,
  place,
  onOpen,
}: {
  agent: AgentRun
  place: Placement
  onOpen: () => void
}): JSX.Element {
  const walking = useWalking(place.x, place.y)
  const running = agent.status === 'running'
  const pose: Pose | 'walk' = walking ? 'walk' : place.pose
  const typing = !walking && running && place.station === 'desk'

  return (
    <button
      className={`${styles.worker} ${walking ? styles.walking : ''} ${typing ? styles.typing : ''}`}
      style={{ left: `${place.x}%`, top: place.y, zIndex: Math.round(place.y) }}
      onClick={onOpen}
      type="button"
      title={`${agent.description || '子代理'} · ${STATUS_LABEL[agent.status]}${agent.activity ? `\n${agent.activity}` : ''}`}
    >
      <span className={`${styles.bubble} ${styles[agent.status]}`}>{bubbleFor(agent)}</span>
      <Sprite color={place.color} pose={pose} />
      <span className={styles.name}>{agent.description || '子代理'}</span>
    </button>
  )
})

/** True for the duration of a walk after the agent's spot changes. */
function useWalking(x: number, y: number): boolean {
  const last = useRef({ x, y })
  const [walking, setWalking] = useState(false)
  useEffect(() => {
    if (last.current.x === x && last.current.y === y) return
    last.current = { x, y }
    setWalking(true)
    const timer = setTimeout(() => setWalking(false), WALK_MS)
    return () => clearTimeout(timer)
  }, [x, y])
  return walking
}

// ---------------------------------------------------------------------------
// Sprites: 12×16 pixel maps drawn as SVG rects, scaled up with crisp edges.

const PALETTE: Record<string, string> = {
  H: '#3b2a20', // hair
  S: '#f2c9a0', // skin
  E: '#1a1a17', // eyes
  P: '#3d4a6b', // trousers
  B: '#2a2a28', // shoes
}

// prettier-ignore
// prettier-ignore
const HEAD = [
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HSSSSSSH..',
  '..SSESSESS..',
  '..SSSSSSSS..',
  '...SSSSSS...',
]
// prettier-ignore
const TORSO = [
  '..CCCCCCCC..',
  '.CCCCCCCCCC.',
  '.SCCCCCCCCS.',
  '.SCCCCCCCCS.',
  '..CCCCCCCC..',
]
// prettier-ignore
const FRAMES: Record<Pose | 'walk' | 'walk2', string[]> = {
  stand: [...HEAD, ...TORSO, '...PP..PP...', '...PP..PP...', '...PP..PP...', '...PP..PP...', '...BB..BB...'],
  walk: [...HEAD, ...TORSO, '...PP..PP...', '..PP....PP..', '..PP....PP..', '.PP......PP.', '.BB......BB.'],
  walk2: [...HEAD, ...TORSO, '....PPPP....', '....PPPP....', '....PP.P....', '....PP.P....', '....BB.B....'],
  sit: [...HEAD, ...TORSO, '..PPPPPPPP..', '..PPPPPPPP..', '..PP....PP..', '..PP....PP..', '..BB....BB..'],
  slump: [
    '............',
    '............',
    '...HHHHHH...',
    '..HHHHHHHH..',
    '..HSSSSSSH..',
    '..SSXSSXSS..',
    '..SSSSSSSS..',
    '.SCCCCCCCCS.',
    '.SCCCCCCCCS.',
    '..CCCCCCCC..',
    '..PPPPPPPP..',
    '..PPPPPPPP..',
    '..PP....PP..',
    '..PP....PP..',
    '..PP....PP..',
    '..BB....BB..',
  ],
}

function Sprite({ color, pose }: { color: string; pose: Pose | 'walk' }): JSX.Element {
  const palette = { ...PALETTE, C: color, X: '#8a5a3c' }
  if (pose === 'walk') {
    return (
      <span className={styles.spriteWalk}>
        <PixelMap rows={FRAMES.walk} palette={palette} className={styles.frameA} />
        <PixelMap rows={FRAMES.walk2} palette={palette} className={styles.frameB} />
      </span>
    )
  }
  return <PixelMap rows={FRAMES[pose]} palette={palette} className={styles.sprite} />
}

function PixelMap({
  rows,
  palette,
  className,
}: {
  rows: string[]
  palette: Record<string, string>
  className?: string
}): JSX.Element {
  const width = rows[0]!.length
  const rects: JSX.Element[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const fill = palette[row[x]!]
      if (fill) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={fill} />)
    }
  })
  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${rows.length}`}
      width={width * 3}
      height={rows.length * 3}
      shapeRendering="crispEdges"
      aria-hidden
    >
      {rects}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Furniture.

function Furniture({
  x,
  y,
  label,
  children,
}: {
  x: number
  y?: number
  label: string
  children: JSX.Element
}): JSX.Element {
  return (
    <div className={styles.furniture} style={{ left: `${x}%`, ...(y !== undefined ? { top: y } : {}) }} title={label}>
      {children}
    </div>
  )
}

const SHELF = [
  'WWWWWWWWWWWWWW',
  'WrrbbggyyrrbbW',
  'WrrbbggyyrrbbW',
  'WWWWWWWWWWWWWW',
  'WbbyyrrggbbyyW',
  'WbbyyrrggbbyyW',
  'WWWWWWWWWWWWWW',
  'WggrrbbyyggrrW',
  'WggrrbbyyggrrW',
  'WWWWWWWWWWWWWW',
]
const SHELF_PALETTE = { W: '#8a5a36', r: '#c96442', b: '#2f7d9a', g: '#2f7d4f', y: '#d9a53a' }

function Shelf({ x }: { x: number }): JSX.Element {
  return (
    <Furniture x={x} label="书架：Read / Grep / Glob">
      <PixelMap rows={SHELF} palette={SHELF_PALETTE} />
    </Furniture>
  )
}

const TERMINAL = [
  'kkkkkkkkkkkk',
  'kGGGGGGGGGGk',
  'kGgg.GGGGGGk',
  'kGGGGGGGGGGk',
  'kGggggg.GGGk',
  'kGGGGGGGGGGk',
  'kGgg▮GGGGGGk',
  'kkkkkkkkkkkk',
  '....kkkk....',
  '..kkkkkkkk..',
]
const TERMINAL_PALETTE = { k: '#2a2a28', G: '#12301f', g: '#5fd38d', '▮': '#5fd38d' }

function Terminal({ x }: { x: number }): JSX.Element {
  return (
    <Furniture x={x} label="终端：Bash">
      <PixelMap rows={TERMINAL} palette={TERMINAL_PALETTE} />
    </Furniture>
  )
}

const WINDOW = [
  'FFFFFFFFFFFFFF',
  'FsssssFsssssFF',
  'FsccssFssssssF',
  'FcccssFsssccsF',
  'FssssssFsscccF',
  'FFFFFFFFFFFFFF',
  'FsssssFssssssF',
  'FgggssFsssgggF',
  'FggggggFgggggF',
  'FFFFFFFFFFFFFF',
]
const WINDOW_PALETTE = { F: '#e9e4da', s: '#9fd3ef', c: '#ffffff', g: '#6fb36b' }

function Window({ x }: { x: number }): JSX.Element {
  return (
    <Furniture x={x} label="窗口：WebFetch / WebSearch / MCP">
      <PixelMap rows={WINDOW} palette={WINDOW_PALETTE} />
    </Furniture>
  )
}

const COFFEE = [
  '..mmmmmmmm..',
  '..mDDDDDDm..',
  '..mDrrDDDm..',
  '..mDDDDDDm..',
  '..mmmmmmmm..',
  '..m......m..',
  '..m..ww..m..',
  '..m..ww..m..',
  '..mmmmmmmm..',
  'tttttttttttt',
]
const COFFEE_PALETTE = { m: '#5c5c55', D: '#2a2a28', r: '#d64545', w: '#f4efe6', t: '#8a5a36' }

function Coffee({ x }: { x: number }): JSX.Element {
  return (
    <Furniture x={x} label="咖啡角：完工的子代理在这里歇着">
      <PixelMap rows={COFFEE} palette={COFFEE_PALETTE} />
    </Furniture>
  )
}

const DESK = [
  '........kkkkkk',
  '........kbbbbk',
  '........kbbbbk',
  '........kkkkkk',
  '.........kkkk.',
  'TTTTTTTTTTTTTT',
  'T............T',
  'T............T',
]
const DESK_PALETTE = { k: '#2a2a28', b: '#6fa8dc', T: '#a8774d' }

function Desk({ x }: { x: number }): JSX.Element {
  return (
    <div className={styles.desk} style={{ left: `${x}%`, top: ROOM.deskY - 32, zIndex: ROOM.deskY + 1 }}>
      <PixelMap rows={DESK} palette={DESK_PALETTE} />
    </div>
  )
}
