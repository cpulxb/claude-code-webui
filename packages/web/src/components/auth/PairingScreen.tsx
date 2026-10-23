import { useEffect, useState } from 'react'

import { pairDevice } from '../../api/client.ts'
import { BrandMark } from '../Icons.tsx'
import styles from './Auth.module.css'

/**
 * What an unpaired browser sees instead of the app. A code from `pnpm pair` or
 * from another device's "添加设备" is traded once for a device cookie; after
 * that this browser goes straight in until it is revoked or left idle.
 */
export function PairingScreen({ onPaired }: { onPaired: () => void }): JSX.Element {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (value: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await pairDevice(value)
      onPaired()
    } catch (cause) {
      setError(describeAuthError(cause))
    } finally {
      setBusy(false)
    }
  }

  // A scanned QR link carries the code in the fragment. Use it once and drop
  // it from the address bar, which also keeps StrictMode's second run a no-op.
  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.hash.slice(1)).get('pair')
    if (!fromLink) return
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    setCode(formatCode(fromLink))
    void submit(fromLink)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const complete = code.replace('-', '').length === 8

  return (
    <div className={styles.screen}>
      <form
        className={styles.card}
        onSubmit={(event) => {
          event.preventDefault()
          if (complete && !busy) void submit(code)
        }}
      >
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <BrandMark size={15} />
          </span>
          Claude Code
        </div>
        <h1 className={styles.heading}>配对这台设备</h1>
        <p className={styles.hint}>
          在服务器上运行 <code>pnpm pair</code>，或在已配对的设备上打开「设备 → 添加设备」，把配对码填在下面。每台设备只需配对一次。
        </p>
        <input
          className={styles.codeInput}
          value={code}
          onChange={(event) => setCode(formatCode(event.target.value))}
          placeholder="XXXX-XXXX"
          aria-label="配对码"
          autoFocus
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={busy}
        />
        {error && <div className={styles.error}>{error}</div>}
        <button className={`${styles.button} ${styles.primary}`} type="submit" disabled={!complete || busy}>
          {busy ? '配对中…' : '配对'}
        </button>
      </form>
    </div>
  )
}

/** Uppercase, alphanumerics only, a dash after the fourth — the way the code is printed. */
function formatCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8)
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

export function describeAuthError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message === 'invalid pairing code') return '配对码无效或已过期'
  if (message === 'too many attempts') return '错误次数过多，所有未使用的配对码都已作废，请重新生成'
  if (message === 'unauthorized') return '这台设备已不再被授权'
  return `请求失败：${message}`
}
