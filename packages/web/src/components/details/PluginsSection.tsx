import type { PluginAction, PluginInfo } from '@ccw/shared'
import { useEffect, useState } from 'react'

import { call } from '../../api/client.ts'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import styles from './DetailsPanel.module.css'

const ACTION_LABEL: Record<PluginAction, string> = {
  enable: '启用',
  disable: '禁用',
  update: '更新',
  uninstall: '卸载',
}

/**
 * `/plugins`: every installed plugin with the terminal menu's actions. The
 * server reloads plugins into the session after each one, so their skills
 * and commands come and go without a restart.
 */
export function PluginsSection({ sessionId, attached }: { sessionId: string; attached: boolean }): JSX.Element {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [pending, setPending] = useState<{ id: string; action: PluginAction } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PluginInfo | null>(null)

  useEffect(() => {
    if (!attached) return
    let stale = false
    call('session.plugins', { sessionId })
      .then(({ plugins }) => {
        if (!stale) setPlugins(plugins)
      })
      .catch((reason: unknown) => {
        if (!stale) setError(`读取插件失败：${message(reason)}`)
      })
    return () => {
      stale = true
    }
  }, [sessionId, attached])

  const act = async (plugin: PluginInfo, action: PluginAction): Promise<void> => {
    setPending({ id: plugin.id, action })
    setError(null)
    setNotice(null)
    try {
      const result = await call('session.pluginAction', { sessionId, id: plugin.id, scope: plugin.scope, action })
      setPlugins(result.plugins)
      setNotice(result.notice ?? null)
    } catch (reason) {
      setError(`${ACTION_LABEL[action]} ${plugin.id} 失败：${message(reason)}`)
    } finally {
      setPending(null)
    }
  }

  const button = (
    plugin: PluginInfo,
    action: PluginAction,
    onClick: () => void = () => void act(plugin, action),
  ): JSX.Element => (
    <button className={styles.toggle} disabled={pending !== null} onClick={onClick} type="button">
      {pending?.id === plugin.id && pending.action === action ? `${ACTION_LABEL[action]}中…` : ACTION_LABEL[action]}
    </button>
  )

  return (
    <div className={styles.section} id="ccw-info-plugins">
      <div className={styles.sectionTitle}>插件</div>
      {!attached || plugins === null ? (
        <div className={styles.empty}>{attached ? '读取中…' : '会话启动后显示'}</div>
      ) : plugins.length === 0 ? (
        <div className={styles.empty}>没有安装插件</div>
      ) : (
        plugins.map((plugin) => {
          const [name, marketplace] = plugin.id.split('@')
          // Loaded straight from ~/.claude/skills: no marketplace to update
          // from, nothing to uninstall but the directory itself.
          const local = marketplace === 'skills-dir'
          const version = plugin.version && plugin.version !== 'unknown' ? ` · ${plugin.version}` : ''
          return (
            <div key={`${plugin.scope}/${plugin.id}`} className={`${styles.mcpItem} ${styles.mcpRow}`}>
              <span className={`${styles.mcpDot} ${plugin.enabled ? styles.mcpConnected : ''}`} />
              <span className={styles.mcpName} title={[plugin.id, plugin.installPath].filter(Boolean).join('\n')}>
                {name}
              </span>
              <span className={styles.mcpMeta}>
                {plugin.scope}
                {version}
              </span>
              <span className={styles.mcpActions}>
                {!local && button(plugin, 'update')}
                {!local && button(plugin, 'uninstall', () => setRemoving(plugin))}
                {button(plugin, plugin.enabled ? 'disable' : 'enable')}
              </span>
            </div>
          )
        })
      )}
      {notice && <div className={styles.note}>{notice}</div>}
      {error && <div className={styles.mcpError}>{error}</div>}

      {removing && (
        <ConfirmDialog
          title={`卸载 ${removing.id}？`}
          message="插件文件和它保存的数据都会删除，以后要用得重新安装。"
          confirmLabel="卸载"
          danger
          onConfirm={() => {
            setRemoving(null)
            void act(removing, 'uninstall')
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  )
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
