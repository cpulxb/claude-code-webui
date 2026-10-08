import assert from 'node:assert/strict'
import { setImmediate as settle } from 'node:timers/promises'
import { test } from 'node:test'

// Exercise the real store and RPC client with controlled transport ordering.
// No browser, CLI process, credentials or network access are needed.
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
}
globalThis.window = { location: { search: '', href: 'http://localhost/' } }

let lastSocket
globalThis.WebSocket = class extends EventTarget {
  constructor() {
    super()
    lastSocket = this
  }

  open() { this.dispatchEvent(new Event('open')) }
  close() { this.dispatchEvent(new Event('close')) }
  receive(event) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })) }
}

let rpc
globalThis.fetch = async (_url, options) => {
  const { method, params } = JSON.parse(options.body)
  return new Response(JSON.stringify({ ok: true, result: await rpc(method, params) }))
}

const { useStore } = await import('../src/store/session.ts')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function permission(requestId) {
  return { requestId, toolUseId: `tool-${requestId}`, toolName: 'Write', input: {} }
}

function snapshot(overrides = {}) {
  return { live: true, status: 'running', pendingPermissions: [], backlog: [], ...overrides }
}

async function fixture(t) {
  let sessionId
  let creates = 0
  const snapshots = []
  const waiting = []
  rpc = async (method, params) => {
    switch (method) {
      case 'session.create':
        creates += 1
        return { sessionId: params.sessionId ?? params.resume }
      case 'history.projects':
        return { projects: [{ cwd: '/fixture', sessions: [{ sessionId, summary: 'fixture', lastModified: 0, live: true }] }] }
      case 'history.messages': return { messages: [] }
      case 'session.state': {
        const response = deferred()
        if (waiting.length) waiting.shift()(response)
        else snapshots.push(response)
        return response.promise
      }
      case 'session.commands': return { commands: [] }
      case 'session.models': return { models: [] }
      case 'session.contextUsage': return { usage: null }
      case 'session.send':
      case 'session.close':
      case 'permission.respond': return {}
      default: throw new Error(`Unexpected RPC: ${method}`)
    }
  }
  useStore.setState({ sessions: {}, activeId: null, projects: [] })
  sessionId = await useStore.getState().createSession('/fixture')
  await settle()
  const stop = useStore.getState().connect()
  t.after(stop)
  const socket = lastSocket
  return {
    sessionId,
    state: () => useStore.getState().sessions[sessionId],
    creates: () => creates,
    receive: (event) => socket.receive({ sessionId, ...event }),
    async reconnect() {
      socket.open()
      return snapshots.length ? snapshots.shift() : new Promise((resolve) => waiting.push(resolve))
    },
    nextSnapshot: () => snapshots.length ? Promise.resolve(snapshots.shift()) : new Promise((resolve) => waiting.push(resolve)),
  }
}

function result(sessionId) {
  return {
    type: 'sdk',
    message: {
      type: 'result', uuid: crypto.randomUUID(), session_id: sessionId, subtype: 'success',
      is_error: false, duration_ms: 1, num_turns: 1, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

test('a delayed reconnect snapshot cannot undo turn completion or permission resolution', { timeout: 3000 }, async (t) => {
  const f = await fixture(t)
  const request = permission('resolved')
  f.receive({ type: 'permission_request', request })
  const response = await f.reconnect()
  f.receive({ type: 'permission_resolved', requestId: request.requestId })
  f.receive(result(f.sessionId))
  response.resolve(snapshot({ pendingPermissions: [request] }))
  await settle()
  assert.equal(f.state().status, 'idle')
  assert.deepEqual(f.state().pendingPermissions, [])
})

test('a closed session stays detached and can be reopened after a stale snapshot', { timeout: 3000 }, async (t) => {
  const f = await fixture(t)
  const response = await f.reconnect()
  f.receive({ type: 'session_closed' })
  response.resolve(snapshot({ pendingPermissions: [permission('obsolete')] }))
  await settle()
  assert.equal(f.state().attached, false)
  assert.equal(f.state().closed, true)
  assert.equal(f.state().status, 'idle')
  assert.deepEqual(f.state().pendingPermissions, [])
  await useStore.getState().openSession(f.sessionId, '/fixture')
  await settle()
  assert.equal(f.creates(), 2)
  assert.equal(f.state().attached, true)
  assert.equal(f.state().closed, false)
})

test('a local send is newer than an idle reconnect snapshot', { timeout: 3000 }, async (t) => {
  const f = await fixture(t)
  const response = await f.reconnect()
  await useStore.getState().send('next turn')
  response.resolve(snapshot({ status: 'idle' }))
  await settle()
  assert.equal(f.state().status, 'running')
})

test('permission reconciliation merges offline prompts with newer additions and resolutions', { timeout: 3000 }, async (t) => {
  const f = await fixture(t)
  const resolved = permission('resolved')
  const missed = permission('missed-offline')
  const current = permission('new-request')
  const response = await f.reconnect()
  f.receive({ type: 'permission_resolved', requestId: resolved.requestId })
  f.receive({ type: 'permission_request', request: current })
  response.resolve(snapshot({ pendingPermissions: [resolved, missed] }))
  await settle()
  assert.deepEqual(f.state().pendingPermissions.map((p) => p.requestId).sort(), ['missed-offline', 'new-request'])
  assert.equal(f.state().status, 'running')
})

test('an optimistic permission response also invalidates that snapshot entry', { timeout: 3000 }, async (t) => {
  const f = await fixture(t)
  const request = permission('answered')
  const missed = permission('missed-offline')
  f.receive({ type: 'permission_request', request })
  const response = await f.reconnect()
  await useStore.getState().respondToPermission(request.requestId, { behavior: 'allow' })
  response.resolve(snapshot({ pendingPermissions: [request, missed] }))
  await settle()
  assert.deepEqual(f.state().pendingPermissions, [missed])
})

test('an older overlapping snapshot cannot undo one already applied', { timeout: 3000 }, async (t) => {
  const f = await fixture(t)
  const older = await f.reconnect()
  const newer = await f.reconnect()
  newer.resolve(snapshot({ status: 'idle' }))
  await settle()
  older.resolve(snapshot({ pendingPermissions: [permission('obsolete')] }))
  await settle()
  assert.equal(f.state().status, 'idle')
  assert.deepEqual(f.state().pendingPermissions, [])
})

test('streaming events do not prevent adopting state and replaying missing messages', { timeout: 3000 }, async (t) => {
  const f = await fixture(t)
  const response = await f.reconnect()
  f.receive({ type: 'sdk', message: {
    type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  } })
  response.resolve(snapshot({ backlog: [{
    type: 'assistant', uuid: 'missed-envelope', parent_tool_use_id: null,
    message: { id: 'missed-message', content: [{ type: 'text', text: 'missed offline' }] },
  }] }))
  await settle()
  assert.equal(f.state().status, 'running')
  assert.equal(f.state().transcript.nodes[0].blocks[0].text, 'missed offline')
})

test('a snapshot from a removed session cannot mutate a new local instance with the same id', { timeout: 3000 }, async (t) => {
  const f = await fixture(t)
  const oldResponse = await f.reconnect()
  await useStore.getState().closeSession(f.sessionId)
  const reopening = useStore.getState().openSession(f.sessionId, '/fixture')
  const newResponse = await f.nextSnapshot()
  newResponse.resolve(snapshot({ live: false, status: 'idle' }))
  await reopening
  await settle()
  oldResponse.resolve(snapshot({ pendingPermissions: [permission('obsolete')] }))
  await settle()
  assert.equal(f.state().status, 'idle')
  assert.equal(f.state().attached, true)
  assert.equal(f.state().closed, false)
  assert.deepEqual(f.state().pendingPermissions, [])
})
