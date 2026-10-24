import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ModelInfo, Settings } from '@anthropic-ai/claude-agent-sdk'

import { applyRoleMappings, SessionModels } from '../src/session/models.ts'

// SessionModels falls back to process.env, so the developer's shell must not leak into these assertions.
for (const key of Object.keys(process.env)) if (key.startsWith('ANTHROPIC_')) delete process.env[key]

const cliModels: ModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-fable-5-1[1m]', displayName: 'Default (recommended)', description: 'Use the default model (currently Fable 5.1)' },
  { value: 'opus', resolvedModel: 'claude-fable-5-1[1M]', displayName: 'claude-fable-5-1', description: 'Custom Opus model (1M context)' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5[1M]', displayName: 'claude-sonnet-5-5', description: 'Custom Sonnet model (1M context)' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'claude-haiku-4-5', description: 'Custom Haiku model' },
  { value: 'claude-opus-5-5[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus 5.5 (1M context)', description: 'Newer version available · select Opus for Fable 5.1' },
]

function fixture(current = 'claude-opus-5-5[1m]', initialModels = cliModels, explicit?: string) {
  let settings: Settings = {
    model: 'opus',
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-fable-5-1[1M]',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'claude-fable-5-1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
      ANTHROPIC_AUTH_TOKEN: 'must-stay-private',
    },
  }
  let selected = current
  let idle = true
  const applied: Settings[] = []
  const selections: string[] = []
  let reads = 0
  let failNext = false
  const events: { models: ModelInfo[]; model: string }[] = []
  const query = {
    supportedModels: async () => initialModels,
    getContextUsage: async () => ({ model: selected }),
    applyFlagSettings: async (flags: Settings) => {
      applied.push(flags)
      selected = flags.model ?? 'default'
    },
    reinitialize: async () => {
      reads += 1
      if (failNext) {
        failNext = false
        throw new Error('refresh failed')
      }
      return { models: cliModels }
    },
    setModel: async (model: string) => {
      selections.push(model)
      selected = model
    },
  } as unknown as ConstructorParameters<typeof SessionModels>[0]
  const catalog = new SessionModels(query, '/fixture', explicit, {
    readSettings: async () => settings,
    canRefresh: () => idle,
    onChange: (snapshot) => events.push(snapshot),
  })
  return {
    catalog, applied, selections, events,
    selected: () => selected,
    reads: () => reads,
    configure: (next: Settings) => { settings = next },
    /** What a typed `/model` does: the CLI switches without asking SessionModels. */
    typeModel: (model: string) => { selected = model },
    failNext: () => { failNext = true },
    setIdle: (next: boolean) => { idle = next },
  }
}

test('refresh keeps the complete CLI menu and the explicit current model without selecting it again', async () => {
  const f = fixture()
  const result = await f.catalog.list()
  assert.deepEqual(result.models, cliModels)
  assert.equal(result.model, 'claude-opus-5-5[1m]')
  assert.equal(f.selected(), result.model)
  assert.deepEqual(f.selections, [])
  assert.equal(f.applied[0]?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-fable-5-1[1M]')
  assert.equal(f.applied[0]?.env?.ANTHROPIC_AUTH_TOKEN, 'must-stay-private')
  assert.equal(JSON.stringify(result).includes('must-stay-private'), false)
  assert.equal(JSON.stringify(f.events).includes('must-stay-private'), false)
  await f.catalog.list()
  assert.equal(f.reads(), 1)
})

test('configuration changes refresh the CLI and clear removed model mappings', async () => {
  const f = fixture()
  await f.catalog.list()
  f.configure({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'next-model' } })
  await f.catalog.list()
  assert.equal(f.reads(), 2)
  assert.equal(f.applied[1]?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'next-model')
  assert.equal(f.applied[1]?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, '')
  assert.equal(f.applied[1]?.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, '')
  assert.equal(f.selected(), 'claude-opus-5-5[1m]')
})

test('a selected role survives a later configuration refresh as that role', async () => {
  const f = fixture()
  await f.catalog.select('opus')
  f.configure({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'next-opus' } })
  const result = await f.catalog.list()
  assert.equal(result.model, 'opus')
  assert.equal(f.selected(), 'opus')
  assert.equal(f.applied.at(-1)?.model, 'opus')
  assert.deepEqual(f.selections, ['opus'])
})

test('a model switched by a typed /model is followed, and a later refresh does not switch it back', async () => {
  const f = fixture()
  await f.catalog.select('opus')
  f.typeModel('claude-haiku-4-5')
  await f.catalog.follow()
  assert.equal(f.events.at(-1)?.model, 'haiku')
  f.configure({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'next-opus' } })
  await f.catalog.list()
  assert.equal(f.applied.at(-1)?.model, 'haiku')
  assert.equal(f.selected(), 'haiku')
})

test('following a /model that changed nothing keeps the selection quiet', async () => {
  const f = fixture()
  await f.catalog.select('opus')
  const events = f.events.length
  // `/model` alone, or a name the CLI rejected.
  await f.catalog.follow()
  f.typeModel('claude-fable-5-1[1m]')
  await f.catalog.follow()
  assert.equal(f.events.length, events)
  assert.equal((await f.catalog.list()).model, 'opus')
})

test('a failed refresh is retried and does not block a subsequent selection', async () => {
  const f = fixture()
  f.failNext()
  await assert.rejects(f.catalog.list(), /refresh failed/)
  await f.catalog.select('haiku')
  assert.equal(f.selected(), 'haiku')
  assert.equal((await f.catalog.list()).model, 'haiku')
})

test('an inherited Haiku choice follows the new channel mapping instead of pinning its old model id', async () => {
  const oldModels = cliModels.map((row) => row.value === 'haiku' ? { ...row, resolvedModel: 'claude-haiku-5-5' } : row)
  const f = fixture('claude-haiku-5-5', oldModels)
  await f.catalog.list()
  assert.equal(f.applied[0]?.model, 'haiku')
  assert.equal(f.applied[0]?.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-4-5')
  assert.equal(f.events[0]?.model, 'haiku')
})

test('an explicitly selected full model id is preserved even when it matches a role', async () => {
  const f = fixture('claude-haiku-4-5', cliModels, 'claude-haiku-4-5')
  await f.catalog.list()
  assert.equal(f.applied[0]?.model, 'claude-haiku-4-5')
})

test('changing providers refreshes the endpoint and auth field together before enqueueing a message', async () => {
  const f = fixture()
  await f.catalog.list()
  f.configure({ env: { ANTHROPIC_BASE_URL: 'http://channel-b.test', ANTHROPIC_API_KEY: 'fixture-b-key' } })
  await f.catalog.withCurrentSettings(() => {
    const env = f.applied.at(-1)?.env
    assert.equal(env?.ANTHROPIC_BASE_URL, 'http://channel-b.test')
    assert.equal(env?.ANTHROPIC_AUTH_TOKEN, '')
    assert.equal(env?.ANTHROPIC_API_KEY, 'fixture-b-key')
  })
  assert.equal(JSON.stringify(f.events).includes('fixture-b-key'), false)
})

test('a changed token at the same endpoint invalidates the configuration cache', async () => {
  const f = fixture()
  f.configure({ env: { ANTHROPIC_BASE_URL: 'http://provider.test', ANTHROPIC_AUTH_TOKEN: 'first' } })
  await f.catalog.list()
  f.configure({ env: { ANTHROPIC_BASE_URL: 'http://provider.test', ANTHROPIC_AUTH_TOKEN: 'second' } })
  await f.catalog.list()
  assert.equal(f.applied.length, 2)
  assert.equal(f.applied[1]?.env?.ANTHROPIC_AUTH_TOKEN, 'second')
})

test('a modelPicker-only edit makes the CLI re-read its settings and rebuild the menu', async () => {
  const f = fixture()
  const settings: Settings = { env: { ANTHROPIC_BASE_URL: 'http://provider.test' } }
  f.configure(settings)
  await f.catalog.list()
  const reads = f.reads()
  f.configure({ ...settings, modelPicker: { options: [{ model: 'gateway-model', label: 'Gateway' }] } })
  await f.catalog.list()
  assert.equal(f.applied.length, 2)
  assert.equal('modelPicker' in f.applied[1]!, false)
  assert.equal(f.reads(), reads + 1)
})

test('a provider switch waits for the active turn before reinitializing the CLI', async () => {
  const f = fixture()
  await f.catalog.list()
  f.setIdle(false)
  f.configure({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'next-haiku' } })
  await f.catalog.list()
  assert.equal(f.applied.length, 1)
  assert.equal(f.reads(), 1)
  f.setIdle(true)
  await f.catalog.withCurrentSettings(() => { assert.equal(f.applied.at(-1)?.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'next-haiku') })
  assert.equal(f.reads(), 2)
})

test('a failed provider refresh prevents enqueueing a message with stale settings', async () => {
  const f = fixture()
  f.failNext()
  let sent = false
  await assert.rejects(f.catalog.withCurrentSettings(() => { sent = true }), /refresh failed/)
  assert.equal(sent, false)
})

test('a channel switch relabels role rows even when the CLI menu still lists the old channel', async () => {
  // The CLI keeps returning its startup menu from reinitialize(); the mock does the same.
  const oldModels = cliModels.map((row) => row.value === 'haiku'
    ? { ...row, resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku A', description: 'Channel A haiku' }
    : row)
  const f = fixture('haiku', oldModels, 'haiku')
  f.configure({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5', ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'Haiku B' } })
  const result = await f.catalog.list()
  const haiku = result.models.find((row) => row.value === 'haiku')
  assert.equal(result.model, 'haiku')
  assert.equal(haiku?.resolvedModel, 'claude-haiku-4-5')
  assert.equal(haiku?.displayName, 'Haiku B')
  assert.equal(f.events.at(-1)?.models.find((row) => row.value === 'haiku')?.displayName, 'Haiku B')
})

test('role labels follow the CLI defaults when a channel gives no name or description', () => {
  const [sonnet, haiku, other] = applyRoleMappings([
    { value: 'sonnet', resolvedModel: 'old', displayName: 'Old', description: 'Old' },
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku A', description: 'A' },
    { value: 'claude-opus-5-5[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus 5.5', description: 'x' },
  ], { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5[1M]', ANTHROPIC_DEFAULT_HAIKU_MODEL: '' })
  assert.deepEqual(sonnet, { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5[1M]', displayName: 'claude-sonnet-5-5', description: 'Custom Sonnet model (1M context)' })
  assert.equal(haiku?.displayName, 'Haiku A')
  assert.equal(other?.displayName, 'Opus 5.5')
})

test('the current model comes from get_settings, not the transcript-tokenizing context usage', async () => {
  let usageCalls = 0
  const query = {
    supportedModels: async () => cliModels,
    getSettings: async () => ({ applied: { model: 'claude-fable-5-1' } }),
    getContextUsage: async () => { usageCalls += 1; return { model: 'wrong' } },
    applyFlagSettings: async () => {},
    reinitialize: async () => ({ models: cliModels }),
    setModel: async () => {},
  } as unknown as ConstructorParameters<typeof SessionModels>[0]
  const catalog = new SessionModels(query, '/fixture', undefined, { readSettings: async () => ({}) })
  const result = await catalog.list()
  assert.equal(result.model, 'fable')
  assert.equal(usageCalls, 0)
})

test('a CLI without get_settings still reads the model from context usage', async () => {
  const query = {
    supportedModels: async () => cliModels,
    getSettings: async () => { throw new Error('unknown subtype') },
    getContextUsage: async () => ({ model: 'claude-haiku-4-5' }),
    applyFlagSettings: async () => {},
    reinitialize: async () => ({ models: cliModels }),
    setModel: async () => {},
  } as unknown as ConstructorParameters<typeof SessionModels>[0]
  const catalog = new SessionModels(query, '/fixture', undefined, { readSettings: async () => ({}) })
  assert.equal((await catalog.list()).model, 'haiku')
})
