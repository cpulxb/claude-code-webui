import { createHash } from 'node:crypto'

import { resolveSettings, type ModelInfo, type Query, type Settings } from '@anthropic-ai/claude-agent-sdk'

type ModelQuery = Pick<Query, 'applyFlagSettings' | 'getContextUsage' | 'reinitialize' | 'setModel' | 'supportedModels'>
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

  async #refresh(): Promise<ModelSnapshot> {
    this.#models ??= await this.#query.supportedModels()
    if (this.#selected === undefined) {
      const current = (await this.#query.getContextUsage()).model
      // Recover a role from the original CLI menu, before replacing channel A's
      // mappings with B's. An explicitly selected full model id is kept as-is.
      // Ambiguous mappings are also kept explicit instead of guessing a role.
      const roles = this.#models.filter((row) => /^(opus|sonnet|haiku|fable)$/.test(row.value)
        && row.resolvedModel && normalize(row.resolvedModel) === normalize(current))
      this.#selected = roles.length === 1 ? roles[0]!.value : current
    }
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
    const signature = createHash('sha256').update(JSON.stringify(flags)).digest('hex')
    if (signature !== this.#signature) {
      await this.#query.applyFlagSettings(flags)
      this.#signature = signature
      this.#menuDirty = true
    }
    if (this.#menuDirty && this.#canRefresh()) {
      // supportedModels() always returns the first initialize response, even
      // after applyFlagSettings. Only a fresh response contains the new menu.
      this.#models = (await this.#query.reinitialize()).models
      this.#menuDirty = false
      this.#onChange(snapshot())
    }
    return snapshot()
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation)
    this.#queue = result.catch(() => {})
    return result
  }
}
