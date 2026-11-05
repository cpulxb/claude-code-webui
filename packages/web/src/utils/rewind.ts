import type { RewindFilesResult } from '@ccw/shared'

import { editStats } from '../render/condense.ts'
import type { ChatNode } from '../render/nodes.ts'

/** What one prompt's turn changed through the file tools. */
export type TurnEdits = { files: string[]; added: number; removed: number }

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Each prompt's file changes, by prompt id — the line the terminal's rewind
 * list draws under a prompt. Only prompts read in are there, so a missing one
 * means "not known", not "nothing". Bash goes uncounted: the checkpoints a
 * rewind restores do not hold what it changed either.
 */
export function turnEdits(nodes: ChatNode[]): Map<string, TurnEdits> {
  const turns = new Map<string, TurnEdits>()
  let turn: TurnEdits | undefined
  for (const node of nodes) {
    if (node.kind === 'user') {
      turn = { files: [], added: 0, removed: 0 }
      turns.set(node.id, turn)
      continue
    }
    if (!turn || node.kind !== 'tool' || node.status === 'error' || !FILE_TOOLS.has(node.name)) continue
    const path = node.input['file_path'] ?? node.input['notebook_path']
    if (typeof path !== 'string') continue
    if (!turn.files.includes(path)) turn.files.push(path)
    const stats = node.name === 'MultiEdit' ? multiEditStats(node.input) : editStats(node)
    turn.added += stats?.added ?? 0
    turn.removed += stats?.removed ?? 0
  }
  return turns
}

function multiEditStats(input: Record<string, unknown>): { added: number; removed: number } {
  const lines = (text: unknown): number => (typeof text === 'string' && text ? text.replace(/\n$/, '').split('\n').length : 0)
  const edits = Array.isArray(input['edits']) ? (input['edits'] as Record<string, unknown>[]) : []
  let added = 0
  let removed = 0
  for (const edit of edits) {
    added += lines(edit['new_string'])
    removed += lines(edit['old_string'])
  }
  return { added, removed }
}

/** A turn's line in the list: `app.py +4`, or null when it is not read in. */
export function describeTurn(edits: TurnEdits | undefined, cwd?: string): string | null {
  if (!edits) return null
  if (edits.files.length === 0) return '没有改动代码'
  return `${fileNames(edits.files, cwd)} ${lineCounts(edits.added, edits.removed)}`.trim()
}

/** What a file rewind would restore, from its dry run. */
export function describeRestore(preview: RewindFilesResult, cwd?: string): string {
  const files = preview.filesChanged ?? []
  if (files.length === 0) return '没有需要恢复的代码改动'
  return `代码会恢复：${fileNames(files, cwd)} ${lineCounts(preview.insertions ?? 0, preview.deletions ?? 0)}`.trim()
}

/** Whether a dry run found anything a file rewind would change. */
export function restoresFiles(preview: RewindFilesResult | null): boolean {
  return preview?.canRewind === true && (preview.filesChanged?.length ?? 0) > 0
}

function fileNames(paths: string[], cwd?: string): string {
  const first = relativeTo(paths[0]!, cwd)
  return paths.length === 1 ? first : `${first} 等 ${paths.length} 个文件`
}

function lineCounts(added: number, removed: number): string {
  return [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(Boolean).join(' ')
}

function relativeTo(path: string, cwd?: string): string {
  if (!cwd) return path
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}
