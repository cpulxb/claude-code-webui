import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'

// Run FileView's save/edit callbacks with controlled hooks and RPC timing.
// CodeMirror and the DOM are outside this test: its public props are the output.
function fixture() {
  const slots = []
  const effects = []
  let at = 0
  let queued = false
  let tree
  let disk = 'original'
  let finishWrite
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const schedule = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; render() })
  }
  const hooks = {
    useState(initial) {
      const key = at++
      if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial
      return [slots[key], (value) => {
        const next = typeof value === 'function' ? value(slots[key]) : value
        if (!Object.is(next, slots[key])) { slots[key] = next; schedule() }
      }]
    },
    useRef(initial) {
      const key = at++
      slots[key] ??= { current: initial }
      return slots[key]
    },
    useCallback(fn, deps) {
      const key = at++
      if (!slots[key] || !same(slots[key].deps, deps)) slots[key] = { fn, deps }
      return slots[key].fn
    },
    useEffect(fn, deps) {
      const key = at++
      if (!slots[key] || !same(slots[key], deps)) { slots[key] = deps; effects.push(fn) }
    },
  }
  const jsx = (type, props) => ({ type, props })
  const { FileView } = compile('../src/components/details/FileView.tsx', {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../api/client.ts': { call: async (method, params) => {
      if (method === 'files.read') return { preview: { kind: 'text', content: disk, size: disk.length, truncated: false } }
      if (method === 'files.write') return new Promise((resolve) => {
        finishWrite = () => { disk = params.content; resolve({}) }
      })
      throw new Error(`Unexpected RPC: ${method}`)
    } },
    '../chat/AssistantMarkdown.tsx': { AssistantMarkdown: 'Markdown' },
    '../../utils/shares.ts': { rawFileHref: () => '' },
    '../Icons.tsx': {},
    './CodeEditor.tsx': { CodeEditor: 'Editor' },
    './drafts.ts': compile('../src/components/details/drafts.ts', {}),
    './ShareButton.tsx': { ShareButton: 'Share' },
  })
  function render() {
    at = 0
    tree = FileView({ path: '/fixture/notes.txt', turnStatus: 'idle', fsVersion: 0, onSaved() {} })
    for (const fn of effects.splice(0)) fn()
  }
  const editor = () => nodes(tree).find((node) => node.type === 'Editor').props
  const key = (value) => nodes(tree).find((node) => node.props?.onKeyDown).props.onKeyDown({ key: value, ctrlKey: value === 's', preventDefault() {} })
  render()
  return {
    editor,
    disk: () => disk,
    edit: (text) => editor().onChange(text),
    save: () => key('s'),
    discard: () => key('Escape'),
    finish: () => { assert.equal(typeof finishWrite, 'function'); finishWrite() },
  }
}

function compile(path, mocks) {
  const file = new URL(path, import.meta.url)
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}
  runInNewContext(code, { exports, require: (name) => {
    if (name in mocks) return mocks[name]
    if (name.endsWith('.css')) return { default: {} }
    throw new Error(`Unexpected module: ${name}`)
  } }, { filename: file.pathname })
  return exports
}

function nodes(node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...nodes(node.props?.children)]
}

for (const [name, edit, expected, dirty] of [
  ['typing more during a save stays unsaved', 'submitted plus more', 'submitted plus more', true],
  ['editing back to the old disk text during a save stays unsaved', 'original', 'original', true],
  ['a save without further edits leaves the editor clean', null, 'submitted', false],
  ['explicitly discarding during a save shows the saved file', 'discard', 'submitted', false],
]) {
  test(name, async () => {
    const f = fixture()
    await settle()
    f.edit('submitted')
    await settle()
    f.save()
    await settle()
    if (edit === 'discard') f.discard()
    else if (edit !== null) f.edit(edit)
    await settle()
    f.finish()
    await settle()
    assert.equal(f.disk(), 'submitted')
    assert.equal(f.editor().value, expected)
    assert.equal(f.editor().dirty, dirty)
  })
}
