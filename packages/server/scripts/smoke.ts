/**
 * End-to-end smoke test for the server half, no browser involved.
 *
 * Boots the real server, opens the real downlink socket, drives one turn that
 * forces a tool call, and auto-approves it through the same `permission.respond`
 * RPC the UI uses. Run with: pnpm --filter @ccw/server smoke
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { API_EVENTS_PATH, API_RPC_PATH, type RpcMethod, type RpcParams, type RpcResponse, type ServerEvent } from '@ccw/shared'
import { WebSocket } from 'ws'

import { AuthGate } from '../src/auth/gate.ts'
import { startServer } from '../src/rpc/server.ts'
import { SessionManager } from '../src/session/manager.ts'

const HOST = '127.0.0.1'
const PORT = 3099
const BASE = `http://${HOST}:${PORT}`
const TIMEOUT_MS = 180_000

const manager = new SessionManager()
// Loopback requests need no pairing; a throwaway store keeps the real one untouched.
const auth = await AuthGate.open({ dir: await mkdtemp(join(tmpdir(), 'ccw-smoke-auth-')) })
const handle = await startServer({ host: HOST, port: PORT, manager, auth })
console.log(`[smoke] server up on ${BASE}`)

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResponse<M>> {
  const res = await fetch(`${BASE}${API_RPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  return (await res.json()) as RpcResponse<M>
}

// Overridable so the same script can reproduce a specific workspace's behaviour
// — hooks and settings are resolved per-cwd, and the model comes from whatever
// the active channel defaults to unless pinned here.
const created = await call('session.create', {
  cwd: process.env.CCW_SMOKE_CWD ?? process.cwd(),
  permissionMode: 'default',
  ...(process.env.CCW_SMOKE_MODEL ? { model: process.env.CCW_SMOKE_MODEL } : {}),
})
if (!created.ok) throw new Error(`session.create failed: ${created.error}`)
const { sessionId } = created.result
console.log(`[smoke] session ${sessionId}`)

const socket = new WebSocket(`ws://${HOST}:${PORT}${API_EVENTS_PATH}`)
await new Promise<void>((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})
console.log('[smoke] downlink open')

let sawToolUse = false
let sawPermission = false

const finished = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS)

  socket.on('message', (raw) => {
    const event = JSON.parse(String(raw)) as ServerEvent

    if (event.type === 'permission_request') {
      sawPermission = true
      console.log(`[smoke] permission asked: ${event.request.title ?? event.request.toolName}`)
      void call('permission.respond', {
        sessionId,
        requestId: event.request.requestId,
        decision: { behavior: 'allow' },
      })
      return
    }

    if (event.type === 'session_error') {
      clearTimeout(timer)
      reject(new Error(event.error))
      return
    }

    if (event.type !== 'sdk') return
    const message = event.message

    if (message.type === 'system' && message.subtype === 'init') {
      console.log(`[smoke] init: model=${message.model} tools=${message.tools.length} commands=${message.slash_commands.length}`)
      return
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.trim()) console.log(`[smoke] text: ${block.text.trim().slice(0, 120)}`)
        if (block.type === 'tool_use') {
          sawToolUse = true
          console.log(`[smoke] tool_use: ${block.name} ${JSON.stringify(block.input).slice(0, 100)}`)
        }
      }
      return
    }
    if (message.type === 'result') {
      clearTimeout(timer)
      console.log(`[smoke] result: ${message.subtype} in ${message.duration_ms}ms`)
      resolve()
    }
  })
})

await call('session.send', {
  sessionId,
  // Two tools on purpose: `date` is read-only and sails through, while the
  // write must go through `canUseTool` — that is the path the UI depends on.
  text: 'Run the `date` command, then write its output to /tmp/ccw-smoke-probe.txt. Nothing else.',
})
console.log('[smoke] prompt sent')

let failure: unknown
try {
  await finished
} catch (error) {
  failure = error
}

socket.close()
await handle.close()

if (failure) {
  console.error('[smoke] FAILED:', failure)
  process.exit(1)
}
console.log(`[smoke] PASS — tool_use=${sawToolUse} permission_prompt=${sawPermission}`)
process.exit(0)
