import type { ChatNode } from '../render/nodes.ts'

/** Input fields that name what a tool call acted on, most telling first. */
const TOOL_DETAIL_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'skill', 'description']

/** `/copy`: the newest assistant text, without its thinking. */
export function lastReplyText(nodes: ChatNode[]): string | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind !== 'assistant') continue
    const text = replyText(node)
    if (text) return text
  }
  return null
}

/**
 * `/export`: prompts and replies in full, one line per tool call, `!` output
 * fenced. Thinking, cost rows and UI notices are left out — this is the
 * conversation, not the session log.
 */
export function transcriptMarkdown(nodes: ChatNode[], title: string): string {
  const parts = [`# ${title}`]
  // A turn's text, tool calls and more text read as one Claude section.
  let speaker: 'user' | 'claude' | null = null
  const say = (who: 'user' | 'claude', body: string): void => {
    if (speaker !== who) parts.push(who === 'user' ? '## 用户' : '## Claude')
    speaker = who
    parts.push(body)
  }

  for (const node of nodes) {
    switch (node.kind) {
      case 'user':
        // Each prompt opens its own section, even two in a row.
        speaker = null
        say('user', node.attachments ? `${node.text}\n\n_（${node.attachments} 个附件）_` : node.text)
        break
      case 'assistant': {
        const text = replyText(node)
        if (text) say('claude', text)
        break
      }
      case 'tool': {
        const detail = TOOL_DETAIL_KEYS.map((key) => node.input[key]).find((value) => typeof value === 'string')
        say('claude', `> 🔧 ${node.name}${detail ? ` · \`${oneLine(detail as string)}\`` : ''}`)
        break
      }
      case 'localOutput':
        parts.push(fence(node.content))
        break
      case 'compact':
        parts.push('> （上下文已压缩）')
        break
    }
  }
  return `${parts.join('\n\n')}\n`
}

function replyText(node: Extract<ChatNode, { kind: 'assistant' }>): string {
  return node.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim()
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

/** A code fence longer than any backtick run inside, so the content cannot close it. */
function fence(content: string): string {
  const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(longest + 1)
  return `${marks}\n${content}\n${marks}`
}
