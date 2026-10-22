import { existsSync } from 'node:fs'

import { DEFAULT_PORT } from '@ccw/shared'

import { AuthGate } from './auth/gate.ts'
import { configDir } from './auth/pairing.ts'
import { DEFAULT_HOST, assertSafeBind, requirePairing, resolveClaudeExecutable, resolveTls } from './config.ts'
import { WEB_DIST } from './http/static.ts'
import { startServer, type TlsOptions } from './rpc/server.ts'
import { SessionManager } from './session/manager.ts'
import { Updater } from './update/updater.ts'

const SHUTDOWN_GRACE_MS = 5_000
/** EX_TEMPFAIL: a failure exit, so a unit with Restart=on-failure starts the server again. */
const RESTART_EXIT_CODE = 75

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

let tls: TlsOptions | undefined
try {
  tls = resolveTls()
  assertSafeBind(host, tls)
} catch (error) {
  console.error(`[ccw] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
if (process.env['CCW_TOKEN']) {
  console.warn('[ccw] CCW_TOKEN is no longer used: devices pair with a one-time code from `pnpm pair`.')
}

const manager = new SessionManager()
const auth = await AuthGate.open({ requirePairing: requirePairing() })
const webRoot = existsSync(WEB_DIST) ? WEB_DIST : undefined
const updater = await Updater.open({
  canApply: process.env['npm_lifecycle_event'] !== 'dev',
  buildWeb: webRoot !== undefined,
  // systemd sets INVOCATION_ID for the services it starts. Anywhere else no
  // one would start the server again, so the user is asked to.
  restart: process.env['INVOCATION_ID'] ? () => shutdown(RESTART_EXIT_CODE) : null,
})
const handle = await startServer({
  host,
  port,
  manager,
  auth,
  updater,
  ...(tls ? { tls } : {}),
  ...(webRoot ? { webRoot } : {}),
})
updater.start()

const executable = resolveClaudeExecutable()
console.log(`[ccw] listening on ${tls ? 'https' : 'http'}://${host}:${port}`)
console.log(`[ccw] web UI: ${webRoot ?? '(not built — run `pnpm --filter @ccw/web build` to serve it here)'}`)
console.log(`[ccw] pairing: ${requirePairing() ? 'required everywhere' : 'required except from this machine'} (devices in ${configDir()})`)
console.log(`[ccw] claude binary: ${executable ?? '(SDK bundled copy)'}`)
console.log(`[ccw] version ${updater.status.current}${updater.enabled ? '' : ' (not a git checkout: no update checks)'}`)

function shutdown(code: number): void {
  // Backstop only, in case handle.close() never settles. It protects no
  // session: close() kills every runner up front, and draining in-flight
  // requests is its own short timeout inside startServer.
  setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref()
  void handle.close().then(() => process.exit(code))
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown(0))
}
