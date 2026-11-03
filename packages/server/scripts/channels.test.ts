import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { readChannels, writeChannels } from '../src/settings/channels.ts'
import { readUserSettings } from '../src/settings/user-settings.ts'

let ccw: string
let claude: string

const cpa = { id: 'cpa', name: 'CPA', settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_API_KEY: 'k1' } } }
const relay = { id: 'relay', name: 'relayfor', settings: { env: { ANTHROPIC_BASE_URL: 'https://relayfor.xyz', ANTHROPIC_AUTH_TOKEN: 'k2' }, model: 'claude-opus-5-5' } }

beforeEach(async () => {
  ccw = await mkdtemp(join(tmpdir(), 'ccw-channels-'))
  claude = await mkdtemp(join(tmpdir(), 'ccw-channels-claude-'))
  process.env['CCW_CONFIG_DIR'] = ccw
  process.env['CLAUDE_CONFIG_DIR'] = claude
})

test('no file reads as an empty list, and the first save creates it private', async () => {
  const empty = await readChannels()
  assert.deepEqual({ ...empty, revision: undefined }, { channels: [], activeId: null, revision: undefined })
  const { library, settings } = await writeChannels([cpa, relay], 'cpa', empty.revision)
  assert.deepEqual(library.channels, [cpa, relay])
  assert.equal(library.activeId, 'cpa')
  assert.equal(settings, null)
  assert.equal((await stat(join(ccw, 'channels.json'))).mode & 0o777, 0o600)
})

test('a save over a list changed by another tab is refused', async () => {
  const first = await readChannels()
  await writeChannels([cpa], 'cpa', first.revision)
  await assert.rejects(writeChannels([relay], 'relay', first.revision), /另一个标签页/)
  assert.deepEqual((await readChannels()).channels, [cpa])
})

test('two saves from one revision at once: one lands whole, the other is refused', async () => {
  const empty = await readChannels()
  const results = await Promise.allSettled([
    writeChannels([cpa, relay], 'cpa', empty.revision),
    writeChannels([relay], 'relay', empty.revision),
  ])
  const saved = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const refused = results.flatMap((result) => (result.status === 'rejected' ? [String(result.reason)] : []))
  assert.equal(saved.length, 1)
  assert.match(refused[0] ?? '', /另一个标签页/)
  // Parses, and holds what the successful save answered with.
  assert.deepEqual((await readChannels()).channels, saved[0]!.library.channels)
})

test('switching writes settings.json and the list together', async () => {
  await writeFile(join(claude, 'settings.json'), JSON.stringify({ ...cpa.settings, theme: 'dark' }))
  const settings = await readUserSettings()
  const library = await readChannels()
  const next = { ...relay.settings, theme: 'dark' }
  const result = await writeChannels([cpa, relay], 'relay', library.revision, { settings: next, revision: settings.revision })
  assert.deepEqual(result.settings?.settings, next)
  assert.deepEqual(JSON.parse(await readFile(join(claude, 'settings.json'), 'utf8')), next)
  assert.equal(result.library.activeId, 'relay')
})

test('when settings.json changed elsewhere, neither file is written', async () => {
  await writeFile(join(claude, 'settings.json'), '{}')
  const settings = await readUserSettings()
  await writeFile(join(claude, 'settings.json'), '{ "model": "sonnet" }')
  const library = await readChannels()
  await assert.rejects(
    writeChannels([relay], 'relay', library.revision, { settings: relay.settings, revision: settings.revision }),
    /其他程序/,
  )
  assert.deepEqual((await readChannels()).channels, [])
  assert.equal(await readFile(join(claude, 'settings.json'), 'utf8'), '{ "model": "sonnet" }')
})

test('malformed lists are refused before anything is written', async () => {
  const { revision } = await readChannels()
  await assert.rejects(writeChannels([cpa], 'gone', revision), /不在列表里/)
  await assert.rejects(writeChannels([cpa, cpa], 'cpa', revision), /id 重复/)
  await assert.rejects(writeChannels([{ ...cpa, name: ' ' }], 'cpa', revision), /名称/)
  await assert.rejects(writeChannels([{ ...cpa, id: '../x' }], 'cpa', revision), /id 无效/)
  await assert.rejects(writeChannels([{ ...cpa, settings: { env: { ANTHROPIC_API_KEY: 1 } } }], 'cpa', revision), /CPA.*字符串/)
  await assert.rejects(writeChannels({}, null, revision), /数组/)
})

test('a damaged file says where it is', async () => {
  await writeFile(join(ccw, 'channels.json'), '{ nope')
  await assert.rejects(readChannels(), /channels\.json 不是合法的 JSON/)
})
