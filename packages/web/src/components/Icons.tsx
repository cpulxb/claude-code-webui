import { type ReactNode } from 'react'

/**
 * Stroke icons for the chrome around the chat (panel toggles, theme switch).
 * They share one geometry so the header reads as a set: 24-unit grid, 2-unit
 * rounded strokes, drawn at 16px. The mode glyphs in `composer/ModeIcon.tsx`
 * are filled traces instead — keep the two families apart.
 */
function Icon(props: { size?: number; strokeWidth?: number; children: ReactNode }): JSX.Element {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={props.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  )
}

/**
 * 品牌标：八辐星，即原来那个 ✳ 字符的描边版。线宽加粗到 2.9，16px 下辐条间仍留得出空隙。
 * `public/favicon.svg` 是同一组路径，改这里要一起改。
 */
export function BrandMark(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size} strokeWidth={2.9}>
      <path d="M12 3.2v17.6M3.2 12h17.6M5.78 5.78l12.44 12.44M18.22 5.78 5.78 18.22" />
    </Icon>
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

/** VS Code 式的 `@` 文件菜单用纸页图标；Explorer 树里也是未知类型文件的兜底图标。 */
export function FileIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
    </Icon>
  )
}

export function DumbbellIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M7 6v12" />
      <path d="M17 6v12" />
      <path d="M3.5 9v6" />
      <path d="M20.5 9v6" />
      <path d="M7 12h10" />
    </Icon>
  )
}

export function CheckIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M20 6 9 17l-5-5" />
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

/** 「开始」标签页：罗盘。页面中央那枚画得很大，所以允许传更细的线宽。 */
export function CompassIcon(props: { size?: number; strokeWidth?: number }): JSX.Element {
  return (
    <Icon size={props.size} strokeWidth={props.strokeWidth}>
      <circle cx="12" cy="12" r="10" />
      <path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z" />
    </Icon>
  )
}

export function InfoIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Icon>
  )
}

export function PlusIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  )
}

export function MaximizeIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </Icon>
  )
}

export function MinimizeIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </Icon>
  )
}

export function CopyIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  )
}

export function TerminalIcon(props: { size?: number }): JSX.Element {
  return (
    <Icon size={props.size}>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </Icon>
  )
}
