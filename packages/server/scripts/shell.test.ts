import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { TerminalServerMessage } from '@ccw/shared'
import type { WebSocket } from 'ws'

import { runShellCommand } from '../src/session/shell.ts'
import { attachTerminal } from '../src/terminal/pty.ts'

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

test('a timeout kills what the shell is running, not only the shell', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ccw-shell-timeout-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pidFile = join(dir, 'pid')
  // No `&` anywhere: the shell waits on `sleep` in the foreground, as it would
  // on `python job.py; echo done`.
  const result = await runShellCommand(`sh -c 'echo $$ > ${pidFile}; exec sleep 30'; echo done`, dir, 300)
  assert.match(result.stderr, /timed out/)
  const pid = Number(await readFile(pidFile, 'utf8'))
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  t.after(() => {
    if (alive()) process.kill(pid, 'SIGKILL')
  })
  for (let tries = 0; tries < 50 && alive(); tries++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(alive(), false, `sleep ${pid} outlived the timeout`)
})

test('long output is cut to the limit', async () => {
  const { stdout } = await runShellCommand('head -c 100000 /dev/zero | tr "\\0" a', tmpdir())
  assert.ok(stdout.endsWith('… (output truncated)'))
  assert.ok(stdout.length < 31_000)
})

test('a terminal frame that parses but is no message is ignored rather than fatal', async (t) => {
  let output = ''
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    send: (frame: string) => {
      const message = JSON.parse(frame) as TerminalServerMessage
      if (message.type === 'output') output += message.data
    },
    close: () => {
      ws.readyState = 3
    },
  })
  attachTerminal(ws as unknown as WebSocket, { shell: '/bin/sh', cwd: tmpdir(), cols: null, rows: null })
  t.after(() => ws.emit('close'))
  const frame = (value: unknown): void => {
    ws.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)))
  }
  // An exception out of the listener would reach bin.ts's uncaughtException
  // handler, which exits the server.
  for (const junk of ['null', '[]', '7', '"input"', { type: 'input', data: 5 }, { type: 'resize', cols: 'wide' }, { type: 'ack', chars: {} }]) {
    frame(junk)
  }
  frame({ type: 'resize', cols: 101, rows: 33 })
  frame({ type: 'input', data: 'stty size; echo ccw-$((6 * 7))\n' })
  for (let tries = 0; tries < 100 && !output.includes('ccw-42'); tries++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.match(output, /33 101/)
  assert.match(output, /ccw-42/)
})
