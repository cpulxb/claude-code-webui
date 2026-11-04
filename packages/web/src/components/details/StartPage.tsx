import type { ReactNode } from 'react'

import { ChevronRightIcon, GitBranchIcon, InfoIcon, SlidersIcon, TerminalIcon } from '../Icons.tsx'
import { WorkspaceFolderIcon } from './FileTypeIcon.tsx'
import styles from './StartPage.module.css'

/**
 * The panel's new-tab page, after dsh's 开始: one row per thing a tab can
 * hold, under the workspace they all work in. The panel swaps this tab for
 * whatever gets picked, the way a browser's new-tab page navigates in place.
 * Files, terminals and 源代码管理 work in the project alone; 详情 and 配置
 * wait for a session.
 */
export function StartPage({
  cwd,
  hasSession,
  onOpenFiles,
  onNewTerminal,
  onOpenInfo,
  onOpenScm,
  onOpenConfig,
}: {
  cwd: string
  hasSession: boolean
  onOpenFiles: () => void
  onNewTerminal: () => void
  onOpenInfo: () => void
  onOpenScm: () => void
  onOpenConfig: () => void
}): JSX.Element {
  return (
    <div className={styles.root}>
      {/* Auto margins rather than justify-content: a short panel then scrolls
          from the top instead of clipping the first row. */}
      <div className={styles.inner}>
        <div className={styles.head}>
          <div className={styles.title}>{cwd.split('/').filter(Boolean).at(-1) ?? cwd}</div>
          <div className={styles.path}>{cwd.replace(/^\/root(?=\/|$)/, '~')}</div>
        </div>
        <div className={styles.list}>
          <Row
            icon={<WorkspaceFolderIcon size={18} />}
            title="工作区文件"
            subtitle="浏览项目工作区的文件"
            shortcut="Ctrl P"
            onClick={onOpenFiles}
          />
          <Row
            icon={<TerminalIcon size={16} />}
            title="新建终端"
            subtitle="在项目工作区运行命令"
            shortcut="Ctrl `"
            onClick={onNewTerminal}
          />
          <Row
            icon={<GitBranchIcon size={16} />}
            title="源代码管理"
            subtitle="暂存与提交、历史、分支、推送拉取"
            onClick={onOpenScm}
          />
          <Row
            icon={<InfoIcon size={16} />}
            title="会话详情"
            subtitle={hasSession ? '运行时、源代码管理、MCP 与上下文' : '选择会话后可用'}
            disabled={!hasSession}
            onClick={onOpenInfo}
          />
          <Row
            icon={<SlidersIcon size={16} />}
            title="配置"
            subtitle={hasSession ? 'Claude Code 的 /config 设置' : '选择会话后可用'}
            disabled={!hasSession}
            onClick={onOpenConfig}
          />
        </div>
      </div>
    </div>
  )
}

function Row(props: {
  icon: ReactNode
  title: string
  subtitle: string
  shortcut?: string
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button className={styles.row} onClick={props.onClick} disabled={props.disabled} type="button">
      <span className={styles.icon}>{props.icon}</span>
      <span className={styles.text}>
        <span className={styles.rowTitle}>{props.title}</span>
        <span className={styles.subtitle}>{props.subtitle}</span>
      </span>
      {props.shortcut && <span className={styles.shortcut}>{props.shortcut}</span>}
      <span className={props.shortcut ? `${styles.chevron} ${styles.touchOnly}` : styles.chevron}>
        <ChevronRightIcon size={14} />
      </span>
    </button>
  )
}
