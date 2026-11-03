import assert from 'node:assert/strict'
import { test } from 'node:test'

import { afterSave, dirtyPaths, getDraft, putDraft, subscribeDrafts } from '../src/components/details/drafts.ts'

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

test('typing that went on while a save was out stays unsaved, against the text the save wrote', () => {
  // Nothing typed meanwhile: clean.
  assert.equal(afterSave('first edit', 'first edit'), null)
  // Typed on: still dirty, and the file now holds what was saved.
  assert.deepEqual(afterSave('first edit', 'first edit plus new typing'), { text: 'first edit plus new typing', base: 'first edit' })
  // Discarded with Esc meanwhile: the editor shows the file, which holds the save.
  assert.equal(afterSave('first edit', null), null)
})
