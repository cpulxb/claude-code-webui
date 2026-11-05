import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeRestore, describeTurn, restoresFiles, turnEdits } from '../src/utils/rewind.ts'

const prompt = (id) => ({ kind: 'user', id, text: id, attachments: 0 })
const tool = (name, input, status = 'done') => ({ kind: 'tool', id: crypto.randomUUID(), toolUseId: 'x', name, input, status })

test('each prompt lists what its own turn changed through the file tools', () => {
  const turns = turnEdits([
    prompt('p1'),
    tool('Read', { file_path: '/w/a.py' }),
    tool('Bash', { command: 'rm b.py' }),
    prompt('p2'),
    tool('Write', { file_path: '/w/a.py', content: 'one\ntwo\nthree\nfour' }),
    tool('Edit', { file_path: '/w/a.py', old_string: 'two', new_string: 'deux\ndos' }),
    tool('MultiEdit', { file_path: '/w/lib/b.py', edits: [{ old_string: 'x', new_string: 'y' }] }),
    // A call that failed changed nothing.
    tool('Edit', { file_path: '/w/c.py', old_string: 'a', new_string: 'b' }, 'error'),
  ])
  assert.deepEqual(turns.get('p1'), { files: [], added: 0, removed: 0 })
  assert.deepEqual(turns.get('p2'), { files: ['/w/a.py', '/w/lib/b.py'], added: 7, removed: 2 })
  assert.equal(describeTurn(turns.get('p1'), '/w'), '没有改动代码')
  assert.equal(describeTurn(turns.get('p2'), '/w'), 'a.py 等 2 个文件 +7 −2')
  // A prompt not read in is not known to have changed nothing.
  assert.equal(describeTurn(turns.get('p3'), '/w'), null)
})

test('a dry run reads as what the code goes back by', () => {
  assert.equal(describeRestore({ canRewind: true, filesChanged: ['/w/write_file.py'], insertions: 0, deletions: 4 }, '/w'), '代码会恢复：write_file.py −4')
  assert.equal(describeRestore({ canRewind: true, filesChanged: [] }, '/w'), '没有需要恢复的代码改动')
  assert.equal(restoresFiles({ canRewind: true, filesChanged: ['/w/a'] }), true)
  assert.equal(restoresFiles({ canRewind: true, filesChanged: [] }), false)
  assert.equal(restoresFiles({ canRewind: false, error: 'no checkpoint' }), false)
  assert.equal(restoresFiles(null), false)
})
