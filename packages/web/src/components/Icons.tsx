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
