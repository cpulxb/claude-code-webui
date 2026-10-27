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

const { followAddressBar, leaveSettings, useStore } = await import('../src/store/session.ts')

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
      case 'session.setModel':
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

test('model refresh adopts the CLI current selection before the first message', async (t) => {
  const f = await fixture(t)
  const previous = rpc
  const models = [{ value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'claude-haiku-4-5' }]
  rpc = (method, params) => method === 'session.models'
    ? { models, model: 'claude-haiku-4-5' }
    : previous(method, params)
  await useStore.getState().refreshModels()
  assert.deepEqual(f.state().models, models)
  assert.equal(f.state().model, 'claude-haiku-4-5')
})

test('a delayed model list cannot replace a more recent refresh', async (t) => {
  const f = await fixture(t)
  const previous = rpc
  const older = deferred()
  const newer = deferred()
  const pending = [older, newer]
  rpc = (method, params) => method === 'session.models' ? pending.shift().promise : previous(method, params)
  const first = useStore.getState().refreshModels()
  const second = useStore.getState().refreshModels()
  const models = [{ value: 'opus', resolvedModel: 'claude-fable-5-1[1M]', displayName: 'claude-fable-5-1' }]
  newer.resolve({ models, model: 'opus' })
  await second
  older.resolve({ models: [], model: 'old-model' })
  await first
  assert.deepEqual(f.state().models, models)
  assert.equal(f.state().model, 'opus')
})

test('an in-flight model refresh cannot undo a subsequent user selection', async (t) => {
  const f = await fixture(t)
  const previous = rpc
  const response = deferred()
  rpc = (method, params) => method === 'session.models' ? response.promise : previous(method, params)
  const refreshing = useStore.getState().refreshModels()
  await useStore.getState().setModel('sonnet')
  response.resolve({ models: [], model: 'opus' })
  await refreshing
  assert.equal(f.state().model, 'sonnet')
})

test('a newly created session appears in its project before the first message', async (t) => {
  const f = await fixture(t)
  const project = useStore.getState().projects.find((project) => project.cwd === '/fixture')
  assert.equal(project.sessions[0].sessionId, f.sessionId)
  assert.equal(project.sessions[0].live, true)
  assert.equal(project.sessions[0].summary, '')
  assert.equal(f.state().status, 'idle')
})

test('live sidebar updates add sessions from another tab and replace empty titles', async (t) => {
  const f = await fixture(t)
  const summary = { sessionId: 'other-tab', cwd: '/tmp', lastModified: Date.now() + 1000, summary: '', live: true }
  f.receive({ type: 'session_updated', sessionId: summary.sessionId, summary })
  assert.equal(useStore.getState().sessions[summary.sessionId], undefined)
  assert.equal(useStore.getState().projects[0].cwd, '/tmp')
  f.receive({ type: 'session_updated', sessionId: summary.sessionId, summary: { ...summary, summary: 'First prompt', firstPrompt: 'First prompt' } })
  const project = useStore.getState().projects[0]
  assert.equal(project.sessions.length, 1)
  assert.equal(project.sessions[0].summary, 'First prompt')
})

test('a delayed history read cannot hide a newly announced session', async (t) => {
  const f = await fixture(t)
  const previous = rpc
  const response = deferred()
  rpc = (method, params) => method === 'history.projects' ? response.promise : previous(method, params)
  const refreshing = useStore.getState().refreshProjects()
  const summary = { sessionId: 'new-session', cwd: '/tmp', lastModified: Date.now(), summary: 'Hello', live: true }
  f.receive({ type: 'session_updated', sessionId: summary.sessionId, summary })
  response.resolve({ projects: [] })
  await refreshing
  assert.equal(useStore.getState().projects[0].sessions[0].sessionId, summary.sessionId)
  assert.equal(useStore.getState().projects[0].sessions[0].summary, 'Hello')
})

test('an older history refresh cannot replace a newer sidebar snapshot', async (t) => {
  await fixture(t)
  const previous = rpc
  const older = deferred()
  const newer = deferred()
  const pending = [older, newer]
  rpc = (method, params) => method === 'history.projects' ? pending.shift().promise : previous(method, params)
  const first = useStore.getState().refreshProjects()
  const second = useStore.getState().refreshProjects()
  newer.resolve({ projects: [{ cwd: '/tmp', sessions: [{ sessionId: 'latest', summary: 'Latest', lastModified: 10 }] }] })
  await second
  older.resolve({ projects: [] })
  await first
  assert.equal(useStore.getState().projects[0].sessions[0].sessionId, 'latest')
})

test('a failed creation removes its optimistic sidebar row', async (t) => {
  const f = await fixture(t)
  const previous = rpc
  rpc = (method, params) => {
    if (method === 'session.create') throw new Error('creation failed')
    return previous(method, params)
  }
  await assert.rejects(useStore.getState().createSession('/tmp'), /creation failed/)
  assert.equal(useStore.getState().projects.some((project) => project.cwd === '/tmp'), false)
  assert.equal(useStore.getState().projects[0].sessions[0].sessionId, f.sessionId)
})

test('turn completion refreshes saved sidebar titles without needing a page reload', async (t) => {
  const f = await fixture(t)
  const previous = rpc
  let refreshed = false
  rpc = (method, params) => {
    if (method === 'history.projects') {
      refreshed = true
      return { projects: [{ cwd: '/fixture', sessions: [{ sessionId: f.sessionId, summary: 'Saved title', lastModified: Date.now(), live: true }] }] }
    }
    return previous(method, params)
  }
  f.receive(result(f.sessionId))
  await settle()
  assert.equal(refreshed, true)
  assert.equal(useStore.getState().projects[0].sessions[0].summary, 'Saved title')
})

test('provider model events update the active session and invalidate older model responses', async (t) => {
  const f = await fixture(t)
  const previous = rpc
  const response = deferred()
  rpc = (method, params) => method === 'session.models' ? response.promise : previous(method, params)
  const refreshing = useStore.getState().refreshModels()
  const models = [{ value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'claude-haiku-4-5' }]
  f.receive({ type: 'session_models', model: 'haiku', models })
  response.resolve({ model: 'claude-haiku-5-5', models: [] })
  await refreshing
  assert.equal(f.state().model, 'haiku')
  assert.deepEqual(f.state().models, models)
})

test('unchanged background model refreshes preserve menu row references', async (t) => {
  const f = await fixture(t)
  const previous = rpc
  rpc = (method, params) => method === 'session.models'
    ? { model: 'haiku', models: [{ value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku' }] }
    : previous(method, params)
  await useStore.getState().refreshModels()
  const rows = f.state().models
  await useStore.getState().refreshModels()
  assert.equal(f.state().models, rows)
})

// --- the address bar ---------------------------------------------------

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

/** One page of a saved transcript, cut as the server cuts it minus the tool-call rules. */
function pageOf(all, { limit = Infinity, before, after, around }) {
  const holds = (entry, id) => entry.uuid === id || (Array.isArray(entry.message.content) && entry.message.content.some((block) => block.id === id))
  const target = around === undefined ? -1 : all.findIndex((entry) => holds(entry, around))
  let start
  let end
  if (after !== undefined) {
    start = all.findIndex((entry) => entry.uuid === after) + 1
    end = Math.min(all.length, start + limit)
  } else if (target >= 0) {
    start = Math.max(0, target - 1)
    end = Math.min(all.length, start + limit)
  } else {
    end = before === undefined ? all.length : all.findIndex((entry) => entry.uuid === before)
    start = Math.max(0, end - limit)
  }
  return { messages: all.slice(start, end), hasMore: start > 0, hasNewer: end < all.length }
}

/** The `history.messages` params of each read since the last `saved`. */
let reads = []

/** Saved sessions by id → cwd, and their transcripts. Returns the ids the store asked the server to locate. */
function saved(cwds, messages = {}, runner = { live: false, status: 'idle', pendingPermissions: [], backlog: [] }) {
  const located = []
  reads = []
  rpc = async (method, params) => {
    switch (method) {
      case 'history.locate':
        located.push(params.sessionId)
        return { cwd: cwds[params.sessionId] ?? null }
      case 'history.messages':
        reads.push(params)
        return pageOf(messages[params.sessionId] ?? [], params)
      case 'history.subagents': return { agents: [] }
      case 'history.projects': return { projects: [] }
      case 'session.state': return runner
      case 'session.send': return {}
      case 'session.flags': return {}
      case 'session.create': return { sessionId: params.resume ?? params.sessionId }
      case 'session.commands': return { commands: [] }
      case 'session.models': return { models: [] }
      case 'session.contextUsage': return { usage: null }
      case 'session.close': return {}
      default: throw new Error(`Unexpected RPC: ${method}`)
    }
  }
  useStore.setState({ sessions: {}, activeId: null, projects: [] })
  storage.clear()
  return located
}

/** A saved conversation of `turns` prompt/reply pairs: u0, a0, u1, a1, … */
function conversation(sessionId, turns) {
  const entry = (type, uuid, message) => ({ type, uuid, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null, message })
  return Array.from({ length: turns }, (_, i) => [
    entry('user', `u${i}`, { role: 'user', content: `prompt ${i}` }),
    entry('assistant', `a${i}`, { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] }),
  ]).flat()
}

const texts = (sessionId) => JSON.stringify(useStore.getState().sessions[sessionId].transcript.nodes)

/** A history stack behind `window.history`, starting on `path`; `back` fires popstate as a browser does. */
function addressBar(t, path, { remount = false, state = null } = {}) {
  const entries = [path]
  const states = [state]
  let index = 0
  const listeners = new Set()
  const show = (url) => {
    const { origin, pathname, search, hash } = new URL(url, 'http://localhost')
    Object.assign(window.location, { origin, pathname, search, hash })
  }
  show(path)
  const back = () => {
    index -= 1
    show(entries[index])
    navigated()
  }
  window.history = {
    get state() { return states[index] },
    pushState: (state, _title, url) => {
      entries.splice(index + 1, Infinity, url)
      states.splice(index + 1, Infinity, state)
      index += 1
      show(url)
    },
    replaceState: (state, _title, url) => {
      entries[index] = url
      states[index] = state
      show(url)
    },
    back,
  }
  window.addEventListener = (_type, listener) => listeners.add(listener)
  window.removeEventListener = (_type, listener) => listeners.delete(listener)
  // StrictMode mounts, tears down and mounts again; the first open runs on.
  if (remount) followAddressBar()()
  t.after(followAddressBar())
  const navigated = () => {
    for (const listener of listeners) listener()
  }
  return {
    entries: () => [...entries],
    back,
    forward() {
      index += 1
      show(entries[index])
      navigated()
    },
    /** Following a link within the page: a new step, then popstate. */
    go(url) {
      window.history.pushState(null, '', url)
      navigated()
    },
  }
}

/** Lets an open's chain of requests run out. */
async function drain() {
  for (let i = 0; i < 30; i += 1) await settle()
}

test('a reload opens the session its address names, not the one another tab stored last', async (t) => {
  const located = saved({ [A]: '/a', [B]: '/b' })
  storage.set('ccw.activeSession', JSON.stringify({ sessionId: A, cwd: '/a' }))
  const bar = addressBar(t, `/s/${B}`)
  await drain()
  assert.equal(useStore.getState().activeId, B)
  assert.equal(useStore.getState().sessions[B].cwd, '/b')
  assert.deepEqual(located, [B])
  assert.deepEqual(bar.entries(), [`/s/${B}`])
})

test('a bare address opens the session last stored, without asking where it runs', async (t) => {
  const located = saved({ [A]: '/a' })
  storage.set('ccw.activeSession', JSON.stringify({ sessionId: A, cwd: '/a' }))
  const bar = addressBar(t, '/')
  await drain()
  assert.equal(useStore.getState().activeId, A)
  assert.deepEqual(located, [])
  assert.deepEqual(bar.entries(), [`/s/${A}`])
})

test('switching sessions is a step that back retraces without adding one', async (t) => {
  saved({ [A]: '/a', [B]: '/b' })
  const bar = addressBar(t, `/s/${A}`)
  await drain()
  await useStore.getState().openSession(B, '/b')
  await drain()
  assert.deepEqual(bar.entries(), [`/s/${A}`, `/s/${B}`])
  bar.back()
  await drain()
  assert.equal(useStore.getState().activeId, A)
  assert.deepEqual(bar.entries(), [`/s/${A}`, `/s/${B}`])
  assert.equal(window.location.pathname, `/s/${A}`)
})

test('an address that names no session is corrected to what is open', async (t) => {
  saved({})
  const bar = addressBar(t, `/s/${B}`)
  await drain()
  assert.equal(useStore.getState().activeId, null)
  assert.deepEqual(bar.entries(), ['/'])
})

test('a closed session leaves no step to come back to', async (t) => {
  saved({ [A]: '/a', [B]: '/b' })
  const bar = addressBar(t, `/s/${A}`)
  await drain()
  await useStore.getState().openSession(B, '/b')
  await drain()
  await useStore.getState().closeSession(B)
  assert.equal(useStore.getState().activeId, A)
  assert.ok(!bar.entries().includes(`/s/${B}`))
})

test('a subagent opens from its address, and back from the main thread returns to it', async (t) => {
  const spawn = {
    type: 'assistant', uuid: 'a1', session_id: A, parent_tool_use_id: null, parent_agent_id: null,
    message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Agent', input: { description: 'look', prompt: 'look around' } }] },
  }
  saved({ [A]: '/a' }, { [A]: [spawn] })
  const bar = addressBar(t, `/s/${A}?agent=toolu_x`)
  await drain()
  assert.equal(useStore.getState().sessions[A].viewAgent, 'toolu_x')
  await useStore.getState().openAgent(null)
  assert.deepEqual(bar.entries(), [`/s/${A}?agent=toolu_x`, `/s/${A}`])
  bar.back()
  await drain()
  assert.equal(useStore.getState().sessions[A].viewAgent, 'toolu_x')
  assert.equal(bar.entries().length, 2)
})

test('a remount while the address opens adds no step', async (t) => {
  const spawn = {
    type: 'assistant', uuid: 'a1', session_id: A, parent_tool_use_id: null, parent_agent_id: null,
    message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Agent', input: { description: 'look', prompt: 'look around' } }] },
  }
  saved({ [A]: '/a' }, { [A]: [spawn] })
  const bar = addressBar(t, `/s/${A}?agent=toolu_x`, { remount: true })
  await drain()
  assert.equal(useStore.getState().sessions[A].viewAgent, 'toolu_x')
  assert.deepEqual(bar.entries(), [`/s/${A}?agent=toolu_x`])
})

test('a tab whose address names nothing keeps the session another tab stored', async (t) => {
  saved({ [A]: '/a' })
  storage.set('ccw.activeSession', JSON.stringify({ sessionId: A, cwd: '/a' }))
  addressBar(t, `/s/${B}`)
  await drain()
  useStore.setState({ connection: 'open' })
  assert.equal(JSON.parse(storage.get('ccw.activeSession')).sessionId, A)
})

test('a link to a message opens the session there, with newer pages below it', async (t) => {
  saved({ [A]: '/a' }, { [A]: conversation(A, 150) })
  const bar = addressBar(t, `/s/${A}#m-u10`)
  await drain()
  const session = useStore.getState().sessions[A]
  assert.equal(session.anchor.id, 'u10')
  assert.ok(texts(A).includes('prompt 10'))
  assert.ok(session.newerCursor)
  assert.equal(reads[0].around, 'u10')
  assert.deepEqual(bar.entries(), [`/s/${A}#m-u10`])

  while (useStore.getState().sessions[A].newerCursor) await useStore.getState().loadNewerHistory(A)
  // Every prompt from the one linked to on, once each, in order.
  const prompts = useStore.getState().sessions[A].transcript.nodes.filter((node) => node.kind === 'user').map((node) => node.id)
  assert.deepEqual(prompts, Array.from({ length: 140 }, (_, i) => `u${i + 10}`))
})

test('every finished turn read back gets its stats row, after its last entry, page by page', async (t) => {
  saved({ [A]: '/a' }, { [A]: conversation(A, 150) })
  // As the server rebuilds them: one per turn that ends on the page.
  const read = rpc
  rpc = async (method, params) => {
    const answer = await read(method, params)
    if (method !== 'history.messages') return answer
    const turns = answer.messages
      .filter((message) => message.type === 'assistant')
      .map((message) => ({ after: message.uuid, durationMs: 1000, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }))
    return { ...answer, turns }
  }
  addressBar(t, `/s/${A}`)
  await drain()
  while (useStore.getState().sessions[A].historyCursor) await useStore.getState().loadOlderHistory(A)
  const nodes = useStore.getState().sessions[A].transcript.nodes
  assert.deepEqual(
    nodes.map((node) => node.kind),
    Array.from({ length: 150 }, () => ['user', 'assistant', 'result']).flat(),
  )
  assert.equal(nodes.at(-1).id, 'a149:result')
})

test('live output is held back while an older stretch is shown, then replayed at the end', async (t) => {
  const streamed = {
    type: 'assistant', uuid: 'live', session_id: A, parent_tool_use_id: null,
    message: { id: 'm-live', role: 'assistant', content: [{ type: 'text', text: 'streamed meanwhile' }], usage: { input_tokens: 1, output_tokens: 1 } },
  }
  saved({ [A]: '/a' }, { [A]: conversation(A, 150) }, { live: true, status: 'running', pendingPermissions: [], backlog: [streamed] })
  addressBar(t, `/s/${A}#m-u10`)
  t.after(useStore.getState().connect())
  await drain()
  lastSocket.receive({ sessionId: A, type: 'sdk', message: streamed })
  assert.ok(!texts(A).includes('streamed meanwhile'))
  assert.equal(useStore.getState().sessions[A].status, 'running')

  while (useStore.getState().sessions[A].newerCursor) await useStore.getState().loadNewerHistory(A)
  const nodes = useStore.getState().sessions[A].transcript.nodes
  assert.ok(JSON.stringify(nodes.at(-1)).includes('streamed meanwhile'))
})

test('sending from an older stretch goes to the end first', async (t) => {
  saved({ [A]: '/a' }, { [A]: conversation(A, 150) })
  const bar = addressBar(t, `/s/${A}#m-u10`)
  await drain()
  await useStore.getState().send('one more')
  await drain()
  const session = useStore.getState().sessions[A]
  assert.equal(session.newerCursor, null)
  assert.equal(session.anchor.id, null)
  assert.deepEqual(reads.at(-1), { sessionId: A, cwd: '/a', limit: 100 })
  assert.ok(JSON.stringify(session.transcript.nodes.at(-1)).includes('one more'))
  assert.deepEqual(bar.entries(), [`/s/${A}#m-u10`, `/s/${A}`])
})

test('a link to a message already read in moves the view, not the transcript', async (t) => {
  saved({ [A]: '/a' }, { [A]: conversation(A, 150) })
  const bar = addressBar(t, `/s/${A}`)
  await drain()
  const before = reads.length
  bar.go(`/s/${A}#m-u120`)
  await drain()
  assert.equal(useStore.getState().sessions[A].anchor.id, 'u120')
  assert.equal(reads.length, before)
  assert.equal(window.location.hash, '#m-u120')
})

test('a link to a message no longer in the session opens the newest page and says so', async (t) => {
  saved({ [A]: '/a' }, { [A]: conversation(A, 150) })
  const bar = addressBar(t, `/s/${A}#m-rewound`)
  await drain()
  const session = useStore.getState().sessions[A]
  assert.equal(session.anchor.id, null)
  assert.equal(session.newerCursor, null)
  assert.ok(texts(A).includes('已不在这个会话里'))
  assert.deepEqual(bar.entries(), [`/s/${A}`])
})

test('a subagent far back opens from its address', async (t) => {
  const transcript = conversation(A, 150)
  transcript.splice(3, 0, {
    type: 'assistant', uuid: 'spawn', session_id: A, parent_tool_use_id: null, parent_agent_id: null,
    message: { id: 'm-spawn', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_far', name: 'Agent', input: { description: 'early', prompt: 'look' } }] },
  })
  saved({ [A]: '/a' }, { [A]: transcript })
  addressBar(t, `/s/${A}?agent=toolu_far`)
  await drain()
  assert.equal(useStore.getState().sessions[A].viewAgent, 'toolu_far')
})

test('a message link names the session and the message', async (t) => {
  saved({ [A]: '/a' }, { [A]: conversation(A, 3) })
  addressBar(t, `/s/${A}`)
  await drain()
  assert.equal(await useStore.getState().messageLink('u1'), `http://localhost/s/${A}#m-u1`)
})

test('back and forward between a message and the end move the view between them', async (t) => {
  saved({ [A]: '/a' }, { [A]: conversation(A, 150) })
  const bar = addressBar(t, `/s/${A}#m-u10`)
  await drain()
  await useStore.getState().jumpToLatest(A)
  await drain()
  assert.deepEqual(bar.entries(), [`/s/${A}#m-u10`, `/s/${A}`])
  bar.back()
  await drain()
  assert.equal(useStore.getState().sessions[A].anchor.id, 'u10')
  bar.forward()
  await drain()
  const session = useStore.getState().sessions[A]
  assert.equal(session.anchor.id, null)
  assert.equal(session.newerCursor, null)
  assert.deepEqual(bar.entries(), [`/s/${A}#m-u10`, `/s/${A}`])
})

test('the settings page is a step over the session, and leaving it steps back', async (t) => {
  saved({ [A]: '/a' })
  const bar = addressBar(t, `/s/${A}`)
  await drain()
  useStore.getState().setSettingsOpen(true)
  assert.deepEqual(bar.entries(), [`/s/${A}`, '/settings'])
  leaveSettings()
  await drain()
  assert.equal(useStore.getState().settingsOpen, false)
  assert.equal(useStore.getState().activeId, A)
  assert.equal(window.location.pathname, `/s/${A}`)
  assert.deepEqual(bar.entries(), [`/s/${A}`, '/settings'])
})

test('back and forward step off and onto the settings page', async (t) => {
  saved({ [A]: '/a' })
  const bar = addressBar(t, `/s/${A}`)
  await drain()
  useStore.getState().setSettingsOpen(true)
  bar.back()
  await drain()
  assert.equal(useStore.getState().settingsOpen, false)
  bar.forward()
  await drain()
  assert.equal(useStore.getState().settingsOpen, true)
  assert.equal(useStore.getState().activeId, A)
  assert.deepEqual(bar.entries(), [`/s/${A}`, '/settings'])
})

test('a reload on the settings page shows it over the session last open', async (t) => {
  const located = saved({ [A]: '/a' })
  storage.set('ccw.activeSession', JSON.stringify({ sessionId: A, cwd: '/a' }))
  const bar = addressBar(t, '/settings')
  await drain()
  assert.equal(useStore.getState().settingsOpen, true)
  assert.equal(useStore.getState().activeId, A)
  assert.deepEqual(located, [])
  assert.deepEqual(bar.entries(), ['/settings'])
  // Nothing behind it in this tab to step back to: leaving opens the session.
  leaveSettings()
  await drain()
  assert.equal(useStore.getState().settingsOpen, false)
  assert.deepEqual(bar.entries(), ['/settings', `/s/${A}`])
})

test('a reload keeps a settings page opened within the tab stepping back', async (t) => {
  saved({ [A]: '/a' })
  const bar = addressBar(t, `/s/${A}`)
  await drain()
  useStore.getState().setSettingsOpen(true)
  // The reload: a fresh mount on the same entry, whose state the browser keeps.
  t.after(followAddressBar())
  await drain()
  leaveSettings()
  await drain()
  assert.equal(useStore.getState().settingsOpen, false)
  assert.equal(window.location.pathname, `/s/${A}`)
  assert.deepEqual(bar.entries(), [`/s/${A}`, '/settings'])
})

test('a session closing beneath the settings page leaves the address on it', async (t) => {
  saved({ [A]: '/a', [B]: '/b' })
  const bar = addressBar(t, `/s/${A}`)
  await drain()
  await useStore.getState().openSession(B, '/b')
  await drain()
  useStore.getState().setSettingsOpen(true)
  await useStore.getState().closeSession(B)
  assert.equal(useStore.getState().activeId, A)
  assert.equal(window.location.pathname, '/settings')
  assert.deepEqual(bar.entries(), [`/s/${A}`, `/s/${B}`, '/settings'])
})
