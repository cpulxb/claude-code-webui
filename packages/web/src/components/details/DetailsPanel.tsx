import type { ContextUsage } from '@ccw/shared'
import { useState } from 'react'

import type { SessionState } from '../../store/session.ts'
import { PanelRightIcon } from '../Icons.tsx'
import styles from './DetailsPanel.module.css'
import { ExplorerTree } from './ExplorerTree.tsx'
import { ScmSection } from './ScmPanel.tsx'

/** Session facts drawn from the CLI's own `init` message. */
export function DetailsPanel({
  session,
  onCollapse,
}: {
  session: SessionState | null
  onCollapse: () => void
}): JSX.Element {
  const [showTools, setShowTools] = useState(false)
  const [tab, setTab] = useState<'info' | 'files'>('info')
  const init = session?.init
  // `session.model` holds whatever was selected, which is often an alias like
  // `sonnet`; the model list is what maps it back to a real wire id.
  const activeModel = session?.models.find(
    (model) => model.value === session.model || model.resolvedModel === session.model,
  )

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <button className={tab === 'info' ? styles.tabActive : styles.tab} onClick={() => setTab('info')} type="button">
          详情
        </button>
        <button
          className={tab === 'files' ? styles.tabActive : styles.tab}
          onClick={() => setTab('files')}
          type="button"
        >
          文件
        </button>
        <span className={styles.spacer} />
        <button className={styles.iconButton} onClick={onCollapse} type="button" title="收起面板">
          <PanelRightIcon />
        </button>
      </div>

      <div className={styles.body}>
        {!session ? (
          <div className={styles.empty}>尚未选择会话</div>
        ) : tab === 'files' ? (
          <ExplorerTree
            key={init?.cwd ?? session.cwd}
            cwd={init?.cwd ?? session.cwd}
            turnStatus={session.status}
          />
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

            {/* Keyed by cwd: switching workspaces drops open diffs and pending confirms. */}
            <ScmSection key={init?.cwd ?? session.cwd} cwd={init?.cwd ?? session.cwd} turnStatus={session.status} />

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

            {session.contextUsage && <ContextSection usage={session.contextUsage} />}
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

/**
 * The CLI colours these rows with theme names rather than CSS values, so the
 * mapping lives here. An unrecognised name is a new theme slot, not an error.
 */
const CONTEXT_COLORS: Record<string, string> = {
  claude: 'var(--ccw-accent)',
  permission: 'var(--ccw-accent)',
  planMode: 'var(--ccw-accent)',
  autoAccept: 'var(--ccw-success)',
  success: 'var(--ccw-success)',
  warning: 'var(--ccw-warning)',
  error: 'var(--ccw-danger)',
  text: 'var(--ccw-text-primary)',
  secondaryText: 'var(--ccw-text-secondary)',
  promptBorder: 'var(--ccw-border-l2)',
}

function contextColor(name: string): string {
  return CONTEXT_COLORS[name] ?? 'var(--ccw-text-faint)'
}

/** The `/context` grid and category breakdown, in the terminal's own layout. */
function ContextSection({ usage }: { usage: ContextUsage }): JSX.Element {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>上下文</div>
      <Field label="占用" value={`${usage.percentage}% · ${tokens(usage.totalTokens)} / ${tokens(usage.rawMaxTokens)}`} />

      <div className={styles.grid}>
        {usage.gridRows.map((row, y) => (
          <div key={y} className={styles.gridRow}>
            {row.map((cell, x) => (
              <span
                key={x}
                className={styles.square}
                style={{ background: contextColor(cell.color), opacity: cell.isFilled ? 1 : 0.2 }}
                title={`${cell.categoryName} · ${tokens(cell.tokens)}`}
              />
            ))}
          </div>
        ))}
      </div>

      {usage.categories.map((category) => (
        <div key={category.name} className={styles.catRow}>
          <span className={styles.catDot} style={{ background: contextColor(category.color) }} />
          <span className={styles.catName}>{category.name}</span>
          <span className={styles.catTokens}>{tokens(category.tokens)}</span>
        </div>
      ))}
    </div>
  )
}

function tokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}
