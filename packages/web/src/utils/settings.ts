/**
 * The settings dialog's form, and how it maps onto `~/.claude/settings.json`.
 * Everything the form does not edit is carried over untouched.
 */

type Json = Record<string, unknown>

export type AuthField = 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY'

/** One `modelPicker.options` row; the 1M marker is kept apart from the id while editing. */
export type PickerRow = { model: string; oneM: boolean; label: string; description: string; behavesAs: string }

export type SettingsForm = {
  baseUrl: string
  authField: AuthField
  key: string
  models: PickerRow[]
  /** Full id, `[1m]` included, of the model new sessions start on; '' leaves it to the CLI. */
  defaultModel: string
  replaceBuiltIn: boolean
  /** Env name → model id, for the roles the CLI still calls by alias. */
  roles: Record<string, string>
}

export const ROLE_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const
/** Superseded by the Haiku mapping, so only shown where a file still sets it. */
const LEGACY_ROLE = 'ANTHROPIC_SMALL_FAST_MODEL'

/** Stands in for a credential in the JSON view; left as is, the saved value is kept. */
export const SECRET_MASK = '********'
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CUSTOM_HEADERS/i

const ONE_M = /\[1m\]$/i

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function fullModelId(row: Pick<PickerRow, 'model' | 'oneM'>): string {
  const id = row.model.trim()
  return id && row.oneM ? `${id}[1m]` : id
}

const normalize = (id: string): string => id.trim().replace(ONE_M, '[1m]')
/** Aliases name a role, not a model, so they make no picker row of their own. */
const ALIAS = /^(?:default|opus|sonnet|haiku|fable|opusplan)(?:\[1m\])?$/i

/** What stops a save, in the order the form shows the fields. */
export function formProblems(form: SettingsForm): string[] {
  const problems: string[] = []
  const url = form.baseUrl.trim()
  if (url && !/^https?:\/\/\S+$/i.test(url)) problems.push('请求地址要以 http:// 或 https:// 开头')
  if (form.models.some((row) => !row.model.trim() && (row.label.trim() || row.description.trim() || row.behavesAs.trim()))) {
    problems.push('有模型没填模型 ID')
  }
  const ids = form.models.map(fullModelId).filter(Boolean)
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index)
  if (repeated) problems.push(`模型 ID 重复：${repeated}`)
  return problems
}

/**
 * Picker rows the menu will not show: the CLI lists a model a role already
 * resolves to as that role's row, unless the built-in rows are replaced.
 */
export function shadowedModels(form: SettingsForm): string[] {
  if (form.replaceBuiltIn) return []
  const roles = new Set(ROLE_KEYS.filter((key) => key.startsWith('ANTHROPIC_DEFAULT_')).map((key) => normalize(form.roles[key] ?? '')))
  return form.models.map(fullModelId).filter((id) => id && roles.has(normalize(id)))
}

/** The distinct models the default and the roles point at, as rows — a start for a file that only maps roles. */
export function rowsFromRoles(form: SettingsForm): PickerRow[] {
  const ids = [...new Set([form.defaultModel, ...Object.values(form.roles)].map(normalize))].filter((id) => id && !ALIAS.test(id))
  return ids.map((id) => ({ model: id.replace(ONE_M, ''), oneM: ONE_M.test(id), label: '', description: '', behavesAs: '' }))
}

/** The role env names a file's form shows, in display order. */
export function roleKeys(settings: Json): string[] {
  const env = isObject(settings['env']) ? settings['env'] : {}
  return LEGACY_ROLE in env ? [...ROLE_KEYS, LEGACY_ROLE] : [...ROLE_KEYS]
}

export function toForm(settings: Json): SettingsForm {
  const env = isObject(settings['env']) ? settings['env'] : {}
  const picker = isObject(settings['modelPicker']) ? settings['modelPicker'] : {}
  const options = Array.isArray(picker['options']) ? picker['options'].filter(isObject) : []
  const authField: AuthField = 'ANTHROPIC_AUTH_TOKEN' in env || !('ANTHROPIC_API_KEY' in env) ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'
  return {
    baseUrl: text(env['ANTHROPIC_BASE_URL']),
    authField,
    key: text(env[authField]),
    models: options.map((option) => ({
      model: text(option['model']).replace(ONE_M, ''),
      oneM: ONE_M.test(text(option['model'])),
      label: text(option['label']),
      description: text(option['description']),
      behavesAs: text(option['behavesAs']),
    })),
    // ANTHROPIC_MODEL outranks `model`, so it is the one in effect.
    defaultModel: text(env['ANTHROPIC_MODEL']) || text(settings['model']),
    replaceBuiltIn: picker['replaceBuiltInOptions'] === true,
    roles: Object.fromEntries(roleKeys(settings).map((key) => [key, text(env[key])])),
  }
}

/** `settings` with the form written over it; the input is not modified. */
export function applyForm(settings: Json, form: SettingsForm): Json {
  const next = structuredClone(settings)
  const env: Record<string, string> = isObject(next['env']) ? (next['env'] as Record<string, string>) : {}
  const put = (key: string, value: string): void => {
    if (value.trim()) env[key] = value.trim()
    else delete env[key]
  }

  put('ANTHROPIC_BASE_URL', form.baseUrl.trim().replace(/\/+$/, ''))
  put(form.authField, form.key)
  delete env[form.authField === 'ANTHROPIC_AUTH_TOKEN' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN']

  if (form.defaultModel) next['model'] = form.defaultModel
  else delete next['model']
  if ('ANTHROPIC_MODEL' in env) put('ANTHROPIC_MODEL', form.defaultModel)

  for (const [key, value] of Object.entries(form.roles)) {
    // A role's name and description describe the model it had; the CLI
    // labels the new one from its id instead.
    if (key.startsWith('ANTHROPIC_DEFAULT_') && (env[key] ?? '') !== value.trim()) {
      delete env[`${key}_NAME`]
      delete env[`${key}_DESCRIPTION`]
    }
    put(key, value)
  }

  if (Object.keys(env).length > 0 || isObject(settings['env'])) next['env'] = env

  const options = form.models.filter((row) => row.model.trim()).map((row) => ({
    model: fullModelId(row),
    ...(row.label.trim() ? { label: row.label.trim() } : {}),
    ...(row.description.trim() ? { description: row.description.trim() } : {}),
    ...(row.behavesAs.trim() ? { behavesAs: row.behavesAs.trim() } : {}),
  }))
  if (options.length === 0) {
    delete next['modelPicker']
  } else {
    const picker: Json = { ...(isObject(next['modelPicker']) ? next['modelPicker'] : {}), options }
    if (form.replaceBuiltIn) picker['replaceBuiltInOptions'] = true
    else delete picker['replaceBuiltInOptions']
    next['modelPicker'] = picker
  }
  return next
}

/** For the JSON view: credentials replaced by {@link SECRET_MASK}. */
export function maskSecrets(settings: Json): Json {
  if (!isObject(settings['env'])) return settings
  const env = Object.fromEntries(Object.entries(settings['env']).map(([key, value]) => [
    key, SECRET_ENV.test(key) && typeof value === 'string' && value ? SECRET_MASK : value,
  ]))
  return { ...settings, env }
}

/** Puts back the credentials a JSON edit left masked, from the settings it was masked from. */
export function unmaskSecrets(edited: Json, original: Json): Json {
  if (!isObject(edited['env']) || !isObject(original['env'])) return edited
  const saved = original['env']
  const env = Object.fromEntries(Object.entries(edited['env']).map(([key, value]) => [
    key, value === SECRET_MASK && typeof saved[key] === 'string' ? saved[key] : value,
  ]))
  return { ...edited, env }
}
