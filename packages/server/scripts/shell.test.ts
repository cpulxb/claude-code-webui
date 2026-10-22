import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runShellCommand } from '../src/session/shell.ts'

test('`!` commands run in the session cwd and report failures in-band', async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ccw-shell-test-')))
  t.after(() => rm(cwd, { recursive: true, force: true }))

  assert.deepEqual(await runShellCommand('pwd', cwd), { stdout: cwd, stderr: '' })
  assert.deepEqual(await runShellCommand('echo out; echo err >&2; exit 3', cwd), {
    stdout: 'out',
    stderr: 'err\nExit code 3',
  })
  assert.deepEqual(await runShellCommand('exit 2', cwd), { stdout: '', stderr: 'Exit code 2' })
})

test('a backgrounded child holding the pipes does not stall the command', async () => {
  const started = Date.now()
  const result = await runShellCommand('sleep 30 & echo started', tmpdir())
  assert.equal(result.stdout, 'started')
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`)
})

test('long output is cut to the limit', async () => {
  const { stdout } = await runShellCommand('head -c 100000 /dev/zero | tr "\\0" a', tmpdir())
  assert.ok(stdout.endsWith('… (output truncated)'))
  assert.ok(stdout.length < 31_000)
})
