import type { ContextUsage, TreeEntry } from '@ccw/shared'
import { useState } from 'react'
import { useShallow } from 'zustand/shallow'

import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { HashIcon, PanelRightIcon, XIcon } from '../Icons.tsx'
import styles from './DetailsPanel.module.css'
import { ExplorerTree } from './ExplorerTree.tsx'
import { FileView } from './FileView.tsx'
import { ScmSection } from './ScmPanel.tsx'

/** Session facts drawn from the CLI's own `init` message. */
export function DetailsPanel({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const [showTools, setShowTools] = useState(false)
  // 'info' | 'files' | the absolute path of an open editor tab.
  const [tab, setTab] = useState<string>('info')
  const [openFiles, setOpenFiles] = useState<{ path: string; name: string }[]>([])
  const touchFs = useStore((state) => state.touchFs)
  // Slices rather than the session object: immer replaces that object on every
  // streamed token, which would re-render this whole panel once per token.
  // `models` goes through useShallow because re-attaching refetches the list.
  const sessionId = useActiveSessionValue((session) => session.sessionId) ?? null
  const cwd = useActiveSessionValue((session) => session.cwd)
  const status = useActiveSessionValue((session) => session.status) ?? 'idle'
  const fsVersion = useActiveSessionValue((session) => session.fsVersion) ?? 0
  const init = useActiveSessionValue((session) => session.init) ?? null
  const model = useActiveSessionValue((session) => session.model) ?? null
  const commandCount = useActiveSessionValue((session) => session.commands.length) ?? 0
  const contextUsage = useActiveSessionValue((session) => session.contextUsage) ?? null
  const models = useActiveSessionValue(useShallow((session) => session.models)) ?? []
  // One panel instance serves every session, and open tabs are absolute paths,
  // so the scope is the workspace and not the session: sibling sessions in the
  // same cwd keep the tabs (the paths stay valid), and moving to another cwd
  // drops paths that belong to the project left behind. Unmounting a FileView
  // does not lose its unsaved buffer: FileView keeps drafts keyed by path,
  // restores them when the file is opened again, and flags the conflict if the
  // file changed on disk meanwhile.
  const [tabScope, setTabScope] = useState<string | undefined>(cwd)
  if (tabScope !== cwd) {
    setTabScope(cwd)
    setTab('info')
    setOpenFiles([])
  }
  // `model` holds whatever was selected, which is often an alias like
  // `sonnet`; the model list is what maps it back to a real wire id.
  const activeModel = models.find((entry) => entry.value === model || entry.resolvedModel === model)

  const openFile = (entry: TreeEntry): void => {
    setOpenFiles((prev) =>
      prev.some((file) => file.path === entry.path) ? prev : [...prev, { path: entry.path, name: entry.name }],
    )
    setTab(entry.path)
  }

  const closeFile = (path: string): void => {
    setOpenFiles((prev) => prev.filter((file) => file.path !== path))
    if (tab === path) setTab('files')
  }

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
        {openFiles.map((file) => (
          <div
            key={file.path}
            className={tab === file.path ? `${styles.fileTab} ${styles.fileTabActive}` : styles.fileTab}
          >
            <button className={styles.fileTabName} onClick={() => setTab(file.path)} type="button" title={file.path}>
              <HashIcon size={11} />
              <span className={styles.fileTabLabel}>{file.name}</span>
            </button>
            <button className={styles.fileTabClose} onClick={() => closeFile(file.path)} type="button" title="关闭">
              <XIcon size={11} />
            </button>
          </div>
        ))}
        <span className={styles.spacer} />
        <button className={styles.iconButton} onClick={onCollapse} type="button" title="收起面板">
          <PanelRightIcon />
        </button>
      </div>

      <div className={styles.body}>
        {sessionId === null || cwd === undefined ? (
          <div className={styles.empty}>尚未选择会话</div>
        ) : (
          <>
            {/* Hidden rather than unmounted: switching tabs must not drop the
                tree's expansion state or an edit in progress in some file tab. */}
            <div hidden={tab !== 'files'}>
              <ExplorerTree
                key={init?.cwd ?? cwd}
                cwd={init?.cwd ?? cwd}
                turnStatus={status}
                fsVersion={fsVersion}
                onOpenFile={openFile}
              />
            </div>

            {openFiles.map((file) => (
              // Full-height so the editor fills the panel and scrolls inside
              // itself; the other tabs keep scrolling the body as before.
              <div key={file.path} className={styles.fileHost} hidden={tab !== file.path}>
                <FileView
                  path={file.path}
                  turnStatus={status}
                  fsVersion={fsVersion}
                  onSaved={() => touchFs(sessionId)}
                />
              </div>
            ))}

            <div hidden={tab !== 'info'}>
              <div className={styles.section}>
                <div className={styles.sectionTitle}>运行时</div>
                <Field
                  label="模型"
                  value={activeModel?.resolvedModel ?? activeModel?.displayName ?? model ?? init?.model ?? '—'}
                />
                <Field label="目录" value={init?.cwd ?? cwd} mono />
                {init && <Field label="CLI" value={init.version} />}
                <Field label="会话" value={sessionId.slice(0, 8)} mono />
              </div>

              {/* Keyed by cwd: switching workspaces drops open diffs and pending confirms. */}
              <ScmSection
                key={init?.cwd ?? cwd}
                cwd={init?.cwd ?? cwd}
                turnStatus={status}
                fsVersion={fsVersion}
              />

              <div className={styles.section}>
                <div className={styles.sectionTitle}>能力</div>
                <Field label="命令" value={String(commandCount || init?.slashCommands.length || 0)} />
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

              {contextUsage && <ContextSection usage={contextUsage} />}
            </div>
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
