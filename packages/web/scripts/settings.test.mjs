import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyForm, formProblems, groupModels, maskSecrets, rowsFromRoles, SECRET_MASK, shadowedModels, toForm, unmaskSecrets } from '../src/utils/settings.ts'
import { configMeta, configRows } from '../src/utils/cli-config.ts'

// The file from the request: one gateway, every role on the same model.
const gateway = {
  env: {
    ANTHROPIC_API_KEY: 'sk_lupi_secret',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4.1-flash-1017[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4.1-flash-1017[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4.1-flash-1017[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4.1-flash-1017[1m]',
    ANTHROPIC_MODEL: 'deepseek-v4.1-flash-1017[1m]',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v4.1-flash-1017[1m]',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4.1-flash-1017[1m]',
  },
  permissions: { defaultMode: 'bypassPermissions' },
  model: 'deepseek-v4.1-flash-1017[1m]',
  modelPicker: {
    options: [{
      model: 'deepseek-v4.1-flash-1017[1m]',
      label: 'DeepSeek V4.1 Flash 1017 (1M)',
      description: 'deepseek-v4.1-flash-1017 · 1M 上下文',
      behavesAs: 'claude-sonnet-5-5',
    }],
  },
  effortLevel: 'xhigh',
}

test('saving an untouched form leaves the file exactly as it was', () => {
  assert.deepEqual(applyForm(gateway, toForm(gateway)), gateway)
  assert.deepEqual(applyForm({}, toForm({})), {})
  assert.deepEqual(applyForm({ theme: 'dark', model: 'opus' }, toForm({ theme: 'dark', model: 'opus' })), { theme: 'dark', model: 'opus' })
})

test('the form reads the channel, the 1M marker and the roles of a gateway file', () => {
  const form = toForm(gateway)
  assert.equal(form.authField, 'ANTHROPIC_API_KEY')
  assert.equal(form.key, 'sk_lupi_secret')
  assert.deepEqual(form.models[0], {
    model: 'deepseek-v4.1-flash-1017',
    oneM: true,
    label: 'DeepSeek V4.1 Flash 1017 (1M)',
    description: 'deepseek-v4.1-flash-1017 · 1M 上下文',
    behavesAs: 'claude-sonnet-5-5',
  })
  assert.equal(form.defaultModel, 'deepseek-v4.1-flash-1017[1m]')
  assert.equal(form.roles.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-v4.1-flash-1017[1m]')
  assert.equal('ANTHROPIC_SMALL_FAST_MODEL' in toForm({}).roles, false)
})

test('switching channels writes the chosen auth field and drops the other one', () => {
  const form = { ...toForm(gateway), baseUrl: 'https://router.example.ai//', authField: 'ANTHROPIC_AUTH_TOKEN', key: ' rq-token ' }
  const env = applyForm(gateway, form).env
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://router.example.ai')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'rq-token')
  assert.equal('ANTHROPIC_API_KEY' in env, false)
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max')
})

test('the default model updates ANTHROPIC_MODEL too, which would otherwise outrank it', () => {
  const form = toForm(gateway)
  form.models.push({ model: 'kimi-k3', oneM: false, label: '', description: '', behavesAs: '' })
  form.defaultModel = 'kimi-k3'
  const next = applyForm(gateway, form)
  assert.equal(next.model, 'kimi-k3')
  assert.equal(next.env.ANTHROPIC_MODEL, 'kimi-k3')
  assert.deepEqual(next.modelPicker.options[1], { model: 'kimi-k3' })
  assert.deepEqual(applyForm({ model: 'opus' }, { ...toForm({}), defaultModel: 'sonnet' }), { model: 'sonnet' })
})

test('emptied fields are removed rather than saved blank', () => {
  const form = { ...toForm(gateway), baseUrl: ' ', key: '', models: [], defaultModel: '' }
  form.roles = Object.fromEntries(Object.keys(form.roles).map((key) => [key, '']))
  const next = applyForm(gateway, form)
  assert.deepEqual(next.env, { CLAUDE_CODE_EFFORT_LEVEL: 'max' })
  assert.equal('model' in next, false)
  assert.equal('modelPicker' in next, false)
})

test('a role that changes model sheds the name and description of the old one', () => {
  const settings = { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'old', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Old', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h', ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'H' } }
  const form = toForm(settings)
  form.roles.ANTHROPIC_DEFAULT_OPUS_MODEL = 'new'
  assert.deepEqual(applyForm(settings, form).env, { ANTHROPIC_DEFAULT_OPUS_MODEL: 'new', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h', ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'H' })
})

test('the JSON view masks credentials and a masked value saves as the stored one', () => {
  const masked = maskSecrets(gateway)
  assert.equal(masked.env.ANTHROPIC_API_KEY, SECRET_MASK)
  assert.equal(masked.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8317')
  assert.equal(JSON.stringify(masked).includes('sk_lupi_secret'), false)
  assert.deepEqual(unmaskSecrets(masked, gateway), gateway)
  const replaced = { ...masked, env: { ...masked.env, ANTHROPIC_API_KEY: 'sk-new' } }
  assert.equal(unmaskSecrets(replaced, gateway).env.ANTHROPIC_API_KEY, 'sk-new')
})

test('a save is held back by a bad address, a row without an id, or a repeated id', () => {
  const row = (model, extra = {}) => ({ model, oneM: false, label: '', description: '', behavesAs: '', ...extra })
  assert.deepEqual(formProblems(toForm(gateway)), [])
  assert.deepEqual(formProblems({ ...toForm({}), baseUrl: '127.0.0.1:8317' }), ['请求地址要以 http:// 或 https:// 开头'])
  // A row left wholly empty is just dropped; one with a label has lost its id.
  assert.deepEqual(formProblems({ ...toForm({}), models: [row('')] }), [])
  assert.deepEqual(formProblems({ ...toForm({}), models: [row('', { label: 'Kimi' })] }), ['有模型没填模型 ID'])
  assert.deepEqual(formProblems({ ...toForm({}), models: [row('m', { oneM: true }), row('m[1m]')] }), ['模型 ID 重复：m[1m]'])
  assert.deepEqual(formProblems({ ...toForm({}), models: [row('m', { oneM: true }), row('m')] }), [])
})

test('rows that share a role id are reported as hidden until the built-in rows are replaced', () => {
  const form = toForm(gateway)
  form.models.push({ model: 'kimi-k3', oneM: false, label: '', description: '', behavesAs: '' })
  assert.deepEqual(shadowedModels(form), ['deepseek-v4.1-flash-1017[1m]'])
  assert.deepEqual(shadowedModels({ ...form, replaceBuiltIn: true }), [])
})

test('a file that only maps roles can seed the list from them, aliases left out', () => {
  const form = toForm({ model: 'opus', env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'big[1M]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'big[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small' } })
  assert.deepEqual(rowsFromRoles(form).map((row) => [row.model, row.oneM]), [['big', true], ['small', false]])
})

test('upstream models are grouped under their owners A→Z, unowned ones first, upstream order kept inside', () => {
  const models = [
    { id: 'qwen-plus', owner: 'alibaba' },
    { id: 'claude-opus-4-8' },
    { id: 'jamba-1-5-mini', owner: 'ai21' },
    { id: 'qwen-flash', owner: 'alibaba' },
    { id: 'jamba-1-5-large', owner: 'ai21' },
  ]
  assert.deepEqual(groupModels(models, '').map(({ owner, models: ids }) => [owner, ids.map((model) => model.id)]), [
    ['', ['claude-opus-4-8']],
    ['ai21', ['jamba-1-5-mini', 'jamba-1-5-large']],
    ['alibaba', ['qwen-plus', 'qwen-flash']],
  ])
})

test('the model filter matches id or owner, ignoring case and surrounding blanks', () => {
  const models = [{ id: 'qwen-plus', owner: 'alibaba' }, { id: 'Jamba-Large', owner: 'ai21' }, { id: 'claude-opus-4-8' }]
  assert.deepEqual(groupModels(models, ' JAMBA ').map((group) => group.owner), ['ai21'])
  assert.deepEqual(groupModels(models, 'alibaba').map((group) => group.models[0].id), ['qwen-plus'])
  assert.deepEqual(groupModels(models, 'nothing'), [])
})

test('/config rows sort into their group in panel order, and search by name or key', () => {
  const row = (key) => ({ key, kind: 'boolean', options: [], value: true, target: 'user' })
  const rows = ['theme', 'autoCompact', 'acme.mode', 'model', 'zeta', 'verbose'].map(row)
  const keys = (group, query = '') => configRows(rows, group, query).map((entry) => entry.key)
  assert.deepEqual(keys('session'), ['model', 'autoCompact'])
  assert.deepEqual(keys('terminal'), ['theme', 'verbose'])
  // Keys the panel has no name for keep the CLI's, A→Z.
  assert.deepEqual(keys('other'), ['acme.mode', 'zeta'])
  assert.equal(configMeta('zeta').label, 'zeta')
  assert.deepEqual(keys('session', '压缩'), ['autoCompact'])
  assert.deepEqual(keys('terminal', 'VERB'), ['verbose'])
})
