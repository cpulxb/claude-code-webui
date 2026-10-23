import { type PermissionMode } from '@ccw/shared'

/**
 * The composer's glyph set: the six permission modes plus effort and
 * ultracode. All are drawn on one 20×20 grid with a 1.3 stroke and round
 * joins, the same optical size and weight the VS Code extension's menu uses,
 * so any two of them can sit side by side without one looking heavier.
 */
function Glyph(props: { size?: number; className?: string; children: React.ReactNode }): JSX.Element {
  const size = props.size ?? 16
  return (
    <svg
      className={props.className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      {props.children}
    </svg>
  )
}

const MODE_GLYPHS: Record<PermissionMode, JSX.Element> = {
  // Open hand: Claude stops and asks.
  default: (
    <path d="M7.25 10.25V4.6a1.1 1.1 0 0 1 2.2 0v4.9M9.45 9.5V3.6a1.1 1.1 0 0 1 2.2 0v5.9M11.65 9.5V4.6a1.1 1.1 0 0 1 2.2 0v5.4M13.85 10V6.85a1.1 1.1 0 0 1 2.2 0v4.65c0 3.2-2.3 5.75-5.4 5.75-2.1 0-3.45-.9-4.5-2.7l-2.2-3.75a1.15 1.15 0 0 1 1.9-1.3l1.45 1.75" />
  ),
  // Code brackets: edits land without asking.
  acceptEdits: <path d="M11.6 4.5 8.4 15.5M13.5 6.5 17 10l-3.5 3.5M6.5 6.5 3 10l3.5 3.5" />,
  // A page with a checklist: explore, then propose.
  plan: (
    <>
      <path d="M11.75 2.75H6.25a1.5 1.5 0 0 0-1.5 1.5v11.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V6.25z" />
      <path d="M11.75 2.75v3.5h3.5" />
      <path d="m7.5 9.6.8.8 1.4-1.5M11.25 9.75h1.75M7.5 13.1l.8.8 1.4-1.5M11.25 13.25h1.75" />
    </>
  ),
  // Lightning: approved automatically after a safety check.
  auto: <path d="M10.9 2.6 4.6 10.75h5.15l-.65 6.65 6.3-8.15h-5.15z" />,
  // A shield struck through: the safety checks are off. The outline breaks
  // where the slash crosses it, so the two don't merge at 14px.
  bypassPermissions: (
    <>
      <path d="M15.08 12.89c.43-.93.67-1.98.67-3.14V4.5c-2.25 0-4.25-.75-5.75-2-.99.83-2.2 1.43-3.56 1.75M4.25 6.44v3.31c0 3.75 2.5 6.25 5.75 7.75 1.2-.56 2.31-1.25 3.22-2.09" />
      <path d="m2.75 2.75 14.5 14.5" />
    </>
  ),
  // No entry: anything not pre-approved is refused.
  dontAsk: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m5.05 5.05 9.9 9.9" />
    </>
  ),
}

export function ModeIcon(props: { mode: PermissionMode; size?: number; className?: string }): JSX.Element {
  return (
    <Glyph size={props.size} className={props.className}>
      {MODE_GLYPHS[props.mode]}
    </Glyph>
  )
}

/** Dumbbell: how hard the model works on each turn. */
export function EffortIcon(props: { size?: number; className?: string }): JSX.Element {
  return (
    <Glyph size={props.size} className={props.className}>
      <rect x="4.75" y="5.5" width="2.5" height="9" rx="1" />
      <rect x="12.75" y="5.5" width="2.5" height="9" rx="1" />
      <path d="M2.25 8.25v3.5M17.75 8.25v3.5M2.25 10h2.5M15.25 10h2.5M7.25 10h5.5" />
    </Glyph>
  )
}

/** Rocket: ultracode launches multi-agent workflows on every task. */
export function UltracodeIcon(props: { size?: number; className?: string }): JSX.Element {
  return (
    <Glyph size={props.size} className={props.className}>
      <path d="M8.15 13.1 6.9 11.85l1.6-3.6C10.6 4.3 13.6 2.8 17.1 2.9c.1 3.5-1.4 6.5-5.35 8.6z" />
      <circle cx="13.1" cy="6.9" r="1.35" />
      <path d="M8.5 8.25H5.6L3.4 10.4l3.5 1.45M11.75 11.5v2.9l-2.15 2.2-1.45-3.5" />
      <path d="M5.9 14.1c-1.15.15-2.05 1.15-2.4 3 1.85-.35 2.85-1.25 3-2.4" />
    </Glyph>
  )
}
