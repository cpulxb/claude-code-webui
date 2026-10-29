import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// A stand-in `claude` that logs its cwd, argv and stdin, and answers the way
// the real subcommands do: one JSON result line, and exit 1 on a refusal.
const dir = await realpath(await mkdtemp(join(tmpdir(), 'ccw-extensions-test-')))
const log = join(dir, 'log')
const fake = join(dir, 'claude')
await writeFile(
  fake,
  `#!/bin/sh
echo "$(pwd) $*" >> "${log}"
case "$1 $2" in
  "plugin list") printf '[\\n  {"id": "a@m", "scope": "user", "enabled": true}\\n]\\n' ;;
  "plugin update") echo '{"outcome":"ok","updateOutcome":"updated","oldVersion":"1.0.0","newVersion":"1.1.0"}' ;;
  "plugin disable") echo '{"outcome":"failed","message":"already disabled"}'; echo 'human words' >&2; exit 1 ;;
  "plugin enable") echo '{"outcome":"ok","message":"Successfully enabled"}' ;;
  "edit-skill-overrides --json") cat >> "${log}"; echo >> "${log}"; echo 'not here' >&2; exit 1 ;;
esac
`,
)
await chmod(fake, 0o755)
process.env['CCW_CLAUDE_PATH'] = fake

const { editSkillState, listPlugins, runPluginAction } = await import('../src/session/extensions.ts')

test.after(() => rm(dir, { recursive: true, force: true }))

const lines = async (): Promise<string[]> => (await readFile(log, 'utf8')).trim().split('\n')

test('plugin subcommands run in the session cwd and report what an update did', async () => {
  await rm(log, { force: true })
  assert.deepEqual(await listPlugins(dir), [{ id: 'a@m', scope: 'user', enabled: true }])
  assert.equal(await runPluginAction(dir, 'a@m', 'user', 'enable'), undefined)
  assert.equal(await runPluginAction(dir, 'a@m', 'user', 'update'), 'a@m 已从 1.0.0 更新到 1.1.0')
  assert.deepEqual(await lines(), [
    `${dir} plugin list --json`,
    `${dir} plugin enable a@m --scope user --json`,
    `${dir} plugin update a@m --scope user --json`,
  ])
})

test('a refusal rejects with the result line, else stderr', async () => {
  await assert.rejects(runPluginAction(dir, 'a@m', 'user', 'disable'), { message: 'already disabled' })
  await assert.rejects(editSkillState(dir, { name: 'docx', state: 'off' }), { message: 'not here' })
  assert.equal((await lines()).at(-1), '{"name":"docx","state":"off"}')
})

test('ids, scopes and actions that would read as options never reach argv', async () => {
  await rm(log, { force: true })
  await assert.rejects(runPluginAction(dir, '--all', 'user', 'disable'), /插件 ID 不合法/)
  await assert.rejects(runPluginAction(dir, 'a@m', '--all', 'disable'), /未知的插件范围/)
  await assert.rejects(runPluginAction(dir, 'a@m', 'user', 'marketplace' as never), /未知的插件操作/)
  await assert.rejects(readFile(log), { code: 'ENOENT' })
})
