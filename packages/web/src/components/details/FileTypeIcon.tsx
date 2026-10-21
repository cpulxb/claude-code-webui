import { FileIcon } from '../Icons.tsx'

type Badge = { label: string; bg: string; fg: string }

const WHITE = '#ffffff'
const INK = '#1a1a17'

/**
 * dsh-style coloured badges for the editor tabs and the Explorer tree. Each
 * badge is the language's own brand colour, so the colours stay fixed rather
 * than following the theme tokens. Unknown extensions fall back to the plain
 * stroke page in the surrounding text colour.
 */
const BADGES: Record<string, Badge> = {
  ts: { label: 'TS', bg: '#3178c6', fg: WHITE },
  tsx: { label: 'TS', bg: '#3178c6', fg: WHITE },
  mts: { label: 'TS', bg: '#3178c6', fg: WHITE },
  cts: { label: 'TS', bg: '#3178c6', fg: WHITE },
  js: { label: 'JS', bg: '#f0d43a', fg: INK },
  jsx: { label: 'JS', bg: '#f0d43a', fg: INK },
  mjs: { label: 'JS', bg: '#f0d43a', fg: INK },
  cjs: { label: 'JS', bg: '#f0d43a', fg: INK },
  json: { label: '{}', bg: '#e8a33d', fg: WHITE },
  jsonc: { label: '{}', bg: '#e8a33d', fg: WHITE },
  md: { label: 'MD', bg: '#4a7cf7', fg: WHITE },
  mdx: { label: 'MD', bg: '#4a7cf7', fg: WHITE },
  markdown: { label: 'MD', bg: '#4a7cf7', fg: WHITE },
  yaml: { label: 'YML', bg: '#cb4b5f', fg: WHITE },
  yml: { label: 'YML', bg: '#cb4b5f', fg: WHITE },
  toml: { label: 'TML', bg: '#9c4221', fg: WHITE },
  css: { label: 'CSS', bg: '#663399', fg: WHITE },
  scss: { label: 'CSS', bg: '#c6538c', fg: WHITE },
  less: { label: 'CSS', bg: '#1d365d', fg: WHITE },
  html: { label: '<>', bg: '#e34c26', fg: WHITE },
  htm: { label: '<>', bg: '#e34c26', fg: WHITE },
  py: { label: 'PY', bg: '#3572a5', fg: WHITE },
  go: { label: 'GO', bg: '#00add8', fg: WHITE },
  rs: { label: 'RS', bg: '#dea584', fg: INK },
  java: { label: 'JV', bg: '#b07219', fg: WHITE },
  c: { label: 'C', bg: '#555555', fg: WHITE },
  h: { label: 'H', bg: '#555555', fg: WHITE },
  cpp: { label: 'C++', bg: '#f34b7d', fg: WHITE },
  cs: { label: 'C#', bg: '#9b4f96', fg: WHITE },
  sh: { label: 'SH', bg: '#4eaa25', fg: WHITE },
  bash: { label: 'SH', bg: '#4eaa25', fg: WHITE },
  zsh: { label: 'SH', bg: '#4eaa25', fg: WHITE },
  sql: { label: 'SQL', bg: '#e38c00', fg: WHITE },
}

/** Mirrors the server's preview list (files/explorer.ts), which is what renders as an image. */
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'])

export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }): JSX.Element {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''

  if (IMAGES.has(ext)) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="14" height="14" rx="3" fill="#9b6ef3" />
        <circle cx="5.5" cy="5.5" r="1.5" fill={WHITE} />
        <path d="M2.5 12.5 6.5 8l2.5 2.5L11 8.5l2.5 4Z" fill={WHITE} />
      </svg>
    )
  }

  const badge = BADGES[ext]
  if (!badge) return <FileIcon size={size} />

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="14" height="14" rx="3" fill={badge.bg} />
      <text
        x="8"
        y="8.5"
        dominantBaseline="middle"
        textAnchor="middle"
        // Three letters only fit the 14-unit badge at a smaller size.
        fontSize={badge.label.length > 2 ? 5.2 : 7}
        fontWeight={700}
        fill={badge.fg}
        style={{ fontFamily: 'var(--ccw-font-ui)' }}
      >
        {badge.label}
      </text>
    </svg>
  )
}

/** dsh's filled yellow folder — the 文件 tab and its start-page card. */
export function WorkspaceFolderIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.1l1.6 1.6H13A1.5 1.5 0 0 1 14.5 5.6V12A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12Z" fill="#f2b33d" />
      <path d="M1.5 6.2h13V12a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12Z" fill="#fcc94f" />
      <path d="M4 8.6h5" stroke={WHITE} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
