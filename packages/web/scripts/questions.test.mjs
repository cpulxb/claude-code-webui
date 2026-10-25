import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectAnswers, EMPTY_DRAFT, parseQuestions, toggleOption, typeOther } from '../src/utils/questions.ts'

// The input CLI 2.1.310 hands canUseTool for a two-question AskUserQuestion.
const [color, fruits] = parseQuestions({
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      options: [
        { label: 'Red', description: 'Choose Red' },
        { label: 'Blue', description: 'Choose Blue' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which fruits do you like?',
      header: 'Fruits',
      options: [
        { label: 'Apple', description: 'Choose Apple' },
        { label: 'Banana', description: 'Choose Banana' },
        { label: 'Cherry', description: 'Choose Cherry' },
      ],
      multiSelect: true,
    },
  ],
})

test('a single choice keeps only the last thing picked', () => {
  let draft = toggleOption(color, EMPTY_DRAFT, 'Red')
  draft = toggleOption(color, draft, 'Blue')
  assert.deepEqual(collectAnswers([color], [draft]), { 'Which color do you prefer?': 'Blue' })

  draft = typeOther(color, draft, '绿色')
  assert.deepEqual(collectAnswers([color], [draft]), { 'Which color do you prefer?': '绿色' })

  draft = toggleOption(color, draft, 'Red')
  assert.deepEqual(collectAnswers([color], [draft]), { 'Which color do you prefer?': 'Red' })
})

test('a multi-select answer lists the picks in option order, typed text last', () => {
  let draft = toggleOption(fruits, EMPTY_DRAFT, 'Cherry')
  draft = toggleOption(fruits, draft, 'Apple')
  draft = typeOther(fruits, draft, ' 芒果 ')
  draft = toggleOption(fruits, draft, 'Banana')
  draft = toggleOption(fruits, draft, 'Banana')
  assert.deepEqual(collectAnswers([fruits], [draft]), { 'Which fruits do you like?': 'Apple, Cherry, 芒果' })
})

test('nothing is submitted while a question is still open', () => {
  const picked = toggleOption(color, EMPTY_DRAFT, 'Red')
  assert.equal(collectAnswers([color, fruits], [picked, EMPTY_DRAFT]), null)
  // Blank typing does not count as an answer.
  assert.equal(collectAnswers([color, fruits], [picked, typeOther(fruits, EMPTY_DRAFT, '  ')]), null)
  assert.deepEqual(collectAnswers([color, fruits], [picked, typeOther(fruits, EMPTY_DRAFT, '都不喜欢')]), {
    'Which color do you prefer?': 'Red',
    'Which fruits do you like?': '都不喜欢',
  })
})

test('input that is not a list of questions falls back to the permission card', () => {
  assert.equal(parseQuestions({}), null)
  assert.equal(parseQuestions({ questions: [] }), null)
  assert.equal(parseQuestions({ questions: [{ question: 'Q?', options: [{ description: 'no label' }] }] }), null)
})
