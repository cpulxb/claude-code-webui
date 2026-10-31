import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import { applyHistoryMessage } from '../src/render/history.ts'
import { applyMessage, emptyTranscript } from '../src/render/nodes.ts'
import { decodeSerializedAssistantText } from '../src/utils/assistant-text.ts'
import { lastReplyText, transcriptMarkdown } from '../src/utils/transcript-markdown.ts'

// Transform the real TSX/CSS module without listening on a port or starting
// the app/CLI. Close the transformer before tests so it leaves no watcher.
const transformer = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
})
let AssistantMarkdown
try {
  ;({ AssistantMarkdown } = await transformer.ssrLoadModule('/src/components/chat/AssistantMarkdown.tsx'))
} finally {
  await transformer.close()
}
const render = (text, decodeSerialized = false) =>
  renderToStaticMarkup(createElement(AssistantMarkdown, { text, decodeSerialized }))

const answer = [
  '技能列表发生了变化：**昨天 61 个，现在 68 个**。',
  '## ✅ 一、实测可用',
  '| 能力 | 结果 |\n| --- | --- |\n| Markdown → PDF | ✅ 成功 |',
  '## ⚠️ 二、依赖不可用',
  '```python\nprint("\\n")\n```',
].join('\n\n')
const wrapped = JSON.stringify([{ text: answer }])

function assistant(text, uuid = 'a1') {
  return {
    type: 'assistant', uuid, session_id: 'fixture', parent_tool_use_id: null,
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text }] },
  }
}

test('serialized text reproduces the screenshot: inline formatting works but headings and tables do not', () => {
  const html = render(wrapped)
  assert.match(html, /<strong>昨天 61 个，现在 68 个<\/strong>/)
  assert.doesNotMatch(html, /<h2>|<table>/)
  assert.match(html, /\\n\\n##/)
  assert.match(html, /&quot;text&quot;/)
})

test('reply rendering restores headings/tables and offers the original serialized source', () => {
  const html = render(wrapped, true)
  assert.match(html, /<h2>✅ 一、实测可用<\/h2>/)
  assert.match(html, /<table>/)
  assert.match(html, /<td>Markdown → PDF<\/td>/)
  assert.match(html, /<details/)
  assert.match(html, /已还原序列化文本 · 查看原文/)
  // The original is selectable in the disclosure, not overwritten in history.
  assert.match(html, /<pre>\[\{&quot;text&quot;/)
  assert.equal(decodeSerializedAssistantText(wrapped), answer)
})

test('single and multiple complete text-only envelopes decode without losing body whitespace', () => {
  assert.equal(decodeSerializedAssistantText(`  ${JSON.stringify({ type: 'text', text: answer })}\n`), answer)
  assert.equal(decodeSerializedAssistantText(JSON.stringify([{ text: answer }, { type: 'text', text: '第二块' }])), `${answer}\n\n第二块`)
  assert.equal(decodeSerializedAssistantText(JSON.stringify([{ text: '\n## 标题\n正文\n' }])), '\n## 标题\n正文\n')
})

test('JSON-like active code-point escapes are accepted without eval or a global unescape', () => {
  const source = String.raw`[{"text":"## \u{26a0}\u{fe0f} 标题\n\n正文"}]`
  assert.throws(() => JSON.parse(source))
  assert.equal(decodeSerializedAssistantText(source), '## ⚠️ 标题\n\n正文')
  const mixed = String.raw`[{"text":"## \u{1f680} 标题\n\n路径 C:\\new\\temp，字面量 \\u{fe0f}，引号 \"ok\"，反斜线 \\\\"}]`
  assert.equal(decodeSerializedAssistantText(mixed), '## 🚀 标题\n\n路径 C:\\new\\temp，字面量 \\u{fe0f}，引号 "ok"，反斜线 \\\\')
})

test('valid JSON is decoded exactly once so literal escapes inside code stay literal', () => {
  const body = '## 转义示例\n\n`\\n`、`\\u{fe0f}`、`C:\\new\\temp`\n\n```js\nconst re = /\\b\\w+\\s/;\n```'
  assert.equal(decodeSerializedAssistantText(JSON.stringify([{ text: body }])), body)
  // Do not recursively reinterpret JSON examples nested inside a reply.
  const nested = JSON.stringify([{ text: wrapped }])
  assert.equal(decodeSerializedAssistantText(nested), nested)
})

test('ordinary Markdown, JSON data and code examples are never blanket-unescaped', () => {
  const examples = [
    answer,
    '## 标题\\n\\n不是实际换行',
    `示例：\n\n${wrapped}`,
    `\`\`\`json\n${wrapped}\n\`\`\``,
    `\`${wrapped}\``,
    JSON.stringify({ text: 'hello\nworld' }),
    JSON.stringify([{ text: 'hello' }]),
    JSON.stringify([{ text: 'hello' }, { text: 'world' }]),
    JSON.stringify({ text: answer, metadata: { source: 'data' } }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: answer }] }),
    JSON.stringify([{ type: 'text', text: answer }, { type: 'image', source: {} }]),
    JSON.stringify([{ type: 'thinking', text: answer }]),
    JSON.stringify([{ type: 'tool_use', text: answer }]),
    JSON.stringify([{ text: 1 }]),
    '[]', 'null', '42', JSON.stringify(answer),
  ]
  for (const source of examples) assert.equal(decodeSerializedAssistantText(source), source, source)
  // A JSON code example still gets its normal code block, not a decoded reply.
  const html = render(`\`\`\`json\n${wrapped}\n\`\`\``, true)
  assert.match(html, /<pre>/)
  assert.doesNotMatch(html, /<h2>|<table>|<details/)
})

test('partial, invalid and executable-looking envelopes stay intact', () => {
  const sources = [
    wrapped.slice(0, -1), `${wrapped} extra`,
    String.raw`[{"text":"## 标题\n\n\u{110000}"}]`,
    String.raw`[{"text":"## 标题\n\n\u{d800}"}]`,
    String.raw`[{"text":"## 标题\n\n\u{}"}]`,
    String.raw`[{"text":"## 标题\n\n\x41"}]`,
    `${wrapped}; globalThis.__markdownExecuted = true`,
  ]
  for (const source of sources) assert.equal(decodeSerializedAssistantText(source), source, source)
  assert.equal(globalThis.__markdownExecuted, undefined)
  for (const end of [1, 12, wrapped.length - 1]) {
    assert.equal(decodeSerializedAssistantText(wrapped.slice(0, end)), wrapped.slice(0, end))
  }
})

test('live messages, stream finalization and history retain the same original text', () => {
  const live = emptyTranscript()
  applyMessage(live, {
    type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  })
  for (const chunk of [wrapped.slice(0, 12), wrapped.slice(12, -1), wrapped.slice(-1)]) {
    applyMessage(live, {
      type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
    })
  }
  assert.equal(live.streaming.text, wrapped)
  assert.match(render(live.streaming.text, true), /<table>/)
  // A normal JSON transport round trip is not an extra text serialization.
  const event = JSON.parse(JSON.stringify({ type: 'sdk', message: assistant(wrapped) }))
  applyMessage(live, event.message)
  assert.equal(live.streaming, null)
  assert.equal(live.nodes[0].blocks[0].text, wrapped)

  const history = emptyTranscript()
  applyHistoryMessage(history, assistant(wrapped))
  assert.deepEqual(history.nodes, live.nodes)
  assert.equal(lastReplyText(history.nodes), answer)
})

test('copy and export match the restored reply without changing transcript data', () => {
  const transcript = emptyTranscript()
  applyMessage(transcript, assistant(wrapped))
  transcript.nodes[0].blocks.unshift({ type: 'thinking', text: 'not a reply' })
  const original = structuredClone(transcript)
  assert.equal(lastReplyText(transcript.nodes), answer)
  assert.equal(transcriptMarkdown(transcript.nodes, '测试'), `# 测试\n\n## Claude\n\n${answer}\n`)
  assert.deepEqual(transcript, original)
})

test('file previews stay opt-out, and user messages and tool output stay unchanged on export', () => {
  assert.doesNotMatch(render(wrapped), /<h2>|<table>|<details/)
  const nodes = [
    { kind: 'user', id: 'u', text: wrapped, attachments: 0 },
    { kind: 'localOutput', id: 'o', content: wrapped },
  ]
  const exported = transcriptMarkdown(nodes, '原始数据')
  assert.match(exported, /&?\[\{"text"/)
  assert.ok(exported.includes(wrapped))
  assert.equal(nodes[0].text, wrapped)
  assert.equal(nodes[1].content, wrapped)
})
