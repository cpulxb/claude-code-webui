import { type ReactNode } from 'react'

/**
 * Stroke icons for the chrome around the chat (panel toggles, theme switch).
 * They share one geometry so the header reads as a set: 24-unit grid, 2-unit
 * rounded strokes, drawn at 16px. The mode glyphs in `composer/ModeIcon.tsx`
 * are filled traces instead — keep the two families apart.
 */
function Icon(props: { size?: number; children: ReactNode }): JSX.Element {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  )
}

export function PanelLeftIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </Icon>
  )
}

export function PanelRightIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </Icon>
  )
}

export function MoonIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Icon>
  )
}

export function SunIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </Icon>
  )
}

export function RefreshIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </Icon>
  )
}

export function UndoIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Icon>
  )
}

export function FolderIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  )
}

export function FolderOpenIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    </Icon>
  )
}

/** dsh 风格的文件行标记 — 树里的文件不用纸页图标，用 #。 */
export function HashIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M4 9h16" />
      <path d="M4 15h16" />
      <path d="m10 3-2 18" />
      <path d="m16 3-2 18" />
    </Icon>
  )
}

export function XIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  )
}

export function HistoryIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </Icon>
  )
}
