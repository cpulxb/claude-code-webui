import type { ReactNode } from 'react'

import { CompassIcon, GitBranchIcon, InfoIcon, SlidersIcon, TerminalIcon } from '../Icons.tsx'
import { WorkspaceFolderIcon } from './FileTypeIcon.tsx'
import styles from './StartPage.module.css'

/**
 * The panel's new-tab page, after dsh's 开始: one card per thing a tab can
 * hold. The panel swaps this tab for whatever gets picked, the way a browser's
 * new-tab page navigates in place.
 */
export function StartPage({
  onOpenFiles,
  onNewTerminal,
  onOpenInfo,
  onOpenScm,
  onOpenConfig,
}: {
  onOpenFiles: () => void
  onNewTerminal: () => void
  onOpenInfo: () => void
  onOpenScm: () => void
  onOpenConfig: () => void
}): JSX.Element {
  return (
    <div className={styles.root}>
      {/* Auto margins rather than justify-content: a short panel then scrolls
          from the top instead of clipping the first card. */}
      <div className={styles.inner}>
        <span className={styles.mark}>
          <CompassIcon size={52} strokeWidth={1.25} />
        </span>
        <div className={styles.cards}>
          <Card
            icon={<WorkspaceFolderIcon size={22} />}
            title="工作区文件"
            subtitle="浏览会话工作区的文件"
            shortcut="Ctrl + P"
            onClick={onOpenFiles}
          />
          <Card
            icon={
              <span className={styles.blueIcon}>
                <TerminalIcon size={20} />
              </span>
            }
            title="新建终端"
            subtitle="在会话工作区运行命令"
            shortcut="Ctrl + `"
            onClick={onNewTerminal}
          />
          <Card
            icon={
              <span className={styles.blueIcon}>
                <InfoIcon size={20} />
              </span>
            }
            title="会话详情"
            subtitle="运行时、源代码管理、MCP 与上下文"
            onClick={onOpenInfo}
          />
          <Card
            icon={
              <span className={styles.blueIcon}>
                <GitBranchIcon size={20} />
              </span>
            }
            title="源代码管理"
            subtitle="暂存与提交、历史、分支、推送拉取"
            onClick={onOpenScm}
          />
          <Card
            icon={
              <span className={styles.blueIcon}>
                <SlidersIcon size={20} />
              </span>
            }
            title="配置"
            subtitle="Claude Code 的 /config 设置"
            onClick={onOpenConfig}
          />
        </div>
      </div>
    </div>
  )
}

function Card(props: {
  icon: ReactNode
  title: string
  subtitle: string
  shortcut?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button className={styles.card} onClick={props.onClick} type="button">
      <span className={styles.cardIcon}>{props.icon}</span>
      <span className={styles.cardText}>
        <span className={styles.cardTitle}>{props.title}</span>
        <span className={styles.cardSubtitle}>{props.subtitle}</span>
      </span>
      {props.shortcut && <span className={styles.shortcut}>{props.shortcut}</span>}
    </button>
  )
}
