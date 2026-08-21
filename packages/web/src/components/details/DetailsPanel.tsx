import { useState } from 'react'

import type { SessionState } from '../../store/session.ts'
import styles from './DetailsPanel.module.css'

/** Session facts drawn from the CLI's own `init` message. */
export function DetailsPanel({
  session,
  onCollapse,
}: {
  session: SessionState | null
  onCollapse: () => void
}): JSX.Element {
  const [showTools, setShowTools] = useState(false)
  const init = session?.init
  // `session.model` holds whatever was selected, which is often an alias like
  // `sonnet`; the model list is what maps it back to a real wire id.
  const activeModel = session?.models.find(
    (model) => model.value === session.model || model.resolvedModel === session.model,
  )

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        会话详情
        <span className={styles.spacer} />
        <button className={styles.iconButton} onClick={onCollapse} type="button" title="收起面板">
          ⊟
        </button>
      </div>

      <div className={styles.body}>
        {!session ? (
          <div className={styles.empty}>尚未选择会话</div>
        ) : (
          <>
            <div className={styles.section}>
              <div className={styles.sectionTitle}>运行时</div>
              <Field
                label="模型"
                value={activeModel?.resolvedModel ?? activeModel?.displayName ?? session.model ?? init?.model ?? '—'}
              />
              <Field label="目录" value={init?.cwd ?? session.cwd} mono />
              {init && <Field label="CLI" value={init.version} />}
              <Field label="会话" value={session.sessionId.slice(0, 8)} mono />
            </div>

            <div className={styles.section}>
              <div className={styles.sectionTitle}>能力</div>
              <Field label="命令" value={String(session.commands.length || init?.slashCommands.length || 0)} />
              {init && (
                <>
                  <Field label="工具" value={String(init.tools.length)} />
                  <button className={styles.toggle} onClick={() => setShowTools(!showTools)} type="button">
                    {showTools ? '收起工具列表' : '查看工具列表'}
                  </button>
                  {showTools && (
                    <div className={styles.tags} style={{ marginTop: 8 }}>
                      {init.tools.map((tool) => (
                        <span key={tool} className={styles.tag}>
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {init ? (
              <div className={styles.section}>
                <div className={styles.sectionTitle}>MCP 服务器</div>
                {init.mcpServers.length === 0 ? (
                  <div className={styles.empty}>未配置</div>
                ) : (
                  init.mcpServers.map((server) => (
                    <div key={server.name} className={styles.mcpRow}>
                      <span
                        className={`${styles.mcpDot} ${server.status === 'connected' ? styles.mcpConnected : ''} ${
                          server.status === 'failed' ? styles.mcpFailed : ''
                        }`}
                      />
                      {server.name}
                    </div>
                  ))
                )}
              </div>
            ) : (
              // `init` opens a turn, so a freshly created session has none yet.
              <div className={styles.empty}>发送首条消息后显示工具与 MCP 详情</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${mono ? styles.mono : ''}`}>{value}</span>
    </div>
  )
}
