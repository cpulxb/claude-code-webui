import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// A stand-in `claude` that logs its cwd and argv as it exits, and answers
// `-p "/config …"` the way the real one prints: the usage list for no pair,
// one result line for a pair. Settings come from a config dir of the test's own.
const dir = await realpath(await mkdtemp(join(tmpdir(), 'ccw-cli-config-test-')))
const config = join(dir, 'config')
const project = join(dir, 'project')
const log = join(dir, 'log')
const fake = join(dir, 'claude')
await writeFile(
  fake,
  `#!/bin/sh
case "$2" in
  "/config")
    printf 'Usage: /config key=value [key=value ...]\\n'
    for row in autoCompact=true\\|false editor=normal\\|vim theme=auto\\|dark\\|light outputStyle=default\\|Concise\\|Explanatory \\
      permissionMode=default\\|plan workflows=true\\|false gitignore=true\\|false language='<value>' acme.mode=fast\\|slow; do
      printf '  %s\\n' "$row"
    done
    printf '  switchModelsOnFlag=Switch automatically|Ask each time\\n' ;;
  "/config slow=1") sleep 0.3; echo "Set Slow to 1" ;;
  "/config bad=1") echo "Couldn't save Bad: a trusted policy owns it" ;;
  *) echo "Set Thing to \${2#*=}" ;;
esac
echo "$(pwd) $*" >> "${log}"
`,
)
await chmod(fake, 0o755)
process.env['CCW_CLAUDE_PATH'] = fake
process.env['CLAUDE_CONFIG_DIR'] = config

await mkdir(config)
await mkdir(join(project, '.claude'), { recursive: true })
const json = (path: string, value: unknown): Promise<void> => writeFile(path, JSON.stringify(value))
await json(join(config, 'settings.json'), {
  autoCompactEnabled: false,
  permissions: { defaultMode: 'plan' },
  switchModelsOnFlag: false,
  outputStyle: 'Concise',
  enableWorkflows: true,
  disableWorkflows: true,
})
await json(join(config, '.claude.json'), { theme: 'light', editorMode: 'emacs', respectGitignore: false })
await json(join(project, '.claude', 'settings.json'), { language: 'japanese' })
await json(join(project, '.claude', 'settings.local.json'), { outputStyle: 'Explanatory' })

const { parseConfigKeys, readCliConfig, writeCliConfig } = await import('../src/settings/cli-config.ts')

test.after(() => rm(dir, { recursive: true, force: true }))

const lines = async (): Promise<string[]> => (await readFile(log, 'utf8')).trim().split('\n')
const ONE_OFF = '--no-session-persistence --settings {"disableAllHooks":true}'

test('the usage list reads as rows: switches, choices with spaces in them, and free text', () => {
  assert.deepEqual(parseConfigKeys('Usage: /config key=value\n  a=true|false\n  b=Switch automatically|Ask each time\n  c=<value>\n'), [
    { key: 'a', kind: 'boolean', options: [] },
    { key: 'b', kind: 'choice', options: ['Switch automatically', 'Ask each time'] },
    { key: 'c', kind: 'text', options: [] },
  ])
  assert.throws(() => parseConfigKeys('Unknown command: /config\n'), /Unknown command/)
})

test('values are read from the tier the CLI would take them from', async () => {
  await rm(log, { force: true })
  const rows = Object.fromEntries((await readCliConfig(project)).map(({ key, ...row }) => [key, row]))
  assert.deepEqual(await lines(), [`${project} -p /config ${ONE_OFF}`])

  // settings.json beats ~/.claude.json for a moved key; the old place still counts where it is unset.
  assert.deepEqual(rows['autoCompact'], { kind: 'boolean', options: [], value: false, target: 'user' })
  assert.equal(rows['theme']?.value, 'light')
  assert.equal(rows['editor']?.value, 'normal')
  assert.equal(rows['gitignore']?.value, false)
  assert.equal(rows['gitignore']?.target, 'global')
  // Nested paths, a boolean shown as the CLI's label, and the switch that turns workflows off.
  assert.equal(rows['permissionMode']?.value, 'plan')
  assert.equal(rows['switchModelsOnFlag']?.value, 'Ask each time')
  assert.equal(rows['workflows']?.value, false)
  // Saved to the project's local file, which outranks the user's: not overridden.
  assert.deepEqual(rows['outputStyle'], {
    kind: 'choice',
    options: ['default', 'Concise', 'Explanatory'],
    value: 'Explanatory',
    target: 'local',
  })
  // Saved to the user's file, but the project's sets it.
  assert.deepEqual(rows['language']?.overriddenBy, { source: 'project', path: join(project, '.claude', 'settings.json') })
  assert.equal(rows['language']?.value, 'japanese')
  // A plugin's option: listed, with no value or target.
  assert.deepEqual(rows['acme.mode'], { kind: 'choice', options: ['fast', 'slow'], value: null })
})

test('a write runs the shorthand in the cwd and resolves with the confirmation', async () => {
  await rm(log, { force: true })
  assert.equal(await writeCliConfig(project, 'autoCompact', 'true'), 'Set Thing to true')
  assert.equal(await writeCliConfig(project, 'switchModelsOnFlag', 'Ask each time'), 'Set Thing to Ask each time')
  assert.deepEqual(await lines(), [
    `${project} -p /config autoCompact=true ${ONE_OFF}`,
    `${project} -p /config switchModelsOnFlag=Ask each time ${ONE_OFF}`,
  ])
})

test('a refusal the CLI prints rejects with its words', async () => {
  await assert.rejects(writeCliConfig(project, 'bad', '1'), { message: "Couldn't save Bad: a trusted policy owns it" })
})

test('keys and values that would split into other pairs never reach argv', async () => {
  await rm(log, { force: true })
  await assert.rejects(writeCliConfig(project, 'a b', 'true'), /设置项名不合法/)
  await assert.rejects(writeCliConfig(project, '--help', 'true'), /设置项名不合法/)
  await assert.rejects(writeCliConfig(project, 'theme', 'dark verbose=true'), /值不合法/)
  await assert.rejects(writeCliConfig(project, 'theme', 'dark\nverbose'), /值不合法/)
  await assert.rejects(writeCliConfig(project, 'theme', ' '), /值不合法/)
  await assert.rejects(readFile(log), { code: 'ENOENT' })
})

test('writes run one at a time, in the order they came', async () => {
  await rm(log, { force: true })
  // The fake logs as it exits, and the first one sleeps: run side by side, the second would log first.
  await Promise.all([writeCliConfig(project, 'slow', '1'), writeCliConfig(project, 'fast', '1')])
  assert.deepEqual(await lines(), [`${project} -p /config slow=1 ${ONE_OFF}`, `${project} -p /config fast=1 ${ONE_OFF}`])
})
