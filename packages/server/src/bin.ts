import { DEFAULT_PORT } from '@ccw/shared'

import { DEFAULT_HOST, resolveAccessToken, resolveClaudeExecutable } from './config.ts'
import { startServer } from './rpc/server.ts'
import { SessionManager } from './session/manager.ts'

const SHUTDOWN_GRACE_MS = 5_000

const port = Number(process.env.CCW_PORT ?? DEFAULT_PORT)
const host = process.env.CCW_HOST ?? DEFAULT_HOST

// A rejection reaching here is already answered on its own request path, so
// dropping live sessions over it would cost more than it buys: log only.
process.on('unhandledRejection', (reason) => console.error('[ccw] unhandled rejection', reason))
// An uncaught exception leaves process state unknown; exit and let systemd
// (Restart=on-failure) bring back a clean supervisor.
process.on('uncaughtException', (error) => {
  console.error('[ccw] uncaught exception', error)
  process.exit(1)
})

let token: string | undefined
try {
  token = resolveAccessToken(host)
} catch (error) {
  console.error(`[ccw] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const manager = new SessionManager()
const handle = await startServer({ host, port, manager, token })

const executable = resolveClaudeExecutable()
console.log(`[ccw] listening on http://${host}:${port}`)
console.log(`[ccw] claude binary: ${executable ?? '(SDK bundled copy)'}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Backstop only, in case handle.close() never settles. It protects no
    // session: close() kills every runner up front, and draining in-flight
    // requests is its own short timeout inside startServer.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref()
    void handle.close().then(() => process.exit(0))
  })
}
