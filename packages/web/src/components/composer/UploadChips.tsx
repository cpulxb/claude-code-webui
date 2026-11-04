import type { Upload, UploadStatus } from '../../utils/attachments.ts'
import { XIcon } from '../Icons.tsx'
import styles from './Composer.module.css'

const LABEL: Record<UploadStatus, string> = {
  queued: '等待上传',
  uploading: '上传中',
  processing: '服务器校验中',
  ready: '已上传',
  error: '上传失败',
  cancelled: '已取消',
}

export function UploadChips({ uploads, onCancel, onRetry, onRemove }: {
  uploads: readonly Upload[]
  onCancel: (key: number) => void
  onRetry: (key: number) => void
  onRemove: (key: number) => void
}): JSX.Element | null {
  if (uploads.length === 0) return null
  return (
    <div className={styles.attachments} role="list" aria-label="上传文件">
      {uploads.map((item) => {
        const pending = item.status === 'queued' || item.status === 'uploading' || item.status === 'processing'
        const retryable = item.status === 'error' || item.status === 'cancelled'
        const percent = Math.floor(item.loaded / item.file.size * 100)
        return (
          <div
            key={item.key}
            className={`${styles.chip} ${pending ? styles.chipPending : ''} ${item.status === 'error' ? styles.chipError : ''}`}
            role="listitem"
          >
            <div className={styles.chipHeader}>
              <span className={styles.chipName} title={item.file.name}>{item.file.name}</span>
              {pending && (
                <button className={styles.chipAction} onClick={() => onCancel(item.key)} type="button" aria-label={`取消上传 ${item.file.name}`}>
                  取消
                </button>
              )}
              {retryable && (
                <button className={styles.chipAction} onClick={() => onRetry(item.key)} type="button" aria-label={`重新上传 ${item.file.name}`}>
                  重试
                </button>
              )}
              <button
                className={styles.chipRemove}
                onClick={() => onRemove(item.key)}
                type="button"
                aria-label={`移除附件 ${item.file.name}`}
                title={item.status === 'ready' ? '移除本条消息中的引用，服务器上的文件会保留' : '移除附件并取消未完成的上传'}
              >
                <XIcon size={12} />
              </button>
            </div>
            <div className={styles.uploadStatus}>
              <span role="status">{LABEL[item.status]}</span>
              <span> · {pending ? `${percent}% · ${formatBytes(item.loaded)} / ` : ''}{formatBytes(item.file.size)}</span>
            </div>
            {pending && (
              <progress
                className={styles.uploadProgress}
                max={item.file.size}
                value={item.loaded}
                aria-label={`${item.file.name} 上传进度`}
              />
            )}
            {item.status === 'ready' && item.path && (
              <div className={styles.uploadPath} title={`已保存到 ${item.path}，发送时以 @${item.path} 引用`}>@{item.path}</div>
            )}
            {item.error && <div className={styles.uploadError} role="alert">{item.error}</div>}
          </div>
        )
      })}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
