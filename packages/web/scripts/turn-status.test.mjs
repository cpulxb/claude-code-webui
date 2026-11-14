import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatElapsed, formatTokens, localTurnProgress, turnStatusText } from '../src/utils/turn-status.ts'

const retrying = (fields = {}) => ({
  startedAt: 1000, phase: 'retrying',
  retry: { uuid: 'r', attempt: 2, maxRetries: 5, retryAt: 11000, errorStatus: 429, error: 'rate_limit', ...fields },
})

test('the status reports real activity, never a made-up progress percentage', () => {
  assert.match(turnStatusText(null, 0).label, /任务执行中/)
  for (const [phase, word] of [['requesting', '等待响应'], ['thinking', '思考'], ['responding', '生成回复'], ['compacting', '压缩上下文']]) {
    assert.match(turnStatusText({ startedAt: 0, phase }, 0).label, new RegExp(word))
  }
  assert.match(turnStatusText({ startedAt: 0, phase: 'tool', toolName: 'Bash' }, 0).label, /执行 Bash/)
})

test('a retry shows its cause, count and countdown without claiming recovery at zero', () => {
  const progress = retrying()
  const waiting = turnStatusText(progress, 8500)
  assert.equal(waiting.warning, true)
  assert.match(waiting.label, /API 出错/)
  assert.match(waiting.detail, /HTTP 429 · 请求限流/)
  assert.match(waiting.detail, /第 2 次，最多 5 次 · 3s 后重试/)
  const expired = turnStatusText(progress, 20000)
  assert.match(expired.detail, /正在重试，等待响应/)
  assert.equal(expired.warning, true)
  assert.equal(progress.retry.retryAt, 11000)
})

test('unknown connection errors and a replay without timing are still understandable', () => {
  const state = turnStatusText(retrying({ errorStatus: null, error: 'new_error', retryAt: null }), 50000)
  assert.match(state.detail, /new_error/)
  assert.match(state.detail, /剩余等待时间未知/)
  assert.doesNotMatch(state.detail, /HTTP null|NaN/)
})

test('a no-response retry uses the backoff deadline, not its next request timeout', () => {
  const state = turnStatusText(retrying({ errorStatus: null, noResponse: { waitedMs: 60000, retryWaitMs: 120000 } }), 10000)
  assert.match(state.detail, /等待响应超时/)
  assert.match(state.detail, /1s 后重试/)
  assert.doesNotMatch(state.detail, /120s/)
})

test('permission waiting outranks retry while keeping its real error details', () => {
  const state = turnStatusText(retrying(), 1000, true)
  assert.match(state.label, /等待你确认/)
  assert.match(state.detail, /HTTP 429/)
})

test('server-clock snapshots preserve elapsed time and remaining backoff across different clocks', () => {
  const progress = retrying()
  const local = localTurnProgress(progress, 9000, 109000)
  assert.equal(local.startedAt, 101000)
  assert.equal(local.retry.retryAt, 111000)
  assert.equal(109000 - local.startedAt, 8000)
  assert.match(turnStatusText(local, 109000).detail, /2s 后重试/)
  assert.equal(progress.startedAt, 1000)
  assert.equal(progress.retry.retryAt, 11000)
  assert.equal(localTurnProgress(null, 100, 200), null)
  assert.equal(localTurnProgress(retrying({ retryAt: null }), 100, 200).retry.retryAt, null)
})

test('elapsed time and token formatting retain the existing compact display', () => {
  assert.equal(formatElapsed(59), '59s')
  assert.equal(formatElapsed(120), '2m 0s')
  assert.equal(formatTokens(20), '20')
  assert.equal(formatTokens(1550), '1.6k')
})
