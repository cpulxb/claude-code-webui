import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ModelInfo, Settings } from '@anthropic-ai/claude-agent-sdk'

import { SessionModels } from '../src/session/models.ts'

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
