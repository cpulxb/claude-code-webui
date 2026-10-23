import type { AuthStatus, DeviceInfo, PairingCode } from '@ccw/shared'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

import { createPairingCode, fetchAuthStatus, listDevices, revokeDevice } from '../../api/client.ts'
import { XIcon } from '../Icons.tsx'
import styles from './Auth.module.css'
import { describeAuthError } from './PairingScreen.tsx'

/** Paired devices, revocation, and a code (with a QR link) for the next one. */
export function DevicesDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [pending, setPending] = useState<{ code: PairingCode; qr: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = useNow(pending !== null)

  const refresh = async (): Promise<void> => {
    try {
      const [nextStatus, nextDevices] = await Promise.all([fetchAuthStatus(), listDevices()])
      setStatus(nextStatus)
      setDevices(nextDevices)
    } catch (cause) {
      setError(describeAuthError(cause))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const addDevice = async (): Promise<void> => {
    setError(null)
    try {
      const code = await createPairingCode()
      // A QR pointing at localhost would open the phone's own localhost, so on
      // a loopback origin only the code is shown.
      const qr = isLoopbackOrigin()
        ? null
        : await QRCode.toDataURL(`${window.location.origin}/#pair=${code.code}`, { margin: 1, width: 192 })
      setPending({ code, qr })
    } catch (cause) {
      setError(describeAuthError(cause))
    }
  }

  const revoke = async (device: DeviceInfo): Promise<void> => {
    if (device.current && !window.confirm('吊销本设备后，这个浏览器需要重新配对。确定吗？')) return
    setError(null)
    try {
      await revokeDevice(device.id)
      await refresh()
    } catch (cause) {
      setError(describeAuthError(cause))
    }
  }

  const secondsLeft = pending ? Math.max(0, Math.ceil((pending.code.expiresAt - now) / 1000)) : 0

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.dialog} onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="设备">
        <div className={styles.dialogHead}>
          <span className={styles.dialogTitle}>设备</span>
          <span className={styles.spacer} />
          <button className={styles.close} onClick={onClose} type="button" aria-label="关闭">
            <XIcon />
          </button>
        </div>

        {status?.local && <div className={styles.note}>当前是在服务器本机访问，无需配对。</div>}

        <div className={styles.section}>
          <div className={styles.sectionTitle}>已配对的设备</div>
          {devices === null && !error && <div className={styles.muted}>加载中…</div>}
          {devices?.length === 0 && <div className={styles.muted}>还没有配对过任何设备</div>}
          {devices?.map((device) => (
            <div key={device.id} className={styles.device}>
              <div className={styles.deviceText}>
                <div className={styles.deviceName}>
                  {device.name}
                  {device.current && <span className={styles.badge}>本设备</span>}
                </div>
                <div className={styles.deviceMeta}>
                  {ago(device.lastSeenAt)}活跃 · {device.lastIp} · 配对于 {new Date(device.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button className={styles.revoke} onClick={() => void revoke(device)} type="button">
                吊销
              </button>
            </div>
          ))}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>添加设备</div>
          {pending && secondsLeft > 0 ? (
            <div className={styles.pairing}>
              {pending.qr && <img className={styles.qr} src={pending.qr} alt="配对二维码" width={192} height={192} />}
              <div className={styles.pairingText}>
                <div className={styles.code}>{pending.code.code}</div>
                <div className={styles.muted}>
                  {pending.qr ? '用新设备扫码，或在它的配对页输入上面的码。' : '在新设备上打开服务器的远程地址，输入上面的码。'}
                  {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')} 后失效，只能用一次。
                </div>
              </div>
            </div>
          ) : (
            <button className={styles.button} onClick={() => void addDevice()} type="button">
              {pending ? '已过期，重新生成配对码' : '生成配对码'}
            </button>
          )}
        </div>

        {error && <div className={styles.error}>{error}</div>}
      </div>
    </div>
  )
}

/** Re-renders every second while `active`, for the code's countdown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function isLoopbackOrigin(): boolean {
  const host = window.location.hostname
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host)
}

function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
