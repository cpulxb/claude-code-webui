import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

import type { PluginAction, PluginInfo, SkillInfo, SkillState } from '@ccw/shared'

import { resolveClaudeExecutable } from '../config.ts'

/*
 * No SDK control request writes skill states or plugin settings, so edits go
 * through the CLI's own subcommands, as the VS Code extension's do: which
 * file each one lands in, and how the scopes stack, stays the CLI's business.
 */

/** Long enough for an update that fetches a marketplace. */
const TIMEOUT_MS = 120_000

const PLUGIN_ACTIONS: readonly PluginAction[] = ['enable', 'disable', 'update', 'uninstall']
const PLUGIN_SCOPES = ['user', 'project', 'local', 'managed']

/** The binary the sessions run: PATH's `claude`, else the copy the SDK ships. */
function claudeBinary(): string {
  const found = resolveClaudeExecutable()
  if (found) return found
  const fromSdk = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const file = process.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const pkg of [base, `${base}-musl`]) {
    try {
      return fromSdk.resolve(`${pkg}/${file}`)
    } catch {
      // Not installed for this platform; try the next.
    }
  }
  throw new Error('找不到 claude 可执行文件')
}

type CliResult = { message?: string; updateOutcome?: string; oldVersion?: string; newVersion?: string }

/** A `--json` subcommand's result: its last stdout line. */
function parseResult(stdout: string): CliResult | undefined {
  try {
    const value: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
    return typeof value === 'object' && value !== null ? (value as CliResult) : undefined
  } catch {
    return undefined
  }
}

/**
 * Runs in `cwd`, where the CLI reads project and local scopes from. A refusal
 * rejects with the CLI's own words: the result line's message, else stderr.
 */
export function runClaude(args: string[], cwd: string, input = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(claudeBinary(), args, { cwd, timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      reject(new Error(parseResult(stdout)?.message || stderr.trim() || error.message))
    })
    // A child that exits without reading stdin closes the pipe under the
    // write; unhandled, that EPIPE would take the whole server down. The exit
    // status above is what reports the outcome.
    child.stdin?.on('error', () => {})
    // Closed even when empty: a subcommand that wants a confirmation must see
    // no terminal and refuse, not wait for one.
    child.stdin?.end(input)
  })
}

export async function listPlugins(cwd: string): Promise<PluginInfo[]> {
  return JSON.parse(await runClaude(['plugin', 'list', '--json'], cwd)) as PluginInfo[]
}

/** Returns what an update did; the other actions show in the list. */
export async function runPluginAction(
  cwd: string,
  id: string,
  scope: string,
  action: PluginAction,
): Promise<string | undefined> {
  // These land in argv: an id like `--all` would turn `disable` into "disable everything".
  if (!PLUGIN_ACTIONS.includes(action)) throw new Error(`未知的插件操作：${String(action)}`)
  if (!PLUGIN_SCOPES.includes(scope)) throw new Error(`未知的插件范围：${String(scope)}`)
  if (typeof id !== 'string' || !/^[^\s-]\S*$/.test(id)) throw new Error(`插件 ID 不合法：${String(id)}`)

  const result = parseResult(await runClaude(['plugin', action, id, '--scope', scope, '--json'], cwd))
  if (action !== 'update' || !result) return undefined
  return result.updateOutcome === 'up_to_date'
    ? `${id} 已是最新版本（${result.newVersion}）`
    : `${id} 已从 ${result.oldVersion} 更新到 ${result.newVersion}`
}

/**
 * Saves to the project's `.claude/settings.local.json`, as the terminal's
 * `/skills` does. The CLI refuses when this server itself runs inside a
 * Claude Code session (`CLAUDE_CODE_CHILD_SESSION`), so a model cannot use it
 * to change its own settings.
 */
export async function editSkillState(
  cwd: string,
  edit: { name: string; state: SkillState; handles?: SkillInfo['handles'] },
): Promise<void> {
  await runClaude(['edit-skill-overrides', '--json'], cwd, JSON.stringify(edit))
}
