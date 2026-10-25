import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { SessionMessage } from '@ccw/shared'

import { locateSession, pageMessages, readMessagePage, readMessages } from '../src/history/sessions.ts'

const entry = (type: 'user' | 'assistant', uuid: string, message: unknown): SessionMessage => ({
  type,
  uuid,
  session_id: 's',
  message,
  parent_tool_use_id: null,
  parent_agent_id: null,
})
const prompt = (uuid: string, text: string): SessionMessage => entry('user', uuid, { role: 'user', content: text })
const result = (uuid: string, toolUseId: string): SessionMessage =>
  entry('user', uuid, { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] })
const say = (uuid: string, id: string, block: unknown): SessionMessage =>
  entry('assistant', uuid, { id, role: 'assistant', content: [block] })
const call = (uuid: string, id: string, toolUseId: string): SessionMessage =>
  say(uuid, id, { type: 'tool_use', id: toolUseId, name: 'Bash', input: {} })

// The CLI writes one entry per content block, so one API message spans
// several entries, and a parallel batch's results follow all of its calls.
const transcript = [
  prompt('u0', 'hi'), // 0
  say('a0', 'm1', { type: 'text', text: 'looking' }), // 1
  call('a1', 'm1', 't1'), // 2
  result('u1', 't1'), // 3
  call('a2', 'm2', 't2'), // 4
  call('a3', 'm2', 't3'), // 5
  result('u2', 't2'), // 6
  result('u3', 't3'), // 7
  say('a4', 'm3', { type: 'text', text: 'done' }), // 8
  prompt('u4', 'next'), // 9
  say('a5', 'm4', { type: 'text', text: 'sure' }), // 10
]
const uuids = (page: { messages: SessionMessage[] }): string[] => page.messages.map((message) => message.uuid)

test('without a cursor the page is the newest entries', () => {
  const page = pageMessages(transcript, 2)
  assert.deepEqual(uuids(page), ['u4', 'a5'])
  assert.equal(page.hasMore, true)
})

test('a page reaches back until no tool call straddles its start', () => {
  // Starting at u2 would leave t2 and t3's calls on the previous page.
  const page = pageMessages(transcript, 2, { before: 'a4' })
  assert.deepEqual(uuids(page), ['a2', 'a3', 'u2', 'u3'])
  assert.equal(page.hasMore, true)
})

test('a page does not start inside one assistant message', () => {
  // a1 is m1's second block; starting there would render m1 as two nodes.
  assert.deepEqual(uuids(pageMessages(transcript, 2, { before: 'a2' })), ['a0', 'a1', 'u1'])
})

test('paging from the newest entry back covers the transcript once, in order', () => {
  const pages: string[][] = []
  let before: string | undefined
  for (;;) {
    const page = pageMessages(transcript, 2, { before })
    pages.unshift(uuids(page))
    if (!page.hasMore) break
    before = page.messages[0]!.uuid
  }
  assert.deepEqual(pages.flat(), uuids({ messages: transcript }))
  assert.deepEqual(pages[0], ['u0'])
})

test('a call that never got its result does not pin the start', () => {
  // An interrupted or crashed turn can leave a call unanswered for good.
  const orphaned = [prompt('p0', 'go'), call('c0', 'n1', 'lost'), prompt('p1', 'again'), say('s1', 'n2', { type: 'text', text: 'ok' })]
  assert.deepEqual(uuids(pageMessages(orphaned, 2)), ['p1', 's1'])
})

test('an unknown cursor is an error, not an empty page', () => {
  assert.throws(() => pageMessages(transcript, 2, { before: 'gone' }), /not in the transcript/)
  assert.throws(() => pageMessages(transcript, 2, { after: 'gone' }), /not in the transcript/)
})

test('a newer page reaches forward until no tool call straddles its end', () => {
  // Ending at u2 would leave t3's result for the page after.
  const page = pageMessages(transcript, 2, { after: 'u1' })
  assert.deepEqual(uuids(page), ['a2', 'a3', 'u2', 'u3'])
  assert.equal(page.hasNewer, true)
})

test('a page around an entry holds it, mostly followed by what came after', () => {
  const page = pageMessages(transcript, 4, { around: 'u4' })
  assert.deepEqual(uuids(page), ['a4', 'u4', 'a5'])
  assert.deepEqual([page.hasMore, page.hasNewer], [true, false])
  // A subagent's spawn is found by its tool call, not only by uuid.
  assert.ok(uuids(pageMessages(transcript, 4, { around: 't3' })).includes('a3'))
})

test('a page around an entry the transcript lacks is the newest page', () => {
  assert.deepEqual(pageMessages(transcript, 2, { around: 'rewound-away' }), pageMessages(transcript, 2))
})

test('newer pages from a page around an entry cover the rest once, in order', () => {
  let page = pageMessages(transcript, 2, { around: 'a1' })
  const shown = uuids(page)
  while (page.hasNewer) {
    page = pageMessages(transcript, 2, { after: page.messages.at(-1)!.uuid })
    shown.push(...uuids(page))
  }
  const all = uuids({ messages: transcript })
  assert.deepEqual(shown, all.slice(all.indexOf(shown[0]!)))
  assert.equal(shown.at(-1), 'a5')
})

// Transcripts on disk, in the shape the CLI writes, for the readers above.
const config = await mkdtemp(join(tmpdir(), 'ccw-history-'))
process.env['CLAUDE_CONFIG_DIR'] = config
const project = join(config, 'projects', '-work-app')
await mkdir(project, { recursive: true })
test.after(() => rm(config, { recursive: true, force: true }))

async function writeTranscript(sessionId: string, entries: { type: 'user' | 'assistant'; message: unknown }[]): Promise<string> {
  const path = join(project, `${sessionId}.jsonl`)
  const lines = entries.map((entry, index) => ({
    parentUuid: index === 0 ? null : `${sessionId}-${index - 1}`, isSidechain: false, userType: 'external',
    cwd: '/work/app', sessionId, type: entry.type, uuid: `${sessionId}-${index}`, message: entry.message,
    timestamp: `2026-10-01T00:00:${String(index).padStart(2, '0')}.000Z`,
  }))
  await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  return path
}
const said = (text: string) => ({ type: 'user' as const, message: { role: 'user', content: text } })
const replied = (id: string, text: string) => ({ type: 'assistant' as const, message: { id, role: 'assistant', content: [{ type: 'text', text }] } })

test('base64 media is emptied but its blocks stay for the renderer to count', async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo='.repeat(1000) } }
  const sessionId = '00000000-0000-4000-8000-0000000000a1'
  await writeTranscript(sessionId, [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look' }, image] } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Shot', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot taken' }, image] }] } },
  ])
  const [prompt, , result] = await readMessages(sessionId, '/work/app')
  const blocks = (entry: SessionMessage | undefined) => (entry?.message as { content: Record<string, any>[] }).content
  assert.deepEqual(blocks(prompt)[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } })
  assert.deepEqual(blocks(result)[0]!['content'][0], { type: 'text', text: 'shot taken' })
  assert.equal(blocks(result)[0]!['content'][1].source.data, '')
})

test('older pages are cut from the read the newest page made; the newest page re-reads', async () => {
  const sessionId = '00000000-0000-4000-8000-0000000000a2'
  const entries = [said('one'), replied('m1', 'two'), said('three'), replied('m2', 'four'), said('five'), replied('m3', 'six')]
  const path = await writeTranscript(sessionId, entries)
  const newest = await readMessagePage(sessionId, '/work/app', 2)
  assert.deepEqual(newest.messages.map((entry) => entry.uuid), [`${sessionId}-4`, `${sessionId}-5`])

  // Gone from disk, yet the older page still comes: it was not read again.
  await rm(path)
  const older = await readMessagePage(sessionId, '/work/app', 2, { before: newest.messages[0]!.uuid })
  assert.deepEqual(older.messages.map((entry) => entry.uuid), [`${sessionId}-2`, `${sessionId}-3`])

  await writeTranscript(sessionId, [...entries, said('seven')])
  const grown = await readMessagePage(sessionId, '/work/app', 2)
  assert.deepEqual(grown.messages.map((entry) => entry.uuid), [`${sessionId}-5`, `${sessionId}-6`])
})

test('a session is located by its id alone, at the cwd its transcript records', async () => {
  const sessionId = '00000000-0000-4000-8000-0000000000a3'
  await writeTranscript(sessionId, [said('where is this')])
  assert.equal(await locateSession(sessionId), '/work/app')
  assert.equal(await locateSession('00000000-0000-4000-8000-0000000000ff'), null)
  // Ids come from the address bar; one that is not a UUID never reaches the disk.
  assert.equal(await locateSession('../../../etc/passwd'), null)
})

test('a newer page short of the read\'s end is cut from it; one that reaches the end re-reads', async () => {
  const sessionId = '00000000-0000-4000-8000-0000000000a4'
  const entries = [said('one'), replied('m1', 'two'), said('three'), replied('m2', 'four'), said('five'), replied('m3', 'six')]
  const path = await writeTranscript(sessionId, entries)
  const opened = await readMessagePage(sessionId, '/work/app', 2, { around: `${sessionId}-0` })
  assert.deepEqual(opened.messages.map((entry) => entry.uuid), [`${sessionId}-0`, `${sessionId}-1`])

  // Gone from disk, yet the next page still comes: it was not read again.
  await rm(path)
  const next = await readMessagePage(sessionId, '/work/app', 2, { after: `${sessionId}-1` })
  assert.deepEqual(next.messages.map((entry) => entry.uuid), [`${sessionId}-2`, `${sessionId}-3`])

  // The last page would end where the read ends, so it reads what was appended since.
  await writeTranscript(sessionId, [...entries, said('seven')])
  const last = await readMessagePage(sessionId, '/work/app', 4, { after: `${sessionId}-3` })
  assert.deepEqual(last.messages.map((entry) => entry.uuid), [`${sessionId}-4`, `${sessionId}-5`, `${sessionId}-6`])
  assert.equal(last.hasNewer, false)
})

// A compaction as the CLI writes it: the boundary starts a new chain, pointing
// back only through `logicalParentUuid`, and the summary hangs off it.
type Line = { uuid: string; parentUuid: string | null; type: string; [key: string]: unknown }
const line = (sessionId: string, n: number, parent: number | null, type: 'user' | 'assistant', text: string): Line => ({
  uuid: `${sessionId}-${n}`, parentUuid: parent === null ? null : `${sessionId}-${parent}`, type, isSidechain: false,
  sessionId, cwd: '/work/app', timestamp: `2026-10-01T00:00:${String(n).padStart(2, '0')}.000Z`,
  message: type === 'user' ? { role: 'user', content: text } : { id: `m${n}`, role: 'assistant', content: [{ type: 'text', text }] },
})
const compaction = (sessionId: string, n: number, before: number, kept: number[] = []): Line[] => [
  {
    uuid: `${sessionId}-${n}`, parentUuid: null, logicalParentUuid: `${sessionId}-${before}`, type: 'system', subtype: 'compact_boundary',
    content: 'Conversation compacted', isSidechain: false, sessionId, cwd: '/work/app', timestamp: `2026-10-01T00:00:${String(n).padStart(2, '0')}.000Z`,
    compactMetadata: {
      trigger: 'manual', preTokens: 100,
      // Kept verbatim: relinked after the summary.
      ...(kept.length > 0
        ? { preservedMessages: { anchorUuid: `${sessionId}-${n + 1}`, uuids: kept.map((index) => `${sessionId}-${index}`) } }
        : {}),
    },
  },
  {
    ...line(sessionId, n + 1, n, 'user', 'This session is being continued from a previous conversation.'),
    isCompactSummary: true, isVisibleInTranscriptOnly: true,
  },
]
async function writeLines(sessionId: string, lines: Line[]): Promise<void> {
  await writeFile(join(project, `${sessionId}.jsonl`), lines.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
}

test('what came before a compaction is read once a page reaches back past it', async () => {
  const sessionId = '00000000-0000-4000-8000-0000000000a5'
  await writeLines(sessionId, [
    line(sessionId, 0, null, 'user', 'one'), line(sessionId, 1, 0, 'assistant', 'two'),
    line(sessionId, 2, 1, 'user', 'three'), line(sessionId, 3, 2, 'assistant', 'four'),
    ...compaction(sessionId, 4, 3),
    line(sessionId, 6, 5, 'user', 'five'), line(sessionId, 7, 6, 'assistant', 'six'),
  ])
  const ids = (page: { messages: SessionMessage[] }) => page.messages.map((entry) => Number(entry.uuid.split('-').at(-1)))

  // The newest page fits the stretch since the compaction, yet there is more.
  const newest = await readMessagePage(sessionId, '/work/app', 10)
  assert.deepEqual(ids(newest), [4, 5, 6, 7])
  assert.equal(newest.hasMore, true)

  const older = await readMessagePage(sessionId, '/work/app', 10, { before: newest.messages[0]!.uuid })
  assert.deepEqual(ids(older), [0, 1, 2, 3])
  assert.equal(older.hasMore, false)

  // A link into the compacted part opens there.
  const linked = await readMessagePage(sessionId, '/work/app', 2, { around: `${sessionId}-1` })
  assert.ok(ids(linked).includes(1))
})

test('reading back past compactions follows the conversation, not a branch rewound away', async () => {
  const sessionId = '00000000-0000-4000-8000-0000000000a6'
  await writeLines(sessionId, [
    line(sessionId, 0, null, 'user', 'one'), line(sessionId, 1, 0, 'assistant', 'two'),
    line(sessionId, 2, 1, 'user', 'abandoned'), line(sessionId, 3, 2, 'assistant', 'abandoned'),
    // Rewound to after 1 and asked again.
    line(sessionId, 4, 1, 'user', 'three'), line(sessionId, 5, 4, 'assistant', 'four'),
    ...compaction(sessionId, 6, 5),
    line(sessionId, 8, 7, 'user', 'five'), line(sessionId, 9, 8, 'assistant', 'six'),
    ...compaction(sessionId, 10, 9),
    line(sessionId, 12, 11, 'user', 'seven'),
  ])
  let page = await readMessagePage(sessionId, '/work/app', 3)
  const shown = page.messages.map((entry) => entry.uuid)
  while (page.hasMore) {
    page = await readMessagePage(sessionId, '/work/app', 3, { before: page.messages[0]!.uuid })
    shown.unshift(...page.messages.map((entry) => entry.uuid))
  }
  assert.deepEqual(shown.map((uuid) => Number(uuid.split('-').at(-1))), [0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12])
})

test('messages a compaction kept show once, after its summary, as the newest page put them', async () => {
  const sessionId = '00000000-0000-4000-8000-0000000000a7'
  await writeLines(sessionId, [
    line(sessionId, 0, null, 'user', 'one'), line(sessionId, 1, 0, 'assistant', 'two'),
    line(sessionId, 2, 1, 'user', 'three'), line(sessionId, 3, 2, 'assistant', 'four'),
    ...compaction(sessionId, 4, 3, [2, 3]),
    line(sessionId, 6, 5, 'user', 'five'), line(sessionId, 7, 6, 'assistant', 'six'),
  ])
  let page = await readMessagePage(sessionId, '/work/app', 2)
  const shown = page.messages.map((entry) => entry.uuid)
  while (page.hasMore) {
    page = await readMessagePage(sessionId, '/work/app', 2, { before: page.messages[0]!.uuid })
    shown.unshift(...page.messages.map((entry) => entry.uuid))
  }
  assert.deepEqual(shown.map((uuid) => Number(uuid.split('-').at(-1))), [0, 1, 4, 5, 2, 3, 6, 7])
})
