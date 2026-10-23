import type { UpdateProgress, UpdateStep } from '@ccw/shared'
import { useEffect, useState } from 'react'

import { useStore } from '../../store/session.ts'
import dialog from '../auth/Auth.module.css'
import { XIcon } from '../Icons.tsx'
import styles from './UpdateDialog.module.css'

const STEP_LABELS: Record<UpdateStep, string> = {
  merge: '合并代码',
  install: '安装依赖',
  build: '构建前端',
}

/** What the next release changes, and the button that installs it. */
export function UpdateDialog({ onClose }: { onClose: () => void }): JSX.Element | null {
  const update = useStore((state) => state.update)
  const applyUpdate = useStore((state) => state.applyUpdate)
  // A restart ends every runner, idle or not; an idle one loses nothing but
  // its process, so the count is the honest upper bound.
  const live = useStore((state) =>
    state.projects.reduce((count, project) => count + project.sessions.filter((session) => session.live).length, 0),
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!update?.latest) return null
  const { current, latest, changes, canApply, progress } = update

  const apply = (): void => {
    setError(null)
    void applyUpdate().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  return (
    <div className={dialog.backdrop} onMouseDown={onClose}>
      <div className={dialog.dialog} onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="更新">
        <div className={dialog.dialogHead}>
          <span className={dialog.dialogTitle}>新版本 v{latest}</span>
          <span className={dialog.spacer} />
          <button className={dialog.close} onClick={onClose} type="button" aria-label="关闭">
            <XIcon />
          </button>
        </div>
        <div className={dialog.muted}>当前版本 v{current}</div>

        {changes.length > 0 && (
          <div className={dialog.section}>
            <div className={dialog.sectionTitle}>更新内容</div>
            <ul className={styles.changes}>
              {changes.map((change, index) => (
                <li key={index}>{change}</li>
              ))}
            </ul>
          </div>
        )}

        {!canApply ? (
          <div className={`${dialog.note} ${styles.manual}`}>
            当前以 <code>pnpm dev</code> 运行，不能一键更新：合并代码的瞬间 tsx watch 就会重启 server。请在仓库目录执行{' '}
            <code>git pull --ff-only && pnpm install</code>。
          </div>
        ) : progress ? (
          <div className={`${dialog.note} ${progress.state === 'failed' ? styles.failed : ''}`}>
            {describeProgress(progress, latest)}
          </div>
        ) : (
          live > 0 && <div className={dialog.note}>更新完成后服务会重启，正在运行的 {live} 个会话会中断。</div>
        )}

        {canApply && (!progress || progress.state === 'failed') && (
          <div className={styles.actions}>
            <button className={dialog.button} onClick={onClose} type="button">
              稍后
            </button>
            <button className={`${dialog.button} ${dialog.primary}`} onClick={apply} type="button">
              {progress ? '重试' : '立即更新'}
            </button>
          </div>
        )}

        {error && <div className={dialog.error}>{error}</div>}
      </div>
    </div>
  )
}

function describeProgress(progress: UpdateProgress, latest: string): string {
  switch (progress.state) {
    case 'running':
      return `正在${STEP_LABELS[progress.step]}…`
    case 'restarting':
      return '更新完成，正在重启服务。页面会自动刷新。'
    case 'restartRequired':
      return `已更新到 v${latest}，重启服务后生效。`
    case 'failed':
      return `${STEP_LABELS[progress.step]}失败：\n${progress.error}`
  }
}
