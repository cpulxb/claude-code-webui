import assert from 'node:assert/strict'
import { test } from 'node:test'

import { channelFragment, channelProblems, defaultChannelName, fromLibrary, switchTo, toLibrary } from '../src/utils/channels.ts'
import { toForm } from '../src/utils/settings.ts'

// The file from the request: a local gateway, every role on one model, and
// settings that belong to no channel around it.
const cpa = {
  env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
    ANTHROPIC_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash-1017[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash-1017[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash-1017[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'DeepSeek Flash',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash-1017[1m]',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    ANTHROPIC_API_KEY: 'sk-cpa',
    EXA_API_KEY: 'exa',
  },
  permissions: { defaultMode: 'bypassPermissions' },
  effortLevel: 'xhigh',
  theme: 'dark',
  model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017[1m]',
  modelPicker: { options: [{ model: 'GLM-5.3[1m]', label: 'GLM' }, { model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017[1m]' }] },
}

const relay = { env: { ANTHROPIC_BASE_URL: 'https://relayfor.xyz/v1', ANTHROPIC_AUTH_TOKEN: 'sk-relay' }, model: 'claude-opus-5-5' }

test('the first visit makes settings.json the active channel, named after its host', () => {
  const { drafts, activeId } = fromLibrary({ channels: [], activeId: null }, cpa)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].id, activeId)
  assert.equal(drafts[0].name, '127.0.0.1:8317')
  assert.deepEqual(drafts[0].form, toForm(cpa))
})

test('the active channel is what settings.json holds now, not what was saved for it', () => {
  const library = { channels: [{ id: 'a', name: 'CPA', settings: { env: { ANTHROPIC_BASE_URL: 'http://old' } } }], activeId: 'a' }
  const { drafts, activeId } = fromLibrary(library, cpa)
  assert.equal(activeId, 'a')
  assert.equal(drafts[0].form.baseUrl, 'http://127.0.0.1:8317')
})

test('with no active entry, a saved channel matching settings.json is taken as active', () => {
  const library = { channels: [{ id: 'r', name: 'relay', settings: channelFragment(toForm(relay)) }], activeId: null }
  const { drafts, activeId } = fromLibrary(library, { ...relay, theme: 'dark' })
  assert.equal(activeId, 'r')
  assert.equal(drafts.length, 1)
})

test('the saved list carries the active channel as the form has it, and trimmed names', () => {
  const { drafts, activeId } = fromLibrary({ channels: [], activeId: null }, cpa)
  const edited = { ...toForm(cpa), baseUrl: 'http://127.0.0.1:9000' }
  const saved = toLibrary([{ ...drafts[0], name: '  CPA ' }], activeId, edited)
  assert.equal(saved.channels[0].name, 'CPA')
  assert.equal(saved.channels[0].settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9000')
  assert.equal(saved.channels[0].settings.env.EXA_API_KEY, undefined, 'only what the forms write')
  assert.equal(saved.channels[0].settings.theme, undefined)
})

test('switching replaces every key a channel carries and keeps the rest', () => {
  const next = switchTo(cpa, toForm(relay))
  assert.deepEqual(next.env, {
    ANTHROPIC_BASE_URL: 'https://relayfor.xyz/v1',
    // It outranks `model`, so it follows the switch rather than keep naming the gateway's model.
    ANTHROPIC_MODEL: 'claude-opus-5-5',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    EXA_API_KEY: 'exa',
    ANTHROPIC_AUTH_TOKEN: 'sk-relay',
  })
  assert.equal(next.model, 'claude-opus-5-5')
  assert.equal(next.modelPicker, undefined)
  assert.deepEqual(next.permissions, cpa.permissions)
  assert.equal(next.effortLevel, 'xhigh')
  assert.equal(next.theme, 'dark')
})

test('switching back restores the first channel', () => {
  const saved = channelFragment(toForm(cpa))
  const back = switchTo(switchTo(cpa, toForm(relay)), toForm(saved))
  assert.deepEqual(toForm(back), { ...toForm(cpa), roles: { ...toForm(cpa).roles } })
  assert.equal(back.env.ANTHROPIC_SMALL_FAST_MODEL, cpa.env.ANTHROPIC_SMALL_FAST_MODEL)
  assert.equal(back.env.ANTHROPIC_API_KEY, 'sk-cpa')
  assert.equal(back.env.ANTHROPIC_AUTH_TOKEN, undefined)
})

test('an inactive channel with problems, or with no name, stops the save', () => {
  const broken = { ...toForm(relay), models: [{ model: 'x', oneM: false, label: '', description: '', behavesAs: '' }, { model: 'x', oneM: false, label: '', description: '', behavesAs: '' }] }
  const drafts = [
    { id: 'a', name: 'CPA', form: { ...toForm(cpa), baseUrl: 'nope' } },
    { id: 'b', name: 'relay', form: broken },
    { id: 'c', name: ' ', form: toForm({}) },
  ]
  assert.deepEqual(channelProblems(drafts, 'a'), ['渠道「relay」：模型 ID 重复：x', '有渠道没填名称'])
})

test('an unnamed channel is called after its host', () => {
  assert.equal(defaultChannelName(toForm(relay)), 'relayfor.xyz')
  assert.equal(defaultChannelName(toForm({})), 'Anthropic 官方')
})
