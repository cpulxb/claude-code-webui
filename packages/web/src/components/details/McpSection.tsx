import type { McpServerStatus } from '@ccw/shared'
import { useEffect, useState } from 'react'

import { call } from '../../api/client.ts'
import styles from './DetailsPanel.module.css'

const STATUS_LABEL: Record<string, string> = {
  failed: '连接失败',
  'needs-auth': '需要认证',
  pending: '连接中',
  disabled: '已禁用',
}

/**
 * `/mcp`: live server status with the terminal's per-server actions. `init`
 * only snapshots the list when a turn opens, so it stands in until the runner
 * answers — and is all there is while the session is detached.
 */
export function McpSection({
  sessionId,
  attached,
  snapshot,
}: {
  sessionId: string
  attached: boolean
  snapshot: { name: string; status: string }[] | null
}): JSX.Element {
  const [live, setLive] = useState<McpServerStatus[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLive(null)
    setError(null)
    if (!attached) return
    let stale = false
    call('session.mcpStatus', { sessionId })
      .then(({ servers }) => {
        if (!stale) setLive(servers)
      })
      .catch((reason: unknown) => {
        if (!stale) setError(`读取 MCP 状态失败：${String(reason)}`)
      })
    return () => {
      stale = true
    }
  }, [sessionId, attached])

  const act = async (request: Promise<{ servers: McpServerStatus[] }>, failure: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setLive((await request).servers)
    } catch (reason) {
      setError(`${failure}：${String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const servers: (McpServerStatus | { name: string; status: string })[] = live ?? snapshot ?? []

  return (
    <div className={styles.section} id="ccw-info-mcp">
      <div className={styles.sectionTitle}>MCP 服务器</div>
      {live === null && snapshot === null ? (
        // `init` opens a turn, so a freshly created session has none yet.
        <div className={styles.empty}>发送首条消息后显示工具与 MCP 详情</div>
      ) : servers.length === 0 ? (
        <div className={styles.empty}>未配置</div>
      ) : (
        servers.map((server) => {
          const detail = 'error' in server ? server.error : undefined
          const tools = 'tools' in server ? server.tools?.length : undefined
          const disabled = server.status === 'disabled'
          return (
            <div key={server.name} className={styles.mcpItem}>
              <div className={styles.mcpRow}>
                <span
                  className={`${styles.mcpDot} ${server.status === 'connected' ? styles.mcpConnected : ''} ${
                    server.status === 'failed' ? styles.mcpFailed : ''
                  }`}
                />
                <span className={styles.mcpName}>{server.name}</span>
                <span className={styles.mcpMeta}>
                  {STATUS_LABEL[server.status] ?? (tools !== undefined ? `${tools} 工具` : '')}
                </span>
                {live && (
                  <span className={styles.mcpActions}>
                    {!disabled && (
                      <button
                        className={styles.toggle}
                        disabled={busy}
                        onClick={() =>
                          void act(call('session.mcpReconnect', { sessionId, name: server.name }), `重连 ${server.name} 失败`)
                        }
                        type="button"
                      >
                        重连
                      </button>
                    )}
                    <button
                      className={styles.toggle}
                      disabled={busy}
                      onClick={() =>
                        void act(
                          call('session.mcpToggle', { sessionId, name: server.name, enabled: disabled }),
                          `${disabled ? '启用' : '禁用'} ${server.name} 失败`,
                        )
                      }
                      type="button"
                    >
                      {disabled ? '启用' : '禁用'}
                    </button>
                  </span>
                )}
              </div>
              {detail && <div className={styles.mcpError}>{detail}</div>}
            </div>
          )
        })
      )}
      {error && <div className={styles.mcpError}>{error}</div>}
    </div>
  )
}
