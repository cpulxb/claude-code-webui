import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dirtyPaths, getDraft, putDraft, subscribeDrafts } from '../src/components/details/drafts.ts'

test('the tab strip hears when a file gains or loses its draft, not on every keystroke', () => {
  let heard = 0
  const unsubscribe = subscribeDrafts(() => heard++)
  try {
    const clean = dirtyPaths()
    putDraft('/work/server.mjs', { text: 'a', base: '' })
    assert.equal(heard, 1)
    const one = dirtyPaths()
    assert.notEqual(one, clean)
    assert.deepEqual([...one], ['/work/server.mjs'])

    // Typing on: the text is kept for the next mount, the snapshot is the same object.
    putDraft('/work/server.mjs', { text: 'ab', base: '' })
    assert.equal(heard, 1)
    assert.equal(dirtyPaths(), one)
    assert.deepEqual(getDraft('/work/server.mjs'), { text: 'ab', base: '' })

    putDraft('/work/server.mjs', null)
    assert.equal(heard, 2)
    assert.equal(dirtyPaths().size, 0)
    assert.equal(getDraft('/work/server.mjs'), undefined)

    // A clean file staying clean is not news either.
    putDraft('/work/server.mjs', null)
    assert.equal(heard, 2)
  } finally {
    unsubscribe()
  }
})
