import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { readFilePreview } from '../src/files/explorer.ts'

test('a FIFO with no writer is refused at once rather than holding a file-I/O thread', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ccw-explorer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fifo = join(dir, 'ipc')
  await promisify(execFile)('mkfifo', [fifo])
  const outcome = await Promise.race([
    readFilePreview(fifo).then(
      () => 'read',
      (error: Error) => error.message,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 1000)),
  ])
  // A blocked open would keep the test process alive: give it a writer.
  const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => null)
  await writer?.close()
  assert.match(outcome, /不是普通文件/)
})

test('text and images still preview', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ccw-explorer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'notes.txt'), 'hello')
  await writeFile(join(dir, 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.deepEqual(await readFilePreview(join(dir, 'notes.txt')), { kind: 'text', size: 5, content: 'hello', truncated: false })
  assert.deepEqual(await readFilePreview(join(dir, 'dot.png')), { kind: 'image', size: 4, mediaType: 'image/png', data: 'iVBORw==' })
  await assert.rejects(readFilePreview(dir), /不是普通文件/)
})
