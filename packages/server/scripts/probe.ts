/**
 * Checks what no type checks: the parts of the SDK and the CLI this server
 * reaches past the typings for. Run it after bumping the SDK, and when the
 * `claude` on PATH has updated itself: pnpm --filter @ccw/server probe
 *
 * Starts a real session and sends it no prompt, so no model request is made
 * and no transcript is written. `CCW_CLAUDE_PATH` picks another binary to probe.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import { cliEnv, resolveClaudeExecutable } from '../src/config.ts'
import { listPlugins, runClaude } from '../src/session/extensions.ts'
import { InputQueue } from '../src/session/input-queue.ts'
import { readCliConfig } from '../src/settings/cli-config.ts'

/** Control requests answer one at a time, so one that hangs must not hold the rest forever. */
const TIMEOUT_MS = 30_000

const cwd = process.cwd()
const executable = resolveClaudeExecutable()

const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
const sdk = JSON.parse(await readFile(join(dirname(sdkEntry), 'package.json'), 'utf8')) as {
  version: string
  claudeCodeVersion?: string
}
const cliVersion = (await runClaude(['--version'], cwd)).trim()
console.log(`[probe] SDK ${sdk.version} (ships CLI ${sdk.claudeCodeVersion ?? '?'})`)
console.log(`[probe] CLI ${cliVersion} at ${executable ?? "the SDK's own copy"}`)

const input = new InputQueue<SDKUserMessage>()
const session = query({
  prompt: input,
  options: {
    cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    env: cliEnv(),
    stderr: () => {},
  },
})
// Nothing is sent, so nothing worth reading arrives; the stream still has to be pulled.
void (async () => {
  try {
    for await (const _ of session) void _
  } catch {
    // The checks below report a CLI that died.
  }
})()

/** The methods `Query` has at runtime and its typings leave out. */
const internal = session as unknown as {
  getSettings?: () => Promise<{ applied?: Record<string, unknown> }>
  getSkillsDialog?: () => Promise<{ skills?: unknown }>
  generateSessionTitle?: unknown
}

const failures: string[] = []

async function check(name: string, run: () => Promise<string | void>): Promise<void> {
  const started = Date.now()
  let timer: NodeJS.Timeout | undefined
  try {
    const note = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)
      }),
    ])
    console.log(`[probe] ok   ${name} (${Date.now() - started}ms)${note ? `: ${note}` : ''}`)
  } catch (error) {
    failures.push(name)
    console.error(`[probe] FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

// --- Query methods the typings leave out ---------------------------------------

// Read by SessionRunner.flags() and SessionModels.
await check('getSettings', async () => {
  assert.equal(typeof internal.getSettings, 'function', 'Query has no such method any more')
  const { applied } = await internal.getSettings!()
  assert.ok(applied, 'the answer has no `applied`')
  assert.ok(typeof applied['model'] === 'string' && applied['model'], '`applied.model` is not a model id')
  assert.ok(applied['effort'] == null || typeof applied['effort'] === 'string', '`applied.effort` is not a level')
  assert.equal(typeof applied['ultracode'], 'boolean', '`applied.ultracode` is not a boolean')
  assert.equal(typeof applied['ultracodeAvailable'], 'boolean', '`applied.ultracodeAvailable` is not a boolean')
  return `model ${applied['model']}`
})

// Read by SessionRunner.skills(); the rows are `SkillInfo` in @ccw/shared.
await check('getSkillsDialog', async () => {
  assert.equal(typeof internal.getSkillsDialog, 'function', 'Query has no such method any more')
  const { skills } = await internal.getSkillsDialog!()
  assert.ok(Array.isArray(skills), 'the answer has no `skills` list')
  for (const row of skills as Record<string, unknown>[]) {
    assert.equal(typeof row['name'], 'string', 'a row has no `name`')
    assert.ok(['on', 'name-only', 'user-invocable-only', 'off'].includes(row['state'] as string), `${row['name']}: unknown state ${String(row['state'])}`)
    assert.ok(typeof row['handles'] === 'object' && row['handles'] !== null, `${row['name']}: no \`handles\``)
  }
  return `${skills.length} skills`
})

// Only that it is there: calling it would spend a Haiku request.
await check('generateSessionTitle', async () => {
  assert.equal(typeof internal.generateSessionTitle, 'function', 'Query has no such method any more')
})

// --- Typed requests, answered by a CLI the lockfile does not pin ----------------

await check('usage', async () => {
  const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
  assert.ok(usage.session, 'the answer has no `session`')
})
await check('supportedCommands', async () => `${(await session.supportedCommands()).length} commands`)
await check('supportedModels', async () => `${(await session.supportedModels()).length} models`)
await check('reinitialize', async () => {
  assert.ok(Array.isArray((await session.reinitialize()).models), 'the answer has no `models` list')
})
await check('accountInfo', async () => void (await session.accountInfo()))
await check('mcpServerStatus', async () => `${(await session.mcpServerStatus()).length} servers`)
// Last: it tokenizes the conversation through the API's count_tokens, the one request here a gateway can stall.
await check('getContextUsage', async () => {
  const { model } = await session.getContextUsage()
  assert.ok(typeof model === 'string' && model, '`model` is not a model id')
})

input.close()
session.close()

// --- CLI output parsed as text or JSON ------------------------------------------

await check('/config', async () => {
  const rows = await readCliConfig(cwd)
  // A plugin's option has no value here either, but its key is namespaced.
  const unknown = rows.filter((row) => row.target === undefined && /^[A-Za-z]+$/.test(row.key)).map((row) => row.key)
  assert.ok(unknown.length === 0, `no entry in SPECS (src/settings/cli-config.ts) for: ${unknown.join(', ')}`)
  return `${rows.length} keys`
})

await check('plugin list --json', async () => {
  const plugins = await listPlugins(cwd)
  assert.ok(Array.isArray(plugins), 'the output is not a list')
  for (const plugin of plugins) {
    assert.equal(typeof plugin.id, 'string', 'a row has no `id`')
    assert.equal(typeof plugin.scope, 'string', `${plugin.id}: no \`scope\``)
    assert.equal(typeof plugin.enabled, 'boolean', `${plugin.id}: no \`enabled\``)
  }
  return `${plugins.length} plugins`
})

if (failures.length > 0) {
  console.error(`[probe] FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('[probe] PASS')
process.exit(0)
