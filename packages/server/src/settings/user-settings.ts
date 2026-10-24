import { createHash } from 'node:crypto'
import { chmod, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveSettings } from '@anthropic-ai/claude-agent-sdk'
import type { SettingsOverride, UserSettings } from '@ccw/shared'

import { claudeConfigDir } from '../history/sessions.ts'

/** The env names the dialog's form edits; overrides of any other are not reported. */
const FORM_ENV = /^(?:ANTHROPIC_(?:BASE_URL|AUTH_TOKEN|API_KEY|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+_MODEL)|CLAUDE_CODE_SUBAGENT_MODEL)$/

export async function readUserSettings(cwd?: string): Promise<UserSettings> {
  const path = join(claudeConfigDir(), 'settings.json')
  const raw = (await readIfExists(path)) ?? ''
  return { path, settings: parse(raw, path), revision: hash(raw), overrides: await findOverrides(cwd) }
}

/**
 * Replaces the file with `settings`, unless something else wrote it after
 * `revision` was read: the CLI's `/model` and CC Switch edit the same file,
 * and saving over them would silently drop their change.
 */
export async function writeUserSettings(settings: unknown, revision: string, cwd?: string): Promise<UserSettings> {
  validate(settings)
  const path = join(claudeConfigDir(), 'settings.json')
  // Written through a symlink (a dotfiles checkout), not replaced by a plain file.
  const target = await realpath(path).catch(() => path)
  const current = await readIfExists(target)
  if (hash(current ?? '') !== revision) {
    throw new Error('settings.json 在打开设置之后被其他程序改过（例如 CLI 的 /model 或 CC Switch），请重新载入后再保存')
  }
  // The file holds API keys: keep its permissions, and make a new one private.
  const mode = current === null ? 0o600 : (await stat(target)).mode & 0o777
  if (current !== null) await writePrivate(`${target}.bak`, current, mode)
  // Rename is atomic, so a CLI starting mid-save reads the old file or the new one, never half of it.
  const temp = `${target}.${process.pid}.tmp`
  await writePrivate(temp, `${JSON.stringify(settings, null, 2)}\n`, mode)
  await rename(temp, target)
  return readUserSettings(cwd)
}

async function writePrivate(path: string, content: string, mode: number): Promise<void> {
  await writeFile(path, content, { mode })
  // `mode` only applies when writeFile creates the file.
  await chmod(path, mode)
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parse(raw: string, path: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${path} 不是合法的 JSON，请先在终端里修好：${(error as Error).message}`)
  }
  if (!isObject(value)) throw new Error(`${path} 的顶层不是 JSON 对象`)
  return value
}

/**
 * A malformed settings.json breaks every CLI session on the machine, the
 * terminal's included, so the fields the CLI is strict about are checked here.
 */
function validate(settings: unknown): asserts settings is Record<string, unknown> {
  if (!isObject(settings)) throw new Error('设置必须是一个 JSON 对象')
  const { env, model, modelPicker } = settings
  if (env !== undefined) {
    if (!isObject(env)) throw new Error('env 必须是对象')
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') throw new Error(`env.${key} 的值必须是字符串`)
    }
  }
  if (model !== undefined && typeof model !== 'string') throw new Error('model 必须是字符串')
  if (modelPicker !== undefined) {
    const options = isObject(modelPicker) ? modelPicker['options'] : undefined
    if (!Array.isArray(options)) throw new Error('modelPicker.options 必须是数组')
    options.forEach((option: unknown, index) => {
      if (!isObject(option) || typeof option['model'] !== 'string' || !option['model'].trim()) {
        throw new Error(`modelPicker.options 第 ${index + 1} 项缺少模型 ID`)
      }
    })
  }
}

/**
 * Sources above the user file that set a field the form edits, so the dialog
 * can say why a saved value has no effect. Without a cwd only the user and
 * policy tiers are read: the server's own directory is no project of the user's.
 */
async function findOverrides(cwd?: string): Promise<SettingsOverride[]> {
  const { sources } = await resolveSettings(cwd ? { cwd } : { settingSources: ['user'] })
  const above = sources.slice(sources.findIndex((entry) => entry.source === 'user') + 1)
  return above.flatMap(({ source, settings, path }) => {
    if (source === 'user') return []
    const keys = [
      ...(settings.model !== undefined ? ['model'] : []),
      // modelPicker is not honoured from a project checkout.
      ...(settings.modelPicker !== undefined && (source === 'flag' || source === 'managed') ? ['modelPicker'] : []),
      ...Object.keys(settings.env ?? {}).filter((name) => FORM_ENV.test(name)).map((name) => `env.${name}`),
    ]
    return keys.map((key) => ({ key, source, ...(path ? { path } : {}) }))
  })
}
