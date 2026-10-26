import { parentPort } from 'node:worker_threads'

import { listSessions } from '@anthropic-ai/claude-agent-sdk'

// The SDK's session list, read off the server's main thread: see session-list.ts.
const port = parentPort
if (!port) throw new Error('session-list.worker.ts runs as a worker thread')

port.on('message', () => {
  listSessions({ includeProgrammatic: true }).then(
    (sessions) => port.postMessage({ sessions }),
    (error: unknown) => port.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  )
})
