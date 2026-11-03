import type { Share } from '@ccw/shared'
import { useEffect, useState } from 'react'

import { call } from '../../api/client.ts'
import { expiryLabel, shareHref } from '../../utils/shares.ts'
import dialog from '../auth/Auth.module.css'
import { CopyIcon, ExternalLinkIcon } from '../Icons.tsx'
import styles from './Settings.module.css'

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * The share links still valid, each to open, copy or revoke. Nothing here
 * waits for 保存: a revoke takes effect at once. Rows share the channel
 * list's card style.
 */
export function SharesSection(): JSX.Element {
  const [shares, setShares] = useState<Share[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      setShares((await call('shares.list', {})).shares)
      setError(null)
    } catch (cause) {
      setError(describe(cause))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const revoke = async (id: string): Promise<void> => {
    try {
      await call('shares.revoke', { id })
    } catch (cause) {
      setError(describe(cause))
    }
    await load()
  }

  const copy = async (share: Share): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shareHref(share))
      setCopied(share.id)
    } catch {
      setError('复制失败：浏览器不允许访问剪贴板')
    }
  }

  return (
    <section className={styles.section}>
      <div className={dialog.sectionTitle}>分享链接</div>
      <div className={dialog.muted}>
        在右侧文件预览的标题栏点「分享」生成。拿到链接的人不用配对就能打开对应的文件，撤销后立即失效。
      </div>
      {error && <div className={styles.warning}>{error}</div>}
      {shares === null ? (
        !error && <div className={dialog.muted}>读取中…</div>
      ) : shares.length === 0 ? (
        <div className={dialog.muted}>还没有分享中的文件。</div>
      ) : (
        <div className={styles.channels}>
          {shares.map((share) => (
            <div key={share.id} className={styles.channel}>
              <div className={styles.channelMain}>
                <div className={styles.channelName}>
                  <span className={styles.channelTitle}>{share.name}</span>
                </div>
                <div className={styles.channelMeta}>
                  <span className={styles.channelUrl} title={share.path}>
                    {share.path}
                  </span>
                  <span>{expiryLabel(share)}</span>
                </div>
              </div>
              <div className={styles.channelActions}>
                <a className={styles.iconButton} href={shareHref(share)} target="_blank" rel="noopener noreferrer" title="打开链接">
                  <ExternalLinkIcon size={14} />
                </a>
                <button className={styles.iconButton} onClick={() => void copy(share)} type="button" title={copied === share.id ? '已复制' : '复制链接'}>
                  <CopyIcon size={14} />
                </button>
                <button className={styles.revoke} onClick={() => void revoke(share.id)} type="button">
                  撤销
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
