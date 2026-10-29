import type { SlashCommand } from '@ccw/shared'

import { useStore } from '../store/session.ts'
import { lastReplyText, transcriptMarkdown } from './transcript-markdown.ts'

/**
 * Terminal commands the SDK leaves out of `supportedCommands()` — sent to the
 * CLI they only answer "isn't available in this environment" — rebuilt in the
 * browser. They join the CLI's own in the `/` palette; submitting one runs it
 * here instead of sending it.
 */
export const LOCAL_COMMANDS: SlashCommand[] = [
  { name: 'rename', description: '重命名当前会话', argumentHint: '<名称>' },
  { name: 'branch', aliases: ['fork'], description: '从当前位置分叉出一个新会话', argumentHint: '[名称]' },
  { name: 'export', description: '把对话导出为 Markdown 文件', argumentHint: '[文件名]' },
  { name: 'copy', description: '复制 Claude 的最后一条回复', argumentHint: '' },
  { name: 'mcp', description: '查看并管理 MCP 服务器', argumentHint: '' },
  { name: 'skills', description: '查看 skills，设置各自的开关', argumentHint: '' },
  { name: 'plugins', aliases: ['plugin'], description: '查看并管理已安装的插件', argumentHint: '' },
  { name: 'status', description: '查看版本、账号与运行状态', argumentHint: '' },
]

/** Asks the details panel to bring up its 详情 tab; `detail` names the section to scroll to. */
export const SHOW_INFO_EVENT = 'ccw:show-info'

export type LocalCommand = { name: string; args: string }

/** The local command `text` invokes, by name or alias; null for anything else. */
export function parseLocalCommand(text: string): LocalCommand | null {
  const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const typed = match?.[1]
  if (!typed) return null
  const command = LOCAL_COMMANDS.find((entry) => entry.name === typed || entry.aliases?.includes(typed))
  return command ? { name: command.name, args: (match[2] ?? '').trim() } : null
}

/** `/export` names: the given one with `.md` ensured, else a timestamped default. */
export function exportFileName(requested: string, sessionId: string, now = new Date()): string {
  if (requested) return /\.md$/i.test(requested) ? requested : `${requested}.md`
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `claude-${stamp}-${sessionId.slice(0, 8)}.md`
}

export async function runLocalCommand(command: LocalCommand): Promise<void> {
  const store = useStore.getState()
  const session = store.activeId ? store.sessions[store.activeId] : undefined
  if (!session) return

  switch (command.name) {
    case 'rename':
      if (command.args) await store.renameSession(command.args)
      else store.addNotice('error', '用法：/rename <名称>')
      return

    case 'branch':
      await store.forkSession(command.args || undefined)
      return

    case 'export': {
      const nodes = session.transcript.nodes
      if (!nodes.some((node) => node.kind === 'user' || node.kind === 'assistant')) {
        store.addNotice('error', '还没有可导出的对话')
        return
      }
      const saved = store.projects.flatMap((project) => project.sessions).find((entry) => entry.sessionId === session.sessionId)
      const name = exportFileName(command.args, session.sessionId)
      download(name, transcriptMarkdown(nodes, saved?.summary || '新会话'))
      store.addNotice('info', `已导出 ${name}`)
      return
    }

    case 'copy': {
      const text = lastReplyText(session.transcript.nodes)
      if (!text) {
        store.addNotice('error', '还没有可复制的回复')
        return
      }
      try {
        await navigator.clipboard.writeText(text)
        store.addNotice('info', `已复制最后一条回复（${text.length} 字符）`)
      } catch (error) {
        store.addNotice('error', `复制失败：${String(error)}`)
      }
      return
    }

    case 'mcp':
    case 'skills':
    case 'plugins':
    case 'status':
      window.dispatchEvent(new CustomEvent(SHOW_INFO_EVENT, { detail: command.name }))
      return
  }
}

function download(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // Revoked late: the download reads the blob after `click` returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
