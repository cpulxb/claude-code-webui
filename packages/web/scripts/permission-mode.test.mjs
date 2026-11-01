import assert from 'node:assert/strict'
import { setImmediate as settle } from 'node:timers/promises'
import { beforeEach, test } from 'node:test'

// The mode a session starts in: the one last picked in this browser, the one
// its transcript recorded, or — with neither — the one the server read from
// settings.json. Real store and RPC client, no CLI behind them.
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
globalThis.window = { location: { search: '', href: 'http://localhost/' } }
globalThis.WebSocket = class extends EventTarget {}

const MODE_KEY = 'ccw.permissionMode'
const SAVED = '00000000-0000-4000-8000-00000000000a'

/** The `session.create` params the store sent, in order. */
let creates
/** What the server starts a mode-less session in, as if read from settings.json. */
let settingsMode
/** The mode the saved session's transcript recorded, if any. */
let recorded
/** Holds `session.create` open until released, when set. */
let holdCreate

globalThis.fetch = async (_url, options) => {
  const { method, params } = JSON.parse(options.body)
  return new Response(JSON.stringify({ ok: true, result: await rpc(method, params) }))
}

async function rpc(method, params) {
  switch (method) {
    case 'session.create':
      creates.push(params)
      await holdCreate
      return { sessionId: params.resume ?? params.sessionId, permissionMode: params.permissionMode ?? settingsMode }
    case 'history.messages': return { messages: [], hasMore: false, hasNewer: false, ...(recorded ? { permissionMode: recorded } : {}) }
    case 'history.subagents': return { agents: [] }
    case 'history.projects': return { projects: [] }
    case 'session.state': return { live: false, status: 'idle', pendingPermissions: [], backlog: [] }
    case 'session.commands': return { commands: [] }
    case 'session.models': return { models: [] }
    case 'session.contextUsage': return { usage: null }
    case 'session.flags':
    case 'session.setPermissionMode': return {}
    default: throw new Error(`Unexpected RPC: ${method}`)
  }
}

const { useStore } = await import('../src/store/session.ts')

const mode = (sessionId) => useStore.getState().sessions[sessionId]?.permissionMode

async function until(check) {
  for (let i = 0; i < 100 && !check(); i += 1) await settle()
  assert.ok(check(), 'timed out')
}

beforeEach(() => {
  storage.clear()
  creates = []
  settingsMode = 'bypassPermissions'
  recorded = undefined
  holdCreate = undefined
  useStore.setState({ sessions: {}, activeId: null, projects: [] })
})

test('a browser that never picked a mode starts a new session in the one settings.json names', async () => {
  const sessionId = await useStore.getState().createSession('/project')
  assert.equal(creates.length, 1)
  assert.equal('permissionMode' in creates[0], false, 'the server is left to read the settings')
  assert.equal(mode(sessionId), 'bypassPermissions')
  // Not a pick: the next session follows settings.json again, even if it changed.
  assert.equal(storage.has(MODE_KEY), false)
})

test('with nothing usable in settings.json the session starts manual', async () => {
  settingsMode = 'default'
  const sessionId = await useStore.getState().createSession('/project')
  assert.equal(mode(sessionId), 'default')
})

test('a mode picked in this browser still beats settings.json', async () => {
  storage.set(MODE_KEY, 'plan')
  const sessionId = await useStore.getState().createSession('/project')
  assert.equal(creates[0].permissionMode, 'plan')
  assert.equal(mode(sessionId), 'plan')
})

test('a remembered value that is no mode counts as none remembered', async () => {
  storage.set(MODE_KEY, 'yolo')
  const sessionId = await useStore.getState().createSession('/project')
  assert.equal('permissionMode' in creates[0], false)
  assert.equal(mode(sessionId), 'bypassPermissions')
})

test("a mode picked while the session starts is not undone by the server's answer", async () => {
  let release
  holdCreate = new Promise((resolve) => { release = resolve })
  const creating = useStore.getState().createSession('/project')
  await until(() => creates.length === 1)
  const sessionId = useStore.getState().activeId
  assert.equal(mode(sessionId), 'default', 'a guess until the server answers')
  await useStore.getState().setPermissionMode('acceptEdits')
  release()
  await creating
  assert.equal(mode(sessionId), 'acceptEdits')
  assert.equal(storage.get(MODE_KEY), 'acceptEdits')
})

test('a saved session resumes in the mode its transcript recorded, not the settings one', async () => {
  recorded = 'plan'
  await useStore.getState().openSession(SAVED, '/project')
  await until(() => creates.length === 1 && useStore.getState().sessions[SAVED]?.attached)
  assert.equal(creates[0].resume, SAVED)
  assert.equal(creates[0].permissionMode, 'plan')
  assert.equal(mode(SAVED), 'plan')
})

test('a saved session that recorded no mode resumes in the settings one', async () => {
  await useStore.getState().openSession(SAVED, '/project')
  await until(() => creates.length === 1 && useStore.getState().sessions[SAVED]?.attached)
  assert.equal(creates[0].resume, SAVED)
  assert.equal('permissionMode' in creates[0], false)
  assert.equal(mode(SAVED), 'bypassPermissions')
})

test('a saved session that recorded no mode resumes in the one picked in this browser', async () => {
  storage.set(MODE_KEY, 'acceptEdits')
  await useStore.getState().openSession(SAVED, '/project')
  await until(() => creates.length === 1 && useStore.getState().sessions[SAVED]?.attached)
  assert.equal(creates[0].permissionMode, 'acceptEdits')
  assert.equal(mode(SAVED), 'acceptEdits')
})
