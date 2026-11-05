import { UPLOAD_DIR, uploadKind } from '@ccw/shared'
import { useMemo, useState } from 'react'

import type { PromptImage } from '../../render/nodes.ts'
import { rawFileHref } from '../../utils/shares.ts'
import { FileCard, fileKindLabel, ImageTile, useObjectUrl } from './AttachmentTiles.tsx'
import styles from './Attachments.module.css'

/** What a sent prompt carried: inline images, then the files it mentions from `upload/`. */
export function PromptAttachments({ images, refs, cwd, spaced }: {
  images: readonly PromptImage[] | undefined
  /** `upload/<name>`, relative to `cwd`. */
  refs: readonly string[]
  cwd: string | undefined
  /** Text follows the tiles. */
  spaced: boolean
}): JSX.Element | null {
  if (!images?.length && refs.length === 0) return null
  return (
    <div className={`${styles.prompt} ${spaced ? styles.spaced : ''}`}>
      {images?.map((image, index) => <InlineImage key={index} image={image} />)}
      {refs.map((ref) => <UploadRef key={ref} path={ref} cwd={cwd} />)}
    </div>
  )
}

function InlineImage({ image }: { image: PromptImage }): JSX.Element | null {
  const blob = useMemo(() => (image.data ? toBlob(image) : null), [image])
  // A blob URL, unlike a data URL, can be opened in a new tab.
  const url = useObjectUrl(blob)
  if (url) return <ImageTile name="图片" src={url} href={url} title="随消息内联发送的图片，点击在新标签页查看" />
  if (blob) return null // the first render, before the effect makes its URL
  // History arrives without the bytes, and only the model ever had them.
  const subtype = image.mediaType.split('/')[1]
  return (
    <FileCard
      name={`内联图片.${subtype === 'jpeg' ? 'jpg' : subtype}`}
      detail="随消息发送，不保留预览"
      title="内联图片没有存到 upload/，重新打开会话后无法预览"
    />
  )
}

function UploadRef({ path, cwd }: { path: string; cwd: string | undefined }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const name = path.slice(UPLOAD_DIR.length + 1)
  const href = cwd === undefined ? undefined : rawFileHref(`${cwd}/${path}`)
  const title = `@${path}${href ? '，点击在新标签页打开' : ''}`
  if (href && !broken && uploadKind(name) === 'image') {
    return <ImageTile name={name} src={href} href={href} title={title} onError={() => setBroken(true)} />
  }
  // Also an image whose preview failed, e.g. one deleted from upload/ since.
  return <FileCard name={name} detail={fileKindLabel(name)} href={href} title={title} />
}

function toBlob({ mediaType, data }: PromptImage): Blob | null {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: mediaType })
  } catch {
    return null
  }
}
