import { API_FILES_RAW_PATH, SHARE_PATH, type Share, type ShareTtl } from '@ccw/shared'

export const TTL_LABELS: Record<ShareTtl, string> = { '1h': '1 小时', '1d': '1 天', '7d': '7 天', never: '永久' }

/** The file itself for this device: opened in a tab, or saved with `download`. */
export function rawFileHref(path: string, download = false): string {
  return `${API_FILES_RAW_PATH}?${new URLSearchParams({ path, ...(download ? { download: '1' } : {}) })}`
}

/** The link to hand out, on whatever address this page was opened at. */
export function shareHref(share: Pick<Share, 'token' | 'name'>, origin = window.location.origin): string {
  return `${origin}${SHARE_PATH}/${share.token}/${encodeURIComponent(share.name)}`
}

/** "3 天后失效", or "永久有效" for a link that lasts until revoked. */
export function expiryLabel(share: Pick<Share, 'expiresAt'>, now = Date.now()): string {
  if (share.expiresAt === null) return '永久有效'
  const left = share.expiresAt - now
  if (left <= 0) return '已失效'
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return `${minutes} 分钟后失效`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时后失效`
  return `${Math.round(hours / 24)} 天后失效`
}
