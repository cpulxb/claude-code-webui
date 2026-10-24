import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { readUserSettings, writeUserSettings } from '../src/settings/user-settings.ts'

let config: string
let file: string

beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), 'ccw-settings-'))
  file = join(config, 'settings.json')
  process.env['CLAUDE_CONFIG_DIR'] = config
})

test('a missing file reads as empty and the first save creates it private', async () => {
  const read = await readUserSettings()
  assert.deepEqual(read.settings, {})
  assert.equal(read.path, file)
  const saved = await writeUserSettings({ env: { ANTHROPIC_API_KEY: 'k' } }, read.revision)
  assert.deepEqual(saved.settings, { env: { ANTHROPIC_API_KEY: 'k' } })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('a save keeps the file mode and leaves the previous content in .bak', async () => {
  await writeFile(file, '{ "theme": "dark" }', { mode: 0o640 })
  const read = await readUserSettings()
  await writeUserSettings({ ...read.settings, model: 'opus' }, read.revision)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { theme: 'dark', model: 'opus' })
  assert.equal((await stat(file)).mode & 0o777, 0o640)
  assert.equal(await readFile(`${file}.bak`, 'utf8'), '{ "theme": "dark" }')
})

test('a save is refused when the file changed after it was read', async () => {
  await writeFile(file, '{}')
  const read = await readUserSettings()
  await writeFile(file, '{ "model": "sonnet" }')
  await assert.rejects(writeUserSettings({ model: 'opus' }, read.revision), /其他程序/)
  assert.equal(await readFile(file, 'utf8'), '{ "model": "sonnet" }')
})

test('a symlinked settings.json is written through, not replaced', async () => {
  const real = join(await mkdtemp(join(tmpdir(), 'ccw-dotfiles-')), 'settings.json')
  await writeFile(real, '{}')
  await symlink(real, file)
  await writeUserSettings({ model: 'opus' }, (await readUserSettings()).revision)
  assert.equal((await lstat(file)).isSymbolicLink(), true)
  assert.deepEqual(JSON.parse(await readFile(real, 'utf8')), { model: 'opus' })
})

test('settings the CLI would reject are refused before they reach the file', async () => {
  const { revision } = await readUserSettings()
  await assert.rejects(writeUserSettings([], revision), /JSON 对象/)
  await assert.rejects(writeUserSettings({ env: { CLAUDE_CODE_MAX_RETRIES: 15 } }, revision), /env\.CLAUDE_CODE_MAX_RETRIES/)
  await assert.rejects(writeUserSettings({ modelPicker: { options: [{ label: 'no id' }] } }, revision), /第 1 项/)
  await assert.rejects(readFile(file), { code: 'ENOENT' })
})

test('an unparseable file is reported instead of being read as empty', async () => {
  await writeFile(file, '{ "model": ')
  await assert.rejects(readUserSettings(), /不是合法的 JSON/)
})

test('project settings that shadow a form field are reported as overrides', async () => {
  const project = await mkdtemp(join(tmpdir(), 'ccw-project-'))
  await mkdir(join(project, '.claude'))
  await writeFile(join(project, '.claude', 'settings.local.json'), JSON.stringify({
    model: 'haiku',
    // Not honoured from a project checkout, so not an override.
    modelPicker: { options: [{ model: 'x' }] },
    env: { ANTHROPIC_BASE_URL: 'http://project.test', UNRELATED: '1' },
  }))
  await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://user.test' } }))
  const { overrides } = await readUserSettings(project)
  assert.deepEqual(overrides.map(({ key, source }) => `${source}:${key}`), ['local:model', 'local:env.ANTHROPIC_BASE_URL'])
  assert.deepEqual((await readUserSettings()).overrides, [])
})
