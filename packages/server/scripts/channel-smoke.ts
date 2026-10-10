/** Real CLI, two local mock providers, and an isolated settings directory. No external API calls. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as settle } from 'node:timers/promises'

import type { SDKMessage, ServerEvent } from '@ccw/shared'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

type RequestRecord = { provider: string; model: string; credential: string; hasPreviousTurn: boolean }
const records: RequestRecord[] = []
const firstRequest = deferred<void>()
const releaseFirst = deferred<void>()
let expectedBKey = 'fixture-b-key'

async function provider(name: 'A' | 'B') {
  const server = createServer((req, res) => {
    void (async () => {
      let raw = ''
      for await (const chunk of req) raw += String(chunk)
      const body = raw ? JSON.parse(raw) : {}
      if (req.url?.includes('count_tokens')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ input_tokens: 10 }))
        return
      }
      if (!req.url?.includes('/messages')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [], has_more: false }))
        return
      }
      const credential = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '')
      const expected = name === 'A' ? 'Bearer fixture-a-token' : expectedBKey
      if (credential !== expected) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Wrong fixture credential' } }))
        return
      }
      records.push({ provider: name, model: body.model, credential, hasPreviousTurn: JSON.stringify(body.messages).includes('Reply from A') })
      if (name === 'A') {
        firstRequest.resolve()
        await releaseFirst.promise
      }
      const message = {
        id: `msg_${name}_${records.length}`, type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: `Reply from ${name}` }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      if (!body.stream) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(message))
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      for (const event of [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Reply from ${name}` } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })().catch((error: unknown) => { res.destroy(error instanceof Error ? error : new Error(String(error))) })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const root = await mkdtemp(join(tmpdir(), 'ccw-channel-smoke-'))
const a = await provider('A')
const b = await provider('B')
// Isolate the child before importing the SDK: its config root is process-scoped.
for (const key of Object.keys(process.env)) {
  if (/^ANTHROPIC_/.test(key) || /^(https?|all)_proxy$/i.test(key)) delete process.env[key]
}
process.env.CLAUDE_CONFIG_DIR = root
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.NO_PROXY = '127.0.0.1,localhost'

const { SessionRunner } = await import('../src/session/runner.ts')
let runner: InstanceType<typeof SessionRunner> | undefined
let pendingTurn: ReturnType<typeof deferred<SDKMessage>> | undefined
const modelEvents: ServerEvent[] = []
const settings = (channel: 'A' | 'B') => ({
  model: 'haiku',
  env: {
    ANTHROPIC_BASE_URL: channel === 'A' ? a.url : b.url,
    ...(channel === 'A' ? { ANTHROPIC_AUTH_TOKEN: 'fixture-a-token' } : { ANTHROPIC_API_KEY: expectedBKey }),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: channel === 'A' ? 'claude-haiku-5-5' : 'claude-haiku-4-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: channel === 'A' ? 'Haiku A' : 'Haiku B',
  },
})
const writeSettings = (channel: 'A' | 'B') => writeFile(join(root, 'settings.json'), JSON.stringify(settings(channel)))
async function send(text: string) {
  const turn = deferred<SDKMessage>()
  pendingTurn = turn
  await runner!.send(text)
  const result = await turn.promise
  assert.equal(result.type, 'result')
  if (result.type === 'result') assert.equal(result.subtype, 'success')
}

let timeout: ReturnType<typeof setTimeout> | undefined
try {
  await Promise.race([
    (async () => {
      await writeSettings('A')
      runner = new SessionRunner({ cwd: root }, (event) => {
        if (event.type === 'session_models') modelEvents.push(event)
        if (event.type === 'session_error') pendingTurn?.reject(new Error(event.error))
        if (event.type === 'sdk' && event.message.type === 'result') pendingTurn?.resolve(event.message)
      })
      const originalId = runner.sessionId
      const initial = await runner.models()
      assert.equal(initial.model, 'haiku')
      assert.equal(initial.models.find((model) => model.value === 'haiku')?.resolvedModel, 'claude-haiku-5-5')

      const firstTurn = send('Check channel A.')
      await firstRequest.promise
      await writeSettings('B')
      const busy = await runner.models()
      assert.equal(busy.models.find((model) => model.value === 'haiku')?.resolvedModel, 'claude-haiku-5-5')
      releaseFirst.resolve()
      await firstTurn

      // No menu refresh here: send itself must update provider and mappings.
      await send('Continue the same conversation through channel B.')
      assert.equal(runner.sessionId, originalId)
      assert.deepEqual(records.slice(0, 2).map(({ provider, model }) => ({ provider, model })), [
        { provider: 'A', model: 'claude-haiku-5-5' },
        { provider: 'B', model: 'claude-haiku-4-5' },
      ])
      assert.equal(records[1]?.credential, expectedBKey)
      assert.equal(records[1]?.hasPreviousTurn, true)
      const updated = await runner.models()
      assert.equal(updated.model, 'haiku')
      assert.equal(updated.models.find((model) => model.value === 'haiku')?.displayName, 'Haiku B')
      assert.equal(updated.models.find((model) => model.value === 'haiku')?.resolvedModel, 'claude-haiku-4-5')
      const lastModels = modelEvents.at(-1)
      assert.equal(lastModels?.type === 'session_models' ? lastModels.model : undefined, 'haiku')

      expectedBKey = 'fixture-b-rotated-key'
      await writeSettings('B')
      await send('Check a credential-only change.')
      assert.equal(records.at(-1)?.credential, expectedBKey)
      assert.equal(JSON.stringify(modelEvents).includes('fixture-'), false)
      console.log('PASS: same conversation, A → B model and endpoint, bearer → API key, credential rotation, and deferred refresh during a turn, and the picker relabelled to channel B.')
    })(),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Channel smoke test timed out')), 30_000) }),
  ])
} finally {
  clearTimeout(timeout)
  releaseFirst.resolve()
  runner?.close()
  await Promise.all([a.close(), b.close()])
  await settle()
  // The CLI may still be flushing its transcript as it exits.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
