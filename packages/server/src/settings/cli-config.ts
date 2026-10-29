import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveSettings } from '@anthropic-ai/claude-agent-sdk'
import type { CliConfigOverride, CliConfigRow } from '@ccw/shared'

import { runClaude } from '../session/extensions.ts'

/*
 * The terminal's `/config` panel. No SDK control request reads or writes it,
 * and its rows save to three files — the user's settings.json, the project's
 * settings.local.json and ~/.claude.json — some with side effects besides. So
 * the CLI does the writing: a one-off `claude -p "/config key=value"`, the
 * form it takes outside its panel. Asked with no pair, the same command lists
 * the keys it takes and their options. Only the values are read here, the way
 * the CLI reads them (as of 2.1.310).
 */

/** No transcript for what is no session, and none of the user's SessionStart hooks. */
const ONE_OFF = ['--no-session-persistence', '--settings', '{"disableAllHooks":true}']

type Value = CliConfigRow['value']
type Target = NonNullable<CliConfigRow['target']>
type Tier = 'user' | CliConfigOverride['source']

/** Low to high, as the CLI stacks them. */
const RANK: Record<Tier, number> = { user: 0, project: 1, local: 2, flag: 3, managed: 4 }

type Spec = {
  target: Target
  /** Dotted path in the settings files; for `global`, the key in ~/.claude.json. */
  path: string
  /** What the CLI shows while nothing sets it; null where that depends on the account or plan. */
  fallback: Value
  /** Moved from ~/.claude.json into settings.json: a value left in the old place still counts. */
  legacy?: true
  /** A key that, set to true, turns the row off whatever `path` holds. */
  offIf?: string
  /** How the CLI shows a stored value. */
  show?: (raw: unknown) => Value | undefined
}

const user = (path: string, fallback: Value, extra: Partial<Spec> = {}): Spec => ({ target: 'user', path, fallback, ...extra })
const moved = (path: string, fallback: Value, extra: Partial<Spec> = {}): Spec => user(path, fallback, { legacy: true, ...extra })
const local = (path: string, fallback: Value): Spec => ({ target: 'local', path, fallback })
const global = (path: string, fallback: Value): Spec => ({ target: 'global', path, fallback })

const SPECS: Record<string, Spec> = {
  // The moved keys' defaults are the CLI's DEFAULT_GLOBAL_CONFIG.
  autoCompact: moved('autoCompactEnabled', true),
  autoScroll: moved('autoScrollEnabled', true),
  checkpoints: moved('fileCheckpointingEnabled', true),
  editor: moved('editorMode', 'normal', { show: (raw) => (raw === 'emacs' ? 'normal' : scalar(raw)) }),
  notifChannel: moved('preferredNotifChannel', 'auto'),
  progressBar: moved('terminalProgressBarEnabled', true),
  theme: moved('theme', 'dark'),
  turnDuration: moved('showTurnDuration', true),
  verbose: moved('verbose', false),

  language: user('language', null),
  model: user('model', null),
  permissionMode: user('permissions.defaultMode', 'default'),
  // These three are saved only when off; the CLI drops the key to turn them on.
  promptSuggestionEnabled: user('promptSuggestionEnabled', true),
  recap: user('awaySummaryEnabled', true),
  thinking: user('alwaysThinkingEnabled', true),
  switchModelsOnFlag: user('switchModelsOnFlag', null, {
    show: (raw) => (typeof raw === 'boolean' ? (raw ? 'Switch automatically' : 'Ask each time') : undefined),
  }),
  timeFormat: user('timeFormat', 'auto'),
  useAutoModeDuringPlan: user('useAutoModeDuringPlan', true),
  workflowKeywordTriggerEnabled: user('workflowKeywordTriggerEnabled', true),
  // Saved only where it differs from the plan's default, which is not known here.
  workflows: user('enableWorkflows', null, { offIf: 'disableWorkflows' }),
  worktreeBaseRef: user('worktree.baseRef', 'fresh'),

  outputStyle: local('outputStyle', 'default'),
  reduceMotion: local('prefersReducedMotion', false),
  tips: local('spinnerTipsEnabled', true),

  autoConnectIde: global('autoConnectIde', false),
  copyFullResponse: global('copyFullResponse', false),
  copyOnSelect: global('copyOnSelect', true),
  defaultToAgentsView: global('defaultToAgentsView', false),
  externalEditorContext: global('externalEditorContext', false),
  gitignore: global('respectGitignore', true),
  leftArrowOpensAgents: global('leftArrowOpensAgents', true),
  prStatus: global('prStatusFooterEnabled', true),
  // Medium, or small on Pro.
  workflowSizeGuideline: global('workflowSizeGuideline', null),
}

type Layers = { tiers: { tier: Tier; settings: Record<string, unknown>; path?: string }[]; global: Record<string, unknown> }

export async function readCliConfig(cwd: string): Promise<CliConfigRow[]> {
  const [listing, layers] = await Promise.all([runClaude(['-p', '/config', ...ONE_OFF], cwd), readLayers(cwd)])
  return parseConfigKeys(listing).map((row) => {
    const spec = SPECS[row.key]
    return spec ? { ...row, ...readValue(spec, layers) } : { ...row, value: null }
  })
}

/** `/config`'s usage: a `  key=a|b|c` line per key, `true|false` for a switch and `<value>` for free text. */
export function parseConfigKeys(output: string): Pick<CliConfigRow, 'key' | 'kind' | 'options'>[] {
  if (!output.trimStart().startsWith('Usage: /config')) throw new Error(output.trim() || 'CLI 没有列出 /config 的设置项')
  return output.split('\n').flatMap((line): Pick<CliConfigRow, 'key' | 'kind' | 'options'>[] => {
    const match = /^\s+([^\s=]+)=(.+)$/.exec(line)
    if (!match) return []
    const [, key, options] = match
    if (options === 'true|false') return [{ key, kind: 'boolean', options: [] }]
    if (options === '<value>') return [{ key, kind: 'text', options: [] }]
    return [{ key, kind: 'choice', options: options.split('|') }]
  })
}

/** Writes wait their turn: two CLIs saving settings.json at once could each drop the other's key. */
let writing: Promise<unknown> = Promise.resolve()

export async function writeCliConfig(cwd: string, key: string, value: string): Promise<string> {
  // Both go into one argv string that the CLI splits on whitespace and `=`.
  if (typeof key !== 'string' || !/^[A-Za-z][\w.@:-]*$/.test(key)) throw new Error(`设置项名不合法：${String(key)}`)
  if (typeof value !== 'string' || !value.trim() || /[=\r\n]/.test(value)) throw new Error(`${key} 的值不合法：${String(value)}`)

  const run = writing.then(() => runClaude(['-p', `/config ${key}=${value.trim()}`, ...ONE_OFF], cwd))
  writing = run.catch(() => {})
  const output = (await run).trim()
  // A refusal is printed, not an exit status: "Couldn't save …", "… takes true or false".
  if (!/^Set .+ to /.test(output)) throw new Error(output || 'CLI 没有回应')
  return output
}

async function readLayers(cwd: string): Promise<Layers> {
  const { sources } = await resolveSettings({ cwd })
  const tiers = sources.flatMap(({ source, settings, path }) =>
    source in RANK ? [{ tier: source as Tier, settings: settings as Record<string, unknown>, ...(path ? { path } : {}) }] : [],
  )
  return { tiers, global: await readGlobalConfig() }
}

/** `~/.claude.json`, or the one in CLAUDE_CONFIG_DIR; `{}` while it is missing or torn mid-write. */
async function readGlobalConfig(): Promise<Record<string, unknown>> {
  const dir = process.env['CLAUDE_CONFIG_DIR']
  try {
    const parsed: unknown = JSON.parse(await readFile(dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json'), 'utf8'))
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readValue(spec: Spec, layers: Layers): Pick<CliConfigRow, 'value' | 'target' | 'overriddenBy'> {
  const { target } = spec
  if (target === 'global') return { value: shown(spec, layers.global[spec.path]) ?? spec.fallback, target }

  // The highest tier that sets it wins.
  const find = (path: string): Layers['tiers'][number] | undefined =>
    layers.tiers.findLast((entry) => at(entry.settings, path) !== undefined)
  const off = spec.offIf ? find(spec.offIf) : undefined
  const disabled = off !== undefined && at(off.settings, spec.offIf!) === true
  const found = disabled ? off : find(spec.path)
  const overriddenBy: CliConfigOverride | undefined =
    found && found.tier !== 'user' && RANK[found.tier] > RANK[target]
      ? { source: found.tier, ...(found.path ? { path: found.path } : {}) }
      : undefined

  let value: Value | undefined
  if (disabled) value = false
  else if (found) value = shown(spec, at(found.settings, spec.path))
  else if (spec.legacy) value = shown(spec, layers.global[spec.path])
  return { value: value ?? spec.fallback, target, ...(overriddenBy ? { overriddenBy } : {}) }
}

function shown(spec: Spec, raw: unknown): Value | undefined {
  return spec.show ? spec.show(raw) : scalar(raw)
}

function scalar(raw: unknown): Value | undefined {
  return typeof raw === 'boolean' || typeof raw === 'string' ? raw : undefined
}

function at(settings: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (isObject(value) ? value[key] : undefined), settings)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
