import { uploadKind } from '@ccw/shared'
import { useState } from 'react'

import { isPending, type Upload } from '../../utils/attachments.ts'
import { FileCard, formatBytes, ImageTile, useObjectUrl } from '../attachments/AttachmentTiles.tsx'
import { RefreshIcon, XIcon } from '../Icons.tsx'
import styles from './Composer.module.css'

export function UploadChips({ uploads, onRetry, onRemove }: {
  uploads: readonly Upload[]
  onRetry: (key: number) => void
  onRemove: (key: number) => void
}): JSX.Element | null {
  if (uploads.length === 0) return null
  const failed = uploads.filter((item) => item.status === 'error')
  return (
    <>
      <div className={styles.attachments} role="list" aria-label="附件">
        {uploads.map((item) => (
          <UploadChip key={item.key} item={item} onRetry={() => onRetry(item.key)} onRemove={() => onRemove(item.key)} />
        ))}
      </div>
      {failed.length > 0 && (
        <div className={styles.uploadErrors} role="alert">
          {failed.map((item) => <div key={item.key}>{item.file.name}：{item.error}</div>)}
        </div>
      )}
    </>
  )
}

function UploadChip({ item, onRetry, onRemove }: { item: Upload; onRetry: () => void; onRemove: () => void }): JSX.Element {
  const { file, status } = item
  const [broken, setBroken] = useState(false)
  const preview = useObjectUrl(uploadKind(file.name) === 'image' && !broken ? file : null)
  const pending = isPending(status)
  const percent = Math.floor((item.loaded / file.size) * 100)
  // `processing` before any bytes left is the image being read for inlining.
  const progress =
    status === 'queued' ? '等待' : status === 'uploading' ? `${percent}%` : item.loaded === file.size ? '校验中' : '处理中'
  const title =
    status === 'ready'
      ? item.inline
        ? `${file.name} · 随消息直接发送给模型`
        : `${file.name} · 已保存到 ${item.path}，发送时以 @${item.path} 引用`
      : status === 'error'
        ? `${file.name} · 上传失败：${item.error}`
        : `${file.name} · ${progress}`
  const bar = status === 'uploading' && <span className={styles.uploadBar} style={{ width: `${percent}%` }} />

  return (
    <div className={`${styles.chip} ${status === 'error' ? styles.chipFailed : ''}`} role="listitem">
      {preview ? (
        <ImageTile name={file.name} src={preview} title={title} onError={() => setBroken(true)}>
          {pending && <span className={styles.tileOverlay}>{progress}</span>}
          {status === 'error' && (
            <button className={styles.tileOverlay} onClick={onRetry} type="button" aria-label={`重新上传 ${file.name}`}>
              <RefreshIcon size={16} />
            </button>
          )}
          {bar}
        </ImageTile>
      ) : (
        <FileCard
          name={file.name}
          detail={status === 'error' ? '上传失败' : pending ? `${progress} · ${formatBytes(file.size)}` : formatBytes(file.size)}
          title={title}
        >
          {status === 'error' && (
            <button className={styles.chipRetry} onClick={onRetry} type="button" aria-label={`重新上传 ${file.name}`} title="重新上传">
              <RefreshIcon size={14} />
            </button>
          )}
          {bar}
        </FileCard>
      )}
      <button
        className={styles.tileRemove}
        onClick={onRemove}
        type="button"
        aria-label={`移除附件 ${file.name}`}
        title={pending ? '取消上传并移除' : item.path ? '移除引用（服务器上的文件会保留）' : '移除'}
      >
        <XIcon size={10} />
      </button>
    </div>
  )
}
