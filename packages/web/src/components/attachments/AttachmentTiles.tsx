import { uploadKind } from '@ccw/shared'
import { useEffect, useState, type ReactNode } from 'react'

import styles from './Attachments.module.css'

type Tone = 'pdf' | 'word' | 'sheet' | 'slides' | 'video' | 'zip' | 'image' | 'text'

const TONE_LABEL: Record<Tone, string> = {
  pdf: 'PDF 文档',
  word: 'Word 文档',
  sheet: '表格',
  slides: '演示文稿',
  video: '视频',
  zip: '压缩包',
  image: '图片',
  text: '文本',
}

function extension(name: string): string {
  return /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
}

function toneOf(name: string): Tone {
  const ext = extension(name)
  if (ext === 'doc' || ext === 'docx') return 'word'
  if (['xls', 'xlsx', 'csv', 'tsv'].includes(ext)) return 'sheet'
  if (ext === 'ppt' || ext === 'pptx') return 'slides'
  const kind = uploadKind(name)
  return kind === null || kind === 'office' ? 'text' : kind
}

/** "Word 文档" and the like, for a card with nothing better to say. */
export function fileKindLabel(name: string): string {
  return TONE_LABEL[toneOf(name)]
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** An object URL for the blob, revoked when it changes or the caller unmounts. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) return
    const created = URL.createObjectURL(blob)
    setUrl(created)
    return () => {
      URL.revokeObjectURL(created)
      setUrl(null)
    }
  }, [blob])
  return url
}

type TileProps = { name: string; title?: string; href?: string; children?: ReactNode }

/** Without `href` it is a plain box, so the composer can put buttons inside. */
function Frame({ className, title, href, children }: { className: string; title?: string; href?: string; children: ReactNode }): JSX.Element {
  return href ? (
    <a className={className} title={title} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <div className={className} title={title}>
      {children}
    </div>
  )
}

export function FileCard({ name, detail, title, href, children }: TileProps & { detail: string }): JSX.Element {
  const ext = extension(name)
  return (
    <Frame className={styles.file} title={title} href={href}>
      <span className={styles.badge} data-tone={toneOf(name)} aria-hidden="true">
        {ext === 'markdown' ? 'MD' : (ext.length > 5 ? ext.slice(0, 4) : ext).toUpperCase() || 'FILE'}
      </span>
      <span className={styles.meta}>
        <span className={styles.name}>{name}</span>
        <span className={styles.detail}>{detail}</span>
      </span>
      {children}
    </Frame>
  )
}

export function ImageTile({ name, src, title, href, onError, children }: TileProps & { src: string; onError?: () => void }): JSX.Element {
  return (
    <Frame className={styles.image} title={title} href={href}>
      <img src={src} alt={name} loading="lazy" draggable={false} onError={onError} />
      {children}
    </Frame>
  )
}
