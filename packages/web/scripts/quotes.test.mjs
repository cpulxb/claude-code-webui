import assert from 'node:assert/strict'
import { test } from 'node:test'

import { splitQuotes, withQuotes } from '../src/utils/quotes.ts'

test('a reply sends its quotes as blockquotes ahead of the typed text', () => {
  assert.equal(withQuotes([], '为什么？'), '为什么？')
  assert.equal(withQuotes(['还没到调超参的时候'], '为什么？'), '> 还没到调超参的时候\n\n为什么？')
  // Every line stays inside the quote, a blank one included.
  assert.equal(withQuotes(['第一段\n\n第二段'], '展开说说'), '> 第一段\n>\n> 第二段\n\n展开说说')
  // Two quotes are two blockquotes, not one run together.
  assert.equal(withQuotes(['甲', '乙'], '对比一下'), '> 甲\n\n> 乙\n\n对比一下')
  // Attachments can carry a message with no text of its own.
  assert.equal(withQuotes(['甲'], ''), '> 甲')
})

test('the bubble gets back exactly the quotes and text that were sent', () => {
  for (const [quotes, text] of [
    [[], '为什么？'],
    [['还没到调超参的时候'], '为什么？'],
    [['第一段\n\n第二段'], '展开说说\n\n> 这行在正文里，不是引用'],
    [['甲', '乙'], '对比一下'],
    [['甲'], ''],
  ]) {
    assert.deepEqual(splitQuotes(withQuotes(quotes, text)), { quotes, body: text })
  }
  // Typed by hand, without the space, it is still a quote.
  assert.deepEqual(splitQuotes('>原文\n回答'), { quotes: ['原文'], body: '回答' })
})
