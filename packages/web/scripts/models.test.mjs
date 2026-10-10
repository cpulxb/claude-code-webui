import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findModel } from '../src/utils/models.ts'

const models = [
  { value: 'default', resolvedModel: 'claude-fable-5-1[1m]' },
  { value: 'opus', resolvedModel: 'claude-fable-5-1[1M]' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5[1M]' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5' },
  { value: 'claude-opus-5-5[1m]', resolvedModel: 'claude-opus-5-5[1m]' },
]

test('explicit model and alias choices take precedence over matching default rows', () => {
  assert.equal(findModel(models, 'opus')?.value, 'opus')
  assert.equal(findModel(models, 'default')?.value, 'default')
  assert.equal(findModel(models, 'claude-opus-5-5[1m]')?.value, 'claude-opus-5-5[1m]')
  const overlapping = [{ value: 'default', resolvedModel: 'claude-opus-5-5[1m]' }, ...models.slice(1)]
  assert.equal(findModel(overlapping, 'claude-opus-5-5[1m]')?.value, 'claude-opus-5-5[1m]')
})

test('1M markers match across CLI casing without merging distinct context variants', () => {
  assert.equal(findModel(models, 'claude-fable-5-1[1m]')?.value, 'opus')
  assert.equal(findModel(models, 'claude-fable-5-1')?.value, 'fable')
  assert.equal(findModel(models, 'opus[1M]')?.value, 'opus')
  assert.equal(findModel(models, 'claude-opus-5-5[1M]')?.value, 'claude-opus-5-5[1m]')
  assert.equal(findModel([{ value: 'custom', resolvedModel: 'custom' }], 'custom[1m]'), undefined)
})

test('an unset selection uses the default and an unknown model stays unmatched', () => {
  assert.equal(findModel(models, null)?.value, 'default')
  assert.equal(findModel(models, 'custom-model'), undefined)
  assert.equal(findModel([], null), undefined)
})
