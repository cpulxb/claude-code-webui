import { DEFAULT_PORT } from '@ccw/shared'

import { DEFAULT_HOST, resolveClaudeExecutable } from './config.ts'
import { startServer } from './rpc/server.ts'
import { SessionManager } from './session/manager.ts'

const port = Number(process.env.CCW_PORT ?? DEFAULT_PORT)
const host = process.env.CCW_HOST ?? DEFAULT_HOST

const manager = new SessionManager()
const handle = await startServer({ host, port, manager })

const executable = resolveClaudeExecutable()
console.log(`[ccw] listening on http://${host}:${port}`)
console.log(`[ccw] claude binary: ${executable ?? '(SDK bundled copy)'}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void handle.close().then(() => process.exit(0))
  })
}
