import { SHARE_ENV, Worker } from 'node:worker_threads'

import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'

type Reply = { sessions: SDKSessionInfo[] } | { error: string }

/**
 * Wraps `run` so overlapping calls share work. A call while none runs starts
 * one. Calls made while one runs share a single run started after it, since
 * the running one may have read before what they ask about was written — so a
 * burst costs at most two runs, and no caller gets a result older than its call.
 */
export function coalesce<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null
  let next: Promise<T> | null = null
  const start = (): Promise<T> => {
    running = run().finally(() => {
      running = null
    })
    return running
  }
  return () => {
    if (next) return next
    if (!running) return start()
    const after = (): Promise<T> => {
      next = null
      return start()
    }
    next = running.then(after, after)
    return next
  }
}

let worker: Worker | null = null
/** The read the worker is on: one at a time, as `listSavedSessions` asks for them. */
let pending: { resolve: (sessions: SDKSessionInfo[]) => void; reject: (error: Error) => void } | null = null

function spawn(): Worker {
  // SHARE_ENV: CLAUDE_CONFIG_DIR is read per call, and the tests move it.
  const spawned = new Worker(new URL('./session-list.worker.ts', import.meta.url), { env: SHARE_ENV })
  // Idle, it must not keep the process alive; reading, it must, as nothing else may.
  spawned.unref()
  const finish = (): typeof pending => {
    const current = pending
    pending = null
    spawned.unref()
    return current
  }
  spawned.on('message', (reply: Reply) => {
    const current = finish()
    if ('error' in reply) current?.reject(new Error(reply.error))
    else current?.resolve(reply.sessions)
  })
  // A crashed worker is dropped; the next read starts another.
  const drop = (error: Error): void => {
    if (worker === spawned) worker = null
    finish()?.reject(error)
  }
  spawned.on('error', drop)
  spawned.on('exit', (code) => drop(new Error(`the session list worker exited with code ${code}`)))
  return spawned
}

function readInWorker(): Promise<SDKSessionInfo[]> {
  const current = (worker ??= spawn())
  return new Promise((resolve, reject) => {
    pending = { resolve, reject }
    current.ref()
    current.postMessage(null)
  })
}

/**
 * Every saved session, as the SDK's `listSessions` reads them. It parses the
 * head and tail of each transcript synchronously — about a second for two
 * thousand of them — which on the main thread would stall every request,
 * stream and terminal the server serves, so it runs in a worker kept for the
 * process. The sidebar asks on every connect and every finished turn, per tab.
 */
export const listSavedSessions = coalesce(readInWorker)
