import assert from 'node:assert/strict'
import { setImmediate as settle } from 'node:timers/promises'
import { test } from 'node:test'

// The browser-side stand-ins for CLI commands the SDK does not offer, and the
// `!` shell mode. Real store and RPC client; the transport is scripted.
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
}
globalThis.window = Object.assign(new EventTarget(), { location: { search: '', href: 'http://localhost/' } })
globalThis.WebSocket = class extends EventTarget {
  close() {}
}

let rpc
let calls = []
globalThis.fetch = async (_url, options) => {
  const { method, params } = JSON.parse(options.body)
  calls.push({ method, params })
  try {
    return new Response(JSON.stringify({ ok: true, result: await rpc(method, params) }))
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }))
  }
}

const { useStore } = await import('../src/store/session.ts')
const { exportFileName, parseLocalCommand, runLocalCommand, SHOW_INFO_EVENT } = await import('../src/utils/local-commands.ts')
const { lastReplyText, transcriptMarkdown } = await import('../src/utils/transcript-markdown.ts')
const { applyHistoryMessage, listUserPromptUuids } = await import('../src/render/history.ts')
const { emptyTranscript } = await import('../src/render/nodes.ts')
const { bashPrompt } = await import('../src/render/bash.ts')
const { sessionTitle } = await import('../src/utils/session-title.ts')

/** A created, attached session; `handlers` overrides individual RPCs. */
async function fixture(handlers = {}) {
  rpc = async (method, params) => {
    if (handlers[method]) return handlers[method](params)
    switch (method) {
      case 'session.create': return { sessionId: params.sessionId ?? params.resume }
      case 'history.projects': return { projects: [] }
      case 'history.messages': return { messages: [] }
      case 'session.state': return { live: false, status: 'idle', pendingPermissions: [], backlog: [] }
      case 'session.commands': return { commands: [] }
      case 'session.models': return { models: [] }
      case 'session.contextUsage': return { usage: null }
      case 'session.send': return {}
      default: throw new Error(`Unexpected RPC: ${method}`)
    }
  }
  useStore.setState({ sessions: {}, activeId: null, projects: [] })
  const sessionId = await useStore.getState().createSession('/fixture')
  await settle()
  calls = []
  return { sessionId, nodes: () => useStore.getState().sessions[sessionId].transcript.nodes }
}

const view = (nodes) => nodes.map((node) => [node.kind, node.text ?? node.content])

test('local commands parse by name or alias and leave everything else alone', () => {
  assert.deepEqual(parseLocalCommand('/rename  新 名字 '), { name: 'rename', args: '新 名字' })
  assert.deepEqual(parseLocalCommand('/fork'), { name: 'branch', args: '' })
  assert.deepEqual(parseLocalCommand('/export notes'), { name: 'export', args: 'notes' })
  assert.equal(parseLocalCommand('/renamed x'), null)
  assert.equal(parseLocalCommand('/context'), null)
  assert.equal(parseLocalCommand('please /rename this'), null)
})

test('export file names keep a given name and default to a timestamp', () => {
  assert.equal(exportFileName('notes', 'abcdef123456'), 'notes.md')
  assert.equal(exportFileName('notes.MD', 'abcdef123456'), 'notes.MD')
  assert.equal(exportFileName('', 'abcdef123456', new Date(2026, 9, 22, 8, 5)), 'claude-20261022-0805-abcdef12.md')
})

test('the markdown export keeps one heading per turn, fences output and drops thinking', () => {
  const nodes = [
    { kind: 'user', id: 'u1', text: '读一下 a.js', attachments: 0 },
    { kind: 'assistant', id: 'a1', blocks: [{ type: 'thinking', text: 'private' }, { type: 'text', text: '好的' }] },
    { kind: 'tool', id: 't1', toolUseId: 't1', name: 'Read', input: { file_path: '/tmp/a.js' }, status: 'done' },
    { kind: 'assistant', id: 'a2', blocks: [{ type: 'text', text: '它打印 hi' }] },
    { kind: 'user', id: 'u2', text: '! ls', attachments: 0 },
    { kind: 'localOutput', id: 'o2', content: 'a.js\n```' },
    { kind: 'notice', id: 'n1', level: 'info', text: 'ui only' },
  ]
  assert.equal(
    transcriptMarkdown(nodes, '标题'),
    ['# 标题', '## 用户', '读一下 a.js', '## Claude', '好的', '> 🔧 Read · `/tmp/a.js`', '它打印 hi', '## 用户', '! ls', '````\na.js\n```\n````'].join('\n\n') + '\n',
  )
  assert.equal(lastReplyText(nodes), '它打印 hi')
  assert.equal(lastReplyText(nodes.slice(0, 1)), null)
})

test('`!` commands replay identically from WebUI and terminal transcripts', () => {
  // The WebUI sends command and output as one prompt; the terminal writes two entries.
  const combined = [{ type: 'user', uuid: 'w1', message: { role: 'user', content: bashPrompt('git status', '?? a.js', '') } }]
  const split = [
    { type: 'user', uuid: 'c1', message: { role: 'user', content: '<bash-input>git status</bash-input>' } },
    { type: 'user', uuid: 'c2', message: { role: 'user', content: '<bash-stdout>?? a.js</bash-stdout><bash-stderr></bash-stderr>' } },
  ]
  const web = emptyTranscript()
  const cli = emptyTranscript()
  for (const entry of combined) applyHistoryMessage(web, entry)
  for (const entry of split) applyHistoryMessage(cli, entry)

  assert.deepEqual(view(web.nodes), [['user', '! git status'], ['localOutput', '?? a.js']])
  assert.deepEqual(view(cli.nodes), view(web.nodes))
  // Rewind targets: the command is a prompt, the terminal's output entry is not.
  assert.deepEqual(listUserPromptUuids(combined), ['w1'])
  assert.deepEqual(listUserPromptUuids(split), ['c1'])

  const quiet = emptyTranscript()
  applyHistoryMessage(quiet, { type: 'user', uuid: 'q', message: { role: 'user', content: bashPrompt('true', '', '') } })
  applyHistoryMessage(quiet, { type: 'user', uuid: 'f', message: { role: 'user', content: bashPrompt('false', '', 'Exit code 1') } })
  assert.deepEqual(view(quiet.nodes).filter(([kind]) => kind === 'localOutput'), [['localOutput', '(无输出)'], ['localOutput', 'Exit code 1']])
})

test('a shell command shows its output, then goes to the model in the terminal format', async () => {
  const f = await fixture({ 'session.shell': () => ({ stdout: 'a.js', stderr: '' }) })
  await useStore.getState().runShell('ls')

  assert.deepEqual(calls.map((call) => call.method), ['session.shell', 'session.send'])
  assert.deepEqual(calls[0].params, { sessionId: f.sessionId, command: 'ls' })
  assert.equal(calls[1].params.text, bashPrompt('ls', 'a.js', ''))
  assert.deepEqual(view(f.nodes()), [['user', '! ls'], ['localOutput', 'a.js']])
  assert.match(f.nodes()[0].id, /^local-/)
  assert.equal(useStore.getState().sessions[f.sessionId].status, 'running')
})

test('a failed shell command leaves no bubble behind and sends nothing', async () => {
  const f = await fixture({ 'session.shell': () => { throw new Error('spawn failed') } })
  await useStore.getState().runShell('ls')

  assert.deepEqual(calls.map((call) => call.method), ['session.shell'])
  assert.deepEqual(f.nodes().map((node) => node.kind), ['notice'])
  assert.match(f.nodes()[0].text, /spawn failed/)
  assert.equal(useStore.getState().sessions[f.sessionId].status, 'idle')
})

test('/rename renames on disk and re-reads the sidebar; a bare /rename only explains itself', async () => {
  const f = await fixture({ 'session.rename': () => ({}) })
  await runLocalCommand({ name: 'rename', args: '' })
  assert.deepEqual(calls, [])
  assert.equal(f.nodes().at(-1).level, 'error')

  await runLocalCommand({ name: 'rename', args: '新名字' })
  assert.deepEqual(calls[0], { method: 'session.rename', params: { sessionId: f.sessionId, title: '新名字', cwd: '/fixture' } })
  assert.ok(calls.some((call) => call.method === 'history.projects'))
  assert.match(f.nodes().at(-1).text, /新名字/)
})

test('the sidebar renames a session it has not opened, and shows the name before the list is read back', async () => {
  await fixture({ 'session.rename': () => ({}) })
  const other = { sessionId: 'other', summary: '第一条提示', lastModified: 1, cwd: '/elsewhere', firstPrompt: '第一条提示' }
  useStore.setState({ projects: [{ cwd: '/elsewhere', sessions: [other] }] })

  await useStore.getState().renameSavedSession('other', '/elsewhere', '  新名字 ')
  assert.deepEqual(calls, [{ method: 'session.rename', params: { sessionId: 'other', title: '  新名字 ', cwd: '/elsewhere' } }])
  assert.equal(useStore.getState().projects[0].sessions[0].summary, '新名字')

  // A failed rename leaves the list alone and reaches the caller.
  rpc = async () => {
    throw new Error('not found')
  }
  await assert.rejects(useStore.getState().renameSavedSession('other', '/elsewhere', '再改'), /not found/)
  assert.equal(useStore.getState().projects[0].sessions[0].summary, '新名字')
})

test('an untitled session is shown by the first fifty characters of its prompt', () => {
  assert.equal(sessionTitle(undefined), '新会话')
  assert.equal(sessionTitle('  '), '新会话')
  assert.equal(sessionTitle('修复\n  登录页'), '修复 登录页')
  assert.equal(sessionTitle('字'.repeat(50)), '字'.repeat(50))
  assert.equal(sessionTitle(`${'字'.repeat(49)}😀尾巴`), `${'字'.repeat(49)}😀…`)
})

test('/branch opens the fork and leaves the original untouched', async () => {
  const f = await fixture({ 'session.fork': () => ({ sessionId: 'forked-id' }) })
  await runLocalCommand({ name: 'branch', args: '实验' })

  assert.deepEqual(calls[0], { method: 'session.fork', params: { sessionId: f.sessionId, cwd: '/fixture', title: '实验' } })
  const state = useStore.getState()
  assert.equal(state.activeId, 'forked-id')
  assert.equal(state.sessions['forked-id'].cwd, '/fixture')
  assert.match(state.sessions['forked-id'].transcript.nodes.at(-1).text, /分叉/)
  assert.ok(state.sessions[f.sessionId])
})

test('/mcp, /skills, /plugins and /status ask the details panel for their section', async () => {
  await fixture()
  const seen = []
  const listener = (event) => seen.push(event.detail)
  window.addEventListener(SHOW_INFO_EVENT, listener)
  for (const text of ['/mcp', '/skills', '/plugin', '/status']) await runLocalCommand(parseLocalCommand(text))
  window.removeEventListener(SHOW_INFO_EVENT, listener)
  assert.deepEqual(seen, ['mcp', 'skills', 'plugins', 'status'])
})
