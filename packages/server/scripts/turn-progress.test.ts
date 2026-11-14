import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import type { Query, query } from '@anthropic-ai/claude-agent-sdk'

import { applyTurnProgress, startTurnProgress, type SDKMessage, type ServerEvent, type TurnProgress } from '@ccw/shared'

import { InputQueue } from '../src/session/input-queue.ts'
import { SessionRunner } from '../src/session/runner.ts'

// Deliberately partial protocol fixtures: no SDK query, CLI or API call occurs.
const sdk = (frame: unknown): SDKMessage => frame as SDKMessage
const system = (subtype: string, fields: Record<string, unknown> = {}) => sdk({ type: 'system', subtype, ...fields })
const stream = (event: unknown, fields: Record<string, unknown> = {}) => sdk({ type: 'stream_event', parent_tool_use_id: null, event, ...fields })
const assistant = (content: unknown[], fields: Record<string, unknown> = {}) => sdk({ type: 'assistant', parent_tool_use_id: null, message: { content }, ...fields })
const retryMessage = (fields: Record<string, unknown> = {}) => system('api_retry', {
  uuid: 'retry-1', attempt: 1, max_retries: 5, retry_delay_ms: 2000, error_status: 429, error: 'rate_limit', ...fields,
})
const retrying = (): TurnProgress => applyTurnProgress(startTurnProgress(1000), retryMessage(), 1500)!
const text = (value = 'hello') => stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: value } })
const toolProgress = (fields: Record<string, unknown> = {}) => sdk({ type: 'tool_progress', parent_tool_use_id: null, tool_use_id: 'main-tool', tool_name: 'Bash', elapsed_time_seconds: 1, ...fields })

test('the turn clock starts explicitly; startup metadata cannot open a turn', () => {
  assert.deepEqual(startTurnProgress(1000), { startedAt: 1000, phase: 'running' })
  assert.equal(applyTurnProgress(null, system('init'), 2000), null)
  assert.equal(applyTurnProgress(null, system('status', { status: null, permissionMode: 'plan' }), 2000), null)
  const progress = startTurnProgress(1000)
  assert.equal(applyTurnProgress(progress, system('init'), 2000), progress)
})

test('retry reflects only a CLI api_retry event and stores an absolute server deadline', () => {
  const progress = retrying()
  assert.deepEqual(progress, {
    startedAt: 1000,
    phase: 'retrying',
    retry: { uuid: 'retry-1', attempt: 1, maxRetries: 5, retryAt: 3500, errorStatus: 429, error: 'rate_limit' },
  })
  assert.deepEqual(startTurnProgress(1000), { startedAt: 1000, phase: 'running' })
})

test('same retry UUID retains identity/deadline; a new attempt UUID resets only its deadline', () => {
  const current = retrying()
  assert.equal(applyTurnProgress(current, retryMessage(), 9000), current)
  const next = applyTurnProgress(current, retryMessage({ uuid: 'retry-2', attempt: 2, retry_delay_ms: 4000 }), 5000)!
  assert.equal(next.startedAt, 1000)
  assert.equal(next.retry?.retryAt, 9000)
  assert.equal(next.retry?.attempt, 2)
  assert.equal(current.retry?.retryAt, 3500)
})

test('no-response retry preserves CLI first-byte windows and nullable HTTP status', () => {
  const progress = applyTurnProgress(null, retryMessage({ error_status: null, error: 'unknown', no_response: { waited_ms: 30000, retry_wait_ms: 60000 } }), 1000)!
  assert.equal(progress.retry?.errorStatus, null)
  assert.deepEqual(progress.retry?.noResponse, { waitedMs: 30000, retryWaitMs: 60000 })
  assert.equal(progress.startedAt, 1000)
})

test('invalid delay/status/window values are safe and zero delay remains a real deadline', () => {
  for (const delay of [-1, NaN, Infinity, undefined, '100']) {
    const progress = applyTurnProgress(null, retryMessage({ retry_delay_ms: delay, error_status: Infinity, no_response: { waited_ms: -1, retry_wait_ms: 100 } }), 1000)!
    assert.equal(progress.retry?.retryAt, null)
    assert.equal(progress.retry?.errorStatus, null)
    assert.equal(progress.retry?.noResponse, undefined)
  }
  assert.equal(applyTurnProgress(null, retryMessage({ retry_delay_ms: 0 }), 1000)?.retry?.retryAt, 1000)
})

test('elapsed countdown, requesting, empty blocks and permission-mode status never clear retry', () => {
  const current = retrying()
  const frames = [
    system('init'),
    system('status', { status: 'requesting' }),
    system('status', { status: 'compacting' }),
    system('status', { status: null, permissionMode: 'acceptEdits' }),
    system('session_state_changed', { state: 'running' }),
    system('session_state_changed', { state: 'requires_action' }),
    stream({ type: 'message_start' }),
    stream({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } }),
    text(''),
    system('thinking_tokens', { estimated_tokens_delta: 0 }),
    assistant([{ type: 'text', text: 'API error' }], { error: 'rate_limit' }),
    assistant([{ type: 'text', text: 'aborted partial' }], { aborted: true }),
    sdk({ type: 'user', parent_tool_use_id: null, message: { content: 'queued prompt' } }),
  ]
  for (const frame of frames) assert.equal(applyTurnProgress(current, frame, 100000), current)
  assert.equal(current.retry?.retryAt, 3500)
})

test('real main-thread text/thinking/tool blocks clear retry and preserve the original start', () => {
  const frames: [SDKMessage, TurnProgress['phase'], string?][] = [
    [text(), 'responding'],
    [stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning' } }), 'thinking'],
    [stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 2 } }), 'thinking'],
    [system('thinking_tokens', { estimated_tokens_delta: 2 }), 'thinking'],
    [assistant([{ type: 'text', text: 'answer' }]), 'responding'],
    [assistant([{ type: 'thinking', thinking: 'reasoning' }]), 'thinking'],
    [assistant([{ type: 'tool_use', id: 'main-tool', name: 'Read' }]), 'tool', 'Read'],
    [stream({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'main-tool', name: 'Write' } }), 'tool', 'Write'],
    [toolProgress(), 'tool', 'Bash'],
    [toolProgress({ parent_tool_use_id: 'main-tool' }), 'tool', 'Bash'],
  ]
  for (const [frame, phase, toolName] of frames) {
    const next = applyTurnProgress(retrying(), frame, 10000)!
    assert.equal(next.startedAt, 1000)
    assert.equal(next.phase, phase)
    assert.equal(next.toolName, toolName)
    assert.equal(next.retry, undefined)
  }
})

test('subagents, tool heartbeats and subagent retry fields cannot recover the main request', () => {
  const current = retrying()
  const frames = [
    assistant([{ type: 'text', text: 'child output' }], { parent_tool_use_id: 'agent-call' }),
    assistant([{ type: 'text', text: 'child output' }], { agent_id: 'child' }),
    stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'child delta' } }, { parent_tool_use_id: 'agent-call' }),
    system('thinking_tokens', { estimated_tokens_delta: 4, agent_id: 'child' }),
    system('api_retry', { ...retryMessage(), uuid: 'child-retry', parent_tool_use_id: 'agent-call' }),
    toolProgress({ heartbeat: true }),
    toolProgress({ parent_tool_use_id: 'agent-call' }),
    toolProgress({ subagent_type: 'general-purpose' }),
    toolProgress({ subagent_retry: { agent_id: 'child', attempt: 1 } }),
    toolProgress({ agent_id: 'child' }),
    system('task_progress', { task_id: 'child' }),
  ]
  for (const frame of frames) {
    assert.equal(applyTurnProgress(current, frame, 10000), current)
    assert.equal(applyTurnProgress(null, frame, 10000), null)
  }
})

test('same phase retains object identity, including replayed mixed complete messages', () => {
  const responding = applyTurnProgress(startTurnProgress(1000), text(), 2000)!
  assert.equal(applyTurnProgress(responding, text('another token'), 3000), responding)
  assert.equal(applyTurnProgress(responding, assistant([{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'answer' }]), 4000), responding)
  const tool = applyTurnProgress(responding, toolProgress(), 3000)!
  assert.equal(applyTurnProgress(tool, toolProgress({ elapsed_time_seconds: 8 }), 8000), tool)
  assert.notEqual(applyTurnProgress(tool, toolProgress({ tool_name: 'Read' }), 9000), tool)
})

test('requires_action remains in flight; only actual idle ends the turn', () => {
  const current = retrying()
  assert.equal(applyTurnProgress(current, system('session_state_changed', { state: 'requires_action' }), 5000), current)
  assert.deepEqual(applyTurnProgress(null, system('session_state_changed', { state: 'requires_action' }), 5000), { startedAt: 5000, phase: 'running' })
  assert.equal(applyTurnProgress(current, system('session_state_changed', { state: 'idle' }), 5000), null)
})

test('success and every result failure shape end progress; reset discards old retry', () => {
  const current = retrying()
  for (const result of [
    { type: 'result', subtype: 'success', is_error: false },
    { type: 'result', subtype: 'success', is_error: true },
    { type: 'result', subtype: 'error_during_execution', is_error: true },
    { type: 'result', subtype: 'error_max_turns', is_error: true },
  ]) assert.equal(applyTurnProgress(current, sdk(result), 8000), null)
  const reset = applyTurnProgress(current, sdk({ type: 'conversation_reset' }), 9000)
  assert.deepEqual(reset, { startedAt: 1000, phase: 'running' })
  assert.equal(applyTurnProgress(null, sdk({ type: 'conversation_reset' }), 9000), null)
})

test('old CLIs work from complete assistant blocks without retry/status events', () => {
  const progress = applyTurnProgress(null, assistant([{ type: 'text', text: 'old CLI answer' }]), 3000)!
  assert.deepEqual(progress, { startedAt: 3000, phase: 'responding' })
  assert.equal(applyTurnProgress(progress, sdk({ type: 'result', subtype: 'success' }), 4000), null)
})

// --- runner lifecycle: injected SDK Query, never a subprocess/API ------------

type Receipt = Awaited<ReturnType<Query['interrupt']>>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const result = () => sdk({ type: 'result', subtype: 'success', is_error: false })
const answer = () => assistant([{ type: 'text', text: 'actual output' }])

function runnerFixture(t: TestContext) {
  // Freeze the clock and suppress title polling, so even local SDK title reads
  // cannot run. The injected Query handles every method used by SessionModels.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  const frames = new InputQueue<{ frame: SDKMessage | Error; ack: () => void }>()
  const events: ServerEvent[] = []
  const receipts: ReturnType<typeof deferred<Receipt>>[] = []
  let factoryCalls = 0
  const exited = deferred<void>()
  const fake = {
    async *[Symbol.asyncIterator]() {
      for await (const { frame, ack } of frames) {
        if (frame instanceof Error) { ack(); throw frame }
        yield frame
        ack() // Resolves only after #pump finished processing this exact frame.
      }
    },
    supportedModels: async () => [{ value: 'test-model', displayName: 'Test', description: 'Fake' }],
    getSettings: async () => ({ applied: { model: 'test-model' } }),
    getContextUsage: async () => ({ model: 'test-model' }),
    applyFlagSettings: async () => {},
    reinitialize: async () => ({ models: [{ value: 'test-model', displayName: 'Test', description: 'Fake' }] }),
    interrupt: () => {
      const receipt = deferred<Receipt>()
      receipts.push(receipt)
      return receipt.promise
    },
    close: () => frames.close(),
  }
  const queryFactory: typeof query = () => {
    factoryCalls += 1
    return fake as unknown as Query
  }
  const runner = new SessionRunner({ cwd: '/tmp/ccw-progress-fixture', resume: 'old-session', model: 'test-model' }, (event) => {
    events.push(event)
    if (event.type === 'session_closed') exited.resolve()
  }, queryFactory)
  t.after(() => runner.shutdown())
  const emit = async (frame: SDKMessage | Error) => {
    const ack = deferred<void>()
    frames.push({ frame, ack: () => ack.resolve() })
    await ack.promise
    if (frame instanceof Error) await exited.promise
  }
  return {
    runner, emit, events, receipts,
    progress: (): TurnProgress | null => runner.turnProgress,
    tick: (now: number) => t.mock.timers.setTime(now),
    progressEvents: () => events.filter((event): event is Extract<ServerEvent, { type: 'turn_progress' }> => event.type === 'turn_progress'),
    factoryCalls: () => factoryCalls,
  }
}

async function tailFrames(f: ReturnType<typeof runnerFixture>) {
  for (const frame of [
    answer(), text(),
    system('status', { status: 'requesting' }),
    system('session_state_changed', { state: 'running' }),
    system('session_state_changed', { state: 'requires_action' }),
    retryMessage(),
  ]) await f.emit(frame)
}

test('runner startup stays idle; send starts once; queued sends/tokens never rebroadcast or reset retry', async (t) => {
  const f = runnerFixture(t)
  await f.emit(system('init'))
  assert.equal(f.factoryCalls(), 1)
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progress(), null)
  assert.equal(f.progressEvents().length, 0)
  await f.runner.send('first')
  assert.deepEqual(f.progress(), { startedAt: 1000, phase: 'running' })
  f.tick(1500)
  const retry = retryMessage()
  await f.emit(retry)
  const progress = f.progress()!
  assert.equal(progress.retry?.retryAt, 3500)
  const sdkIndex = f.events.findIndex((event) => event.type === 'sdk' && event.message === retry)
  assert.equal(f.events[sdkIndex - 1]?.type, 'turn_progress')
  const broadcasts = f.progressEvents().length
  f.tick(9000)
  await f.runner.send('queued')
  await f.emit(system('init'))
  await f.emit(retry)
  await f.emit(system('status', { status: 'requesting' }))
  assert.equal(f.progress(), progress)
  assert.equal(f.progressEvents().length, broadcasts)
  await f.emit(text())
  const responding = f.progress()!
  assert.equal(responding.startedAt, 1000)
  assert.equal(responding.retry, undefined)
  await f.emit(text('another token'))
  assert.equal(f.progress(), responding)
  assert.equal(f.progressEvents().length, broadcasts + 1)
})

test('runner requires_action keeps running/backlog/retry; genuine idle and result end progress', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  await f.emit(retryMessage())
  const progress = f.progress()
  await f.emit(system('session_state_changed', { state: 'requires_action' }))
  assert.equal(f.runner.status, 'running')
  assert.equal(f.runner.summary.running, true)
  assert.equal(f.progress(), progress)
  assert.ok(f.runner.backlog.length > 0)
  await f.emit(system('session_state_changed', { state: 'idle' }))
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progress(), null)
  assert.equal(f.runner.backlog.length, 0)
  for (const frame of [result(), sdk({ type: 'result', subtype: 'success', is_error: true }), sdk({ type: 'result', subtype: 'error_during_execution', is_error: true })]) {
    await f.runner.send('next')
    await f.emit(frame)
    assert.equal(f.runner.status, 'idle')
    assert.equal(f.progress(), null)
  }
})

test('interrupt clears synchronously; assistant/stream/system tails before and after result cannot revive', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  await f.emit(retryMessage())
  const stop = f.runner.interrupt()
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progress(), null)
  assert.equal(f.progressEvents().at(-1)?.progress, null)
  const broadcasts = f.progressEvents().length
  await tailFrames(f)
  await f.emit(result())
  await tailFrames(f)
  await f.emit(system('init'))
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progress(), null)
  f.receipts[0]!.resolve({ still_queued: [] } as Receipt)
  await stop
  await tailFrames(f)
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progress(), null)
  assert.equal(f.runner.backlog.length, 0)
  assert.equal(f.progressEvents().length, broadcasts)
})

test('queued receipt restores Stop with a fresh clock; aborted result/tails cannot erase it before queued init', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  await f.emit(retryMessage())
  const stop = f.runner.interrupt()
  f.tick(5000)
  f.receipts[0]!.resolve({ still_queued: ['queued-user'] } as Receipt)
  await stop
  const queued = f.progress()!
  assert.deepEqual(queued, { startedAt: 5000, phase: 'running' })
  assert.equal(f.runner.status, 'running')
  await tailFrames(f)
  await f.emit(result())
  assert.equal(f.progress(), queued)
  assert.equal(f.runner.status, 'running')
  await f.emit(system('init'))
  await f.emit(retryMessage({ uuid: 'queued-retry' }))
  assert.equal(f.progress()?.retry?.uuid, 'queued-retry')
  assert.equal(f.progress()?.startedAt, 5000)
  await f.emit(result())
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progress(), null)
})

test('queued init/retry racing ahead of interrupt receipt retain real new-turn progress', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('old prompt')
  const stop = f.runner.interrupt()
  await f.emit(result())
  f.tick(5000)
  await f.emit(system('init'))
  await f.emit(retryMessage({ uuid: 'new-turn-retry' }))
  // Until the receipt confirms queue survival, even init cannot revive Stop.
  assert.equal(f.progress(), null)
  f.tick(8000)
  f.receipts[0]!.resolve({ still_queued: ['queued-user'] } as Receipt)
  await stop
  assert.equal(f.progress()?.retry?.uuid, 'new-turn-retry')
  assert.equal(f.progress()?.startedAt, 5000)
  assert.equal(f.progress()?.retry?.retryAt, 7000)
  assert.equal(f.runner.status, 'running')
})

test('an old interrupt receipt cannot overwrite a newer send', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('old prompt')
  const stop = f.runner.interrupt()
  f.tick(5000)
  await f.runner.send('new prompt')
  await f.emit(result())
  await f.emit(system('init'))
  await f.emit(retryMessage({ uuid: 'new-retry' }))
  const progress = f.progress()
  f.receipts[0]!.resolve({ still_queued: [] } as Receipt)
  await stop
  assert.equal(f.progress(), progress)
  assert.equal(f.runner.status, 'running')
})

test('an old queued receipt cannot revive a closed runner', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  const stop = f.runner.interrupt()
  f.runner.close()
  f.receipts[0]!.resolve({ still_queued: ['queued-user'] } as Receipt)
  await stop
  assert.equal(f.progress(), null)
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progressEvents().at(-1)?.progress, null)
})

test('a second interrupt owns state regardless of older queued receipt arrival order', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  const first = f.runner.interrupt()
  const second = f.runner.interrupt()
  f.receipts[1]!.resolve({ still_queued: [] } as Receipt)
  await second
  f.receipts[0]!.resolve({ still_queued: ['queued-user'] } as Receipt)
  await first
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progress(), null)
})

test('reset clears old retry and reopens clean progress under the new session id', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  await f.emit(retryMessage())
  await f.emit(sdk({ type: 'conversation_reset' }))
  assert.equal(f.progress(), null)
  f.tick(5000)
  await f.emit(system('init', { session_id: 'new-session' }))
  assert.equal(f.runner.sessionId, 'new-session')
  assert.equal(f.progress()?.startedAt, 5000)
  assert.equal(f.progress()?.retry, undefined)
  const resetIndex = f.events.findIndex((event) => event.type === 'session_reset')
  assert.equal(f.events[resetIndex + 1]?.type, 'turn_progress')
  assert.equal(f.progressEvents().at(-1)?.sessionId, 'new-session')
  await f.emit(answer())
  assert.equal(f.progress()?.phase, 'responding')
})

test('SDK stream exceptions clear progress before error/closed events', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  await f.emit(retryMessage())
  await f.emit(new Error('fake SDK stream failure'))
  assert.equal(f.progress(), null)
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.runner.done, true)
  const errorIndex = f.events.findIndex((event) => event.type === 'session_error')
  assert.equal(f.events[errorIndex - 1]?.type, 'turn_progress')
  assert.equal(f.events.at(-1)?.type, 'session_closed')
})

test('old CLI auto-turn output opens a clock; validation/failed interrupt cannot leave a phantom turn', async (t) => {
  const f = runnerFixture(t)
  await assert.rejects(f.runner.send('prompt', undefined, 'invalid-uuid'), /uuid/)
  assert.equal(f.progress(), null)
  await f.emit(answer())
  assert.equal(f.runner.status, 'running')
  assert.equal(f.progress()?.phase, 'responding')
  const stop = f.runner.interrupt()
  f.receipts[0]!.reject(new Error('fake interrupt failure'))
  await assert.rejects(stop, /fake interrupt failure/)
  await tailFrames(f)
  await f.emit(result())
  await tailFrames(f)
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progress(), null)
})


test('subagent completion/idle/heartbeat cannot clear a main retry or its reconnect backlog', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  await f.emit(retryMessage())
  const progress = f.progress()
  const backlog = f.runner.backlog.length
  await f.emit(sdk({ type: 'result', subtype: 'success', parent_tool_use_id: 'child' }))
  assert.equal(f.runner.backlog.length, backlog)
  await f.emit(system('session_state_changed', { state: 'idle', agent_id: 'child' }))
  await f.emit(assistant([{ type: 'text', text: 'child text' }], { parent_tool_use_id: 'child' }))
  await f.emit(toolProgress({ heartbeat: true }))
  await f.emit(toolProgress({ subagent_retry: { agent_id: 'child' } }))
  assert.equal(f.progress(), progress)
  assert.equal(f.runner.status, 'running')
  assert.ok(f.runner.backlog.length >= backlog)
})

test('a queued turn completed before the receipt cannot be revived by subsequent tail frames', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  const stop = f.runner.interrupt()
  await f.emit(result())
  await f.emit(system('init'))
  await f.emit(answer())
  await f.emit(result())
  await tailFrames(f)
  f.receipts[0]!.resolve({ still_queued: ['queued-user'] } as Receipt)
  await stop
  assert.equal(f.runner.status, 'idle')
  assert.equal(f.progress(), null)
})

test('reset while a queued turn awaits its receipt cannot carry the old context retry', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('prompt')
  const stop = f.runner.interrupt()
  await f.emit(result())
  await f.emit(system('init'))
  await f.emit(retryMessage())
  await f.emit(sdk({ type: 'conversation_reset' }))
  f.tick(8000)
  await f.emit(system('init', { session_id: 'new-session' }))
  f.receipts[0]!.resolve({ still_queued: ['queued-user'] } as Receipt)
  await stop
  assert.equal(f.runner.sessionId, 'new-session')
  assert.deepEqual(f.progress(), { startedAt: 8000, phase: 'running' })
  assert.equal(f.progress()?.retry, undefined)
})

test('synthetic error text without an SDK error field is never real resumed output', () => {
  const progress = retrying()
  const synthetic = sdk({ type: 'assistant', parent_tool_use_id: null, message: {
    model: '<synthetic>', content: [{ type: 'text', text: 'API Error: EPROTO' }],
  } })
  assert.equal(applyTurnProgress(progress, synthetic, 100000), progress)
  assert.equal(applyTurnProgress(null, synthetic, 100000), null)
})


test('a prompt sent during interrupt keeps its clock through old result/tails until its own init', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('old prompt')
  const stop = f.runner.interrupt()
  f.tick(5000)
  await f.runner.send('new prompt')
  const progress = f.progress()
  assert.deepEqual(progress, { startedAt: 5000, phase: 'running' })
  await f.emit(result())
  assert.equal(f.progress(), progress)
  assert.equal(f.runner.status, 'running')
  await tailFrames(f)
  assert.equal(f.progress(), progress)
  assert.equal(f.runner.status, 'running')
  f.receipts[0]!.resolve({ still_queued: [] } as Receipt)
  await stop
  assert.equal(f.progress(), progress)
  await f.emit(system('init'))
  assert.equal(f.progress(), progress)
  await f.emit(retryMessage({ uuid: 'new-prompt-retry' }))
  assert.equal(f.progress()?.retry?.uuid, 'new-prompt-retry')
  assert.equal(f.progress()?.startedAt, 5000)
})

test('a prompt sent after aborted result still isolates old tails until the new init', async (t) => {
  const f = runnerFixture(t)
  await f.runner.send('old prompt')
  const stop = f.runner.interrupt()
  await f.emit(result())
  f.tick(5000)
  await f.runner.send('new prompt')
  const progress = f.progress()
  await tailFrames(f)
  assert.equal(f.progress(), progress)
  assert.equal(f.runner.status, 'running')
  f.receipts[0]!.resolve({ still_queued: ['stale-queued'] } as Receipt)
  await stop
  await f.emit(system('init'))
  assert.equal(f.progress(), progress)
  await f.emit(text())
  assert.equal(f.progress()?.phase, 'responding')
  assert.equal(f.progress()?.startedAt, 5000)
})
