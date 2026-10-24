import { createHash } from 'node:crypto'

import { resolveSettings, type ModelInfo, type Query, type Settings } from '@anthropic-ai/claude-agent-sdk'

type ModelQuery = Pick<Query, 'applyFlagSettings' | 'getContextUsage' | 'reinitialize' | 'setModel' | 'supportedModels'> & {
  /** Present at runtime on 2.1.29x CLIs, not in every SDK's typings. */
  getSettings?: () => Promise<unknown>
}
type ReadSettings = () => Promise<Settings>
type ModelSnapshot = { models: ModelInfo[]; model: string }
type Options = {
  readSettings?: ReadSettings
  canRefresh?: () => boolean
  onChange?: (snapshot: ModelSnapshot) => void
}

const MODEL_ENV = /^ANTHROPIC_(?:MODEL|SMALL_FAST_MODEL|DEFAULT_\w+_MODEL(?:_NAME|_DESCRIPTION)?)$/
const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  ...['OPUS', 'SONNET', 'HAIKU', 'FABLE'].flatMap((role) =>
    ['', '_NAME', '_DESCRIPTION'].map((suffix) => `ANTHROPIC_DEFAULT_${role}_MODEL${suffix}`),
  ),
]
const CHANNEL_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS']
const normalize = (model: string): string => model.replace(/\[1m\]$/i, '[1m]')
const ROLES = ['opus', 'sonnet', 'haiku', 'fable'] as const
const ONE_M = /\[1m\]$/i

/**
 * Re-label the role rows from the mappings now in effect.
 *
 * Older CLIs build the menu once from their startup environment: after
 * applyFlagSettings, requests already resolve `haiku` through the new channel,
 * but even a fresh reinitialize() still lists the old channel's ids and names.
 * Verified on 2.1.238 (the copy bundled with SDK 0.3.238, used when `claude`
 * is not on PATH); 2.1.293 refreshes the menu itself, where this is a no-op.
 * The labels mirror the CLI's own: `_NAME` or the id without its 1M suffix,
 * `_DESCRIPTION` or "Custom …".
 * A role whose mapping was removed keeps the CLI's row, the best data there is.
 */
export function applyRoleMappings(models: ModelInfo[], env: Record<string, string | undefined>): ModelInfo[] {
  return models.map((row) => {
    const role = ROLES.find((name) => name === row.value)
    if (!role) return row
    const key = `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`
    const id = env[key]
    if (!id) return row
    const title = role[0]!.toUpperCase() + role.slice(1)
    const displayName = env[`${key}_NAME`] || id.replace(ONE_M, '')
    const description = env[`${key}_DESCRIPTION`] || `Custom ${title} model${ONE_M.test(id) ? ' (1M context)' : ''}`
    if (row.resolvedModel === id && row.displayName === displayName && row.description === description) return row
    return { ...row, resolvedModel: id, displayName, description }
  })
}

/** Refresh a session's provider and model mappings together, using the CLI's menu. */
export class SessionModels {
  readonly #query: ModelQuery
  readonly #readSettings: ReadSettings
  readonly #canRefresh: () => boolean
  readonly #onChange: (snapshot: ModelSnapshot) => void
  #selected: string | undefined
  #signature: string | undefined
  #models: ModelInfo[] | undefined
  #menuDirty = false
  readonly #envKeys = new Set([...MODEL_ENV_KEYS, ...CHANNEL_ENV_KEYS])
  #queue: Promise<unknown> = Promise.resolve()

  constructor(query: ModelQuery, cwd: string, selected?: string, options: Options = {}) {
    this.#query = query
    this.#selected = selected
    this.#readSettings = options.readSettings ?? (async () => (await resolveSettings({ cwd })).effective)
    this.#canRefresh = options.canRefresh ?? (() => true)
    this.#onChange = options.onChange ?? (() => {})
  }

  list(): Promise<ModelSnapshot> {
    return this.#run(() => this.#refresh())
  }

  /** Serialize configuration refresh and enqueueing so a send cannot race a menu read. */
  withCurrentSettings<T>(operation: () => T): Promise<T> {
    return this.#run(async () => {
      await this.#refresh()
      return operation()
    })
  }

  select(model = 'default'): Promise<void> {
    return this.#run(async () => {
      // A configuration edit between opening the menu and clicking a row must
      // also reach the CLI that will resolve the selected alias.
      await this.#refresh()
      await this.#query.setModel(model)
      this.#selected = model
      this.#menuDirty = true
      await this.#refresh()
    })
  }

  /**
   * Take over a model the CLI switched to on its own — a typed `/model` —
   * so the browser shows it and the next configuration refresh, which
   * re-applies the selection, does not switch it back.
   */
  follow(): Promise<void> {
    return this.#run(async () => {
      this.#models ??= await this.#query.supportedModels()
      const current = await this.#currentModel()
      const selected = this.#selected
      const row = this.#models.find((entry) => entry.value === selected)
      // Either form counts: a full id is its own resolution, a role is not.
      if (selected !== undefined && [selected, row?.resolvedModel].some((id) => id && normalize(id) === normalize(current))) return
      this.#selected = this.#recover(current)
      this.#onChange({ models: this.#models, model: this.#selected })
    })
  }

  /**
   * Recover a role from the original CLI menu, before replacing channel A's
   * mappings with B's. An explicitly selected full model id is kept as-is.
   * Ambiguous mappings are also kept explicit instead of guessing a role.
   */
  #recover(current: string): string {
    const roles = this.#models!.filter((row) => /^(opus|sonnet|haiku|fable)$/.test(row.value)
      && row.resolvedModel && normalize(row.resolvedModel) === normalize(current))
    return roles.length === 1 ? roles[0]!.value : current
  }

  async #refresh(): Promise<ModelSnapshot> {
    this.#models ??= await this.#query.supportedModels()
    if (this.#selected === undefined) this.#selected = this.#recover(await this.#currentModel())
    const snapshot = (): ModelSnapshot => ({ models: this.#models!, model: this.#selected! })
    // Reinitializing during a pending tool callback can cancel that callback.
    // Keep an in-flight turn on its provider; idle/focus refresh or the next
    // send applies any configuration edits once the turn finishes.
    if (!this.#canRefresh()) return snapshot()
    const settings = await this.#readSettings()
    if (!this.#canRefresh()) return snapshot()
    for (const key of [...Object.keys(settings.env ?? {}), ...Object.keys(process.env)]) {
      if (MODEL_ENV.test(key)) this.#envKeys.add(key)
    }
    // Empty values clear mappings removed from disk: the running CLI still
    // has its original environment cached. Clear the old authentication field
    // too when a provider changes from a bearer token to an API key or back.
    const env = Object.fromEntries([...this.#envKeys].sort().map((key) => [
      key, settings.env?.[key] ?? process.env[key] ?? '',
    ]))
    const flags = { env, model: this.#selected }
    // Credentials stay inside the server-to-CLI control request. Only a hash
    // is retained for change detection; browser snapshots contain model data.
    // modelPicker stays out of the flags, where it would hide the user's own
    // file, but counts here: the CLI re-reads settings files on
    // applyFlagSettings (verified on 2.1.310), never on reinitialize() alone.
    const signature = createHash('sha256')
      .update(JSON.stringify({ ...flags, modelPicker: settings.modelPicker }))
      .digest('hex')
    if (signature !== this.#signature) {
      await this.#query.applyFlagSettings(flags)
      this.#signature = signature
      this.#menuDirty = true
    }
    if (this.#menuDirty && this.#canRefresh()) {
      // supportedModels() always returns the first initialize response. A
      // fresh one carries the new menu; older CLIs leave the role rows on the
      // startup channel, so they are relabelled from `env` either way.
      this.#models = applyRoleMappings((await this.#query.reinitialize()).models, env)
      this.#menuDirty = false
      this.#onChange(snapshot())
    }
    return snapshot()
  }

  /**
   * The model the next request will use. get_settings answers from memory in
   * ~10 ms; get_context_usage tokenizes the whole transcript (0.4-2.4 s on an
   * empty session, more on a long resumed one), so it is only the fallback for
   * CLIs without get_settings.
   */
  async #currentModel(): Promise<string> {
    const getSettings = (this.#query as { getSettings?: () => Promise<unknown> }).getSettings
    if (typeof getSettings === 'function') {
      try {
        const settings = (await getSettings.call(this.#query)) as { applied?: { model?: unknown } }
        if (typeof settings.applied?.model === 'string' && settings.applied.model) return settings.applied.model
      } catch {
        // Older CLI: fall through.
      }
    }
    return (await this.#query.getContextUsage()).model
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation)
    this.#queue = result.catch(() => {})
    return result
  }
}
