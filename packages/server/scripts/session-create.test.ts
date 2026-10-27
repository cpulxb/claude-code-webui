import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SessionConfig } from '@ccw/shared'

import { createRpcHandlers } from '../src/rpc/routes.ts'
import type { SessionManager } from '../src/session/manager.ts'
import type { Updater } from '../src/update/updater.ts'

test('a session will not start in a directory that is gone, and the error says so', async () => {
  let started = 0
  const manager = {
    create: () => {
      started += 1
      throw new Error('the CLI must not start')
    },
  } as unknown as SessionManager
  const handlers = createRpcHandlers(manager, {} as Updater)
  await assert.rejects(
    handlers['session.create']({ cwd: '/nonexistent/(unknown)' } as SessionConfig),
    /工作目录不存在：\/nonexistent\/\(unknown\)/,
  )
  assert.equal(started, 0)
})
