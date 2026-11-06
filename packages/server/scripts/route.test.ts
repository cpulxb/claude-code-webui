import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, type TestContext } from 'node:test'

import { cliEnv } from '../src/config.ts'
import { AnthropicStream, collect, liveTools, type Json, type MessagesRequest } from '../src/route/anthropic.ts'
import { GeminiReader, toGemini } from '../src/route/gemini.ts'
import { ChatReader, toChat } from '../src/route/openai-chat.ts'
import { ResponsesReader, toResponses } from '../src/route/openai-responses.ts'
import { serveRoute } from '../src/route/serve.ts'
import { SseParser } from '../src/route/sse.ts'
import { endpoint, openAiUrl } from '../src/route/upstream.ts'

const PROXY_ENV = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(PROXY_ENV.map((name) => [name, process.env[name]]))
  for (const name of PROXY_ENV) delete process.env[name]
})

afterEach(() => {
  for (const name of PROXY_ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

// A turn as Claude Code sends it: system blocks with the billing line, a
// system-role message from a hook, a tool round trip with an image, and a
// deferred tool the conversation never loaded.
const conversation: MessagesRequest = {
  model: 'gpt-5.6-luna',
  max_tokens: 32000,
  stream: true,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'xhigh' },
  system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1; cch=abc\nYou are Claude Code.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Be brief.' },
  ],
  tools: [
    { name: 'Read', description: 'Reads a file', input_schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
    { name: 'TodoRead', input_schema: {} },
    { name: 'mcp__notion__search', description: 'Search', input_schema: { type: 'object', properties: {} }, defer_loading: true },
    { type: 'web_search_20250305', name: 'web_search' },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Show me a.png' }] },
    { role: 'system', content: [{ type: 'text', text: 'Hook context.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Look at it.', signature: 'sig' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.png' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'text', text: 'image follows' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
          ],
        },
        { type: 'text', text: '<system-reminder>ok</system-reminder>' },
      ],
    },
  ],
}

test('only the tools the model can call go upstream: no server tools, no deferred ones until referenced', () => {
  assert.deepEqual(liveTools(conversation).map(({ name }) => name), ['Read', 'TodoRead'])
  const read = liveTools(conversation)[0]!
  assert.equal('$schema' in read.input_schema!, false)
  assert.deepEqual(liveTools(conversation)[1]!.input_schema, { type: 'object', properties: {} })
  const loaded: MessagesRequest = {
    ...conversation,
    messages: [...conversation.messages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'tool_reference', tool_name: 'mcp__notion__search' }] }] }],
  }
  assert.deepEqual(liveTools(loaded).map(({ name }) => name), ['Read', 'TodoRead', 'mcp__notion__search'])
})

test('chat: system in front, a hook system turn with it, tool results as tool messages, their images in the user message after', () => {
  const body = toChat(conversation)
  const messages = body['messages'] as Json[]
  assert.deepEqual(messages[0], { role: 'system', content: 'You are Claude Code.\n\nBe brief.\n\nHook context.' })
  assert.deepEqual(messages[1], { role: 'user', content: 'Show me a.png' })
  assert.deepEqual(messages[2], {
    role: 'assistant',
    content: 'Reading.',
    tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.png"}' } }],
  })
  assert.deepEqual(messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'image follows' })
  assert.deepEqual(messages[4], {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
      { type: 'text', text: '<system-reminder>ok</system-reminder>' },
    ],
  })
  // A reasoning model: its own token field and effort, no sampling knobs.
  assert.equal(body['max_completion_tokens'], 32000)
  assert.equal(body['max_tokens'], undefined)
  assert.equal(body['reasoning_effort'], 'high')
  assert.deepEqual(body['stream_options'], { include_usage: true })
  assert.deepEqual((body['tools'] as Json[]).map((tool) => (tool['function'] as Json)['name']), ['Read', 'TodoRead'])
})

test('chat: other models keep max_tokens and get no effort; DeepSeek gets its reasoning back on tool calls', () => {
  const other = toChat({ ...conversation, model: 'qwen3-max', temperature: 0.2, tool_choice: { type: 'any' } })
  assert.equal(other['max_tokens'], 32000)
  assert.equal(other['reasoning_effort'], undefined)
  assert.equal(other['temperature'], 0.2)
  assert.equal(other['tool_choice'], 'required')
  const deepseek = toChat({ ...conversation, model: 'deepseek-v4-flash' })
  assert.equal((deepseek['messages'] as Json[])[2]!['reasoning_content'], 'Look at it.')
})

test('chat stream: deltas become blocks, the first finish and the last usage end it once', () => {
  const events: Json[] = []
  const reader = new ChatReader(new AnthropicStream((event) => events.push(event), 'gpt'))
  const chunks = [
    { choices: [{ delta: { reasoning_content: 'hmm' } }] },
    { choices: [{ delta: { content: 'Hi', reasoning_content: '' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } },
  ]
  for (const chunk of chunks) reader.push(JSON.stringify(chunk))
  reader.push('[DONE]')
  reader.end()
  assert.deepEqual(events.map((event) => event['type']), [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ])
  const message = collect(events)
  assert.deepEqual(message['content'], [
    { type: 'thinking', thinking: 'hmm', signature: '' },
    { type: 'text', text: 'Hi' },
    { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } },
  ])
  assert.equal(message['stop_reason'], 'tool_use')
  assert.deepEqual(message['usage'], { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 60 })
})

test('chat stream: cut before any finish is an error, not an answer', () => {
  const events: Json[] = []
  const reader = new ChatReader(new AnthropicStream((event) => events.push(event), 'gpt'))
  reader.push(JSON.stringify({ choices: [{ delta: { content: 'Hal' } }] }))
  reader.end()
  assert.equal(events.at(-1)!['type'], 'error')
  assert.throws(() => collect(events), /断开/)
})

test('responses: instructions, then items in order with calls and results standing alone', () => {
  const body = toResponses({ ...conversation, max_tokens: 1 })
  assert.equal(body['instructions'], 'You are Claude Code.\n\nBe brief.\n\nHook context.')
  assert.equal(body['max_output_tokens'], 16)
  assert.equal(body['store'], false)
  assert.deepEqual(body['reasoning'], { effort: 'high' })
  assert.deepEqual(body['input'], [
    { role: 'user', content: [{ type: 'input_text', text: 'Show me a.png' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
    { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"path":"a.png"}' },
    {
      type: 'function_call_output',
      call_id: 'toolu_1',
      output: [{ type: 'input_text', text: 'image follows' }, { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' }],
    },
    { role: 'user', content: [{ type: 'input_text', text: '<system-reminder>ok</system-reminder>' }] },
  ])
  const tool = (body['tools'] as Json[])[0]!
  assert.equal(tool['strict'], false)
  assert.equal(tool['name'], 'Read')
})

test('responses stream: arguments that only come with the done events still reach the call', () => {
  const events: Json[] = []
  const reader = new ResponsesReader(new AnthropicStream((event) => events.push(event), 'gpt'))
  const stream = [
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'plan' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Sure' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'Read', arguments: '' } },
    { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"path":"b"}' },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'Read', arguments: '{"path":"b"}' } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 50, output_tokens: 9, input_tokens_details: { cached_tokens: 10 } } } },
  ]
  for (const event of stream) reader.push(JSON.stringify(event))
  reader.end()
  const message = collect(events)
  assert.deepEqual(message['content'], [
    { type: 'thinking', thinking: 'plan', signature: '' },
    { type: 'text', text: 'Sure' },
    { type: 'tool_use', id: 'call_9', name: 'Read', input: { path: 'b' } },
  ])
  assert.equal(message['stop_reason'], 'tool_use')
  assert.deepEqual(message['usage'], { input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 10 })
})

test('responses stream: an answer cut by its token budget says so', () => {
  const events: Json[] = []
  const reader = new ResponsesReader(new AnthropicStream((event) => events.push(event), 'gpt'))
  reader.push(JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'Lo' }))
  reader.push(JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }))
  assert.equal(collect(events)['stop_reason'], 'max_tokens')
})

test('gemini: tool results answered by name and alone, the JSON Schema channel, a lost signature stood in for', () => {
  const body = toGemini({ ...conversation, model: 'gemini-3-flash', tool_choice: { type: 'tool', name: 'Read' } })
  assert.deepEqual(body['systemInstruction'], { parts: [{ text: 'You are Claude Code.\n\nBe brief.\n\nHook context.' }] })
  assert.deepEqual(body['contents'], [
    { role: 'user', parts: [{ text: 'Show me a.png' }] },
    {
      role: 'model',
      parts: [
        { text: 'Reading.' },
        { functionCall: { id: 'toolu_1', name: 'Read', args: { path: 'a.png' } }, thoughtSignature: 'skip_thought_signature_validator' },
      ],
    },
    { role: 'user', parts: [{ functionResponse: { id: 'toolu_1', name: 'Read', response: { output: 'image follows' } } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBOR' } }, { text: '<system-reminder>ok</system-reminder>' }] },
  ])
  const declarations = ((body['tools'] as Json[])[0]!['functionDeclarations'] as Json[])
  assert.deepEqual(declarations[0]!['parametersJsonSchema'], { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false })
  assert.deepEqual(body['toolConfig'], { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['Read'] } })
  assert.deepEqual(body['generationConfig'], { maxOutputTokens: 32000 })
})

test('gemini stream: a call without an id gets one of ours, its signature is replayed and our id is not', () => {
  const events: Json[] = []
  const reader = new GeminiReader(new AnthropicStream((event) => events.push(event), 'gemini'))
  reader.push(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Let me ' }] } }] }))
  reader.push(JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: 'look.' }, { functionCall: { name: 'Read', args: { path: 'c' } }, thoughtSignature: 'SIG' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 20, cachedContentTokenCount: 10 },
  }))
  reader.end()
  const message = collect(events)
  const call = (message['content'] as Json[])[1]!
  assert.deepEqual((message['content'] as Json[])[0], { type: 'text', text: 'Let me look.' })
  assert.match(String(call['id']), /^toolu_gemini_/)
  assert.deepEqual(call['input'], { path: 'c' })
  assert.equal(message['stop_reason'], 'tool_use')
  assert.deepEqual(message['usage'], { input_tokens: 20, output_tokens: 25, cache_read_input_tokens: 10 })

  const next = toGemini({
    model: 'gemini-3-flash',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [call as never] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: String(call['id']), content: 'file c', is_error: true }] },
    ],
  })
  const contents = next['contents'] as Json[]
  assert.deepEqual(contents[1], { role: 'model', parts: [{ functionCall: { name: 'Read', args: { path: 'c' } }, thoughtSignature: 'SIG' }] })
  assert.deepEqual(contents[2], { role: 'user', parts: [{ functionResponse: { name: 'Read', response: { error: 'file c' } } }] })
})

test('gemini stream: a stop for safety is an error', () => {
  const events: Json[] = []
  const reader = new GeminiReader(new AnthropicStream((event) => events.push(event), 'gemini'))
  reader.push(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }))
  reader.end()
  assert.throws(() => collect(events), /SAFETY/)
})

test('sse: events split anywhere across chunks, CRLF or not, come out whole', () => {
  const parser = new SseParser()
  const text = 'event: a\r\ndata: {"x":1}\r\n\r\n: comment\n\ndata: [DONE]'
  const events = [...text].flatMap((char) => parser.push(char))
  assert.deepEqual([...events, ...parser.end()], [{ event: 'a', data: '{"x":1}' }, { event: '', data: '[DONE]' }])
})

test('upstream addresses: with or without a version, or pasted whole, each lands on the endpoint', () => {
  assert.equal(openAiUrl('https://api.openai.com', '/chat/completions').href, 'https://api.openai.com/v1/chat/completions')
  assert.equal(openAiUrl('https://api.openai.com/v1/', '/responses').href, 'https://api.openai.com/v1/responses')
  assert.equal(openAiUrl('https://open.bigmodel.cn/api/paas/v4', '/chat/completions').href, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  assert.equal(openAiUrl('https://x.ai/v1/chat/completions', '/models').href, 'https://x.ai/v1/models')
  const gemini = endpoint('gemini', 'https://generativelanguage.googleapis.com', 'g-key', 'models/gemini-3-flash')
  assert.equal(gemini.url.href, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse')
  assert.deepEqual(gemini.headers, { 'x-goog-api-key': 'g-key' })
  assert.equal(endpoint('gemini', 'https://relay.example/v1beta/', '', 'Gemini 3 Flash').url.pathname, '/v1beta/models/Gemini%203%20Flash:streamGenerateContent')
  assert.deepEqual(endpoint('openai-chat', 'https://api.openai.com/v1', 'sk', 'gpt').headers, { authorization: 'Bearer sk' })
})

// End to end: the route in front of a fake upstream, with a channels.json naming it.

type Handler = (req: IncomingMessage, res: ServerResponse, body: Json) => void

async function listen(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const TOKEN = 'ccw-route-0123456789abcdef0123456789abcdef'

async function routed(t: TestContext, format: string, upstream: Handler): Promise<{ url: string; seen: Json[] }> {
  const seen: Json[] = []
  const base = await listen(t, (req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk)).on('end', () => {
      const body = JSON.parse(raw) as Json
      seen.push({ url: req.url, auth: req.headers['authorization'] ?? req.headers['x-goog-api-key'], body })
      upstream(req, res, body)
    })
  })
  const dir = await mkdtemp(join(tmpdir(), 'ccw-route-'))
  process.env['CCW_CONFIG_DIR'] = dir
  const route = { format, baseUrl: `${base}/v1`, key: 'sk-upstream', token: TOKEN }
  await writeFile(join(dir, 'channels.json'), JSON.stringify({ activeId: 'c1', channels: [{ id: 'c1', name: 'up', settings: {}, route }] }))
  const url = await listen(t, (req, res) => void serveRoute(req, res, new URL(req.url ?? '/', 'http://x').pathname))
  return { url, seen }
}

const sse = (res: ServerResponse, events: unknown[]): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
  res.end()
}

const ask = (url: string, body: unknown, token = TOKEN, path = '/route/c1/v1/messages?beta=true'): Promise<Response> =>
  fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('route: a streamed request reaches the upstream translated, with its key, and streams back as Messages events', async (t) => {
  const { url, seen } = await routed(t, 'openai-chat', (_req, res) =>
    sse(res, [{ choices: [{ delta: { content: 'pong' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }, '[DONE]']),
  )
  const reply = await ask(url, { model: 'gpt-4.1[1m]', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'ping' }] })
  assert.equal(reply.status, 200)
  assert.match(reply.headers.get('content-type') ?? '', /text\/event-stream/)
  const frames = (await reply.text()).split('\n\n').filter(Boolean)
  assert.deepEqual(frames.map((frame) => /^event: (\S+)/.exec(frame)?.[1]), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ])
  assert.equal(seen[0]!['url'], '/v1/chat/completions')
  assert.equal(seen[0]!['auth'], 'Bearer sk-upstream')
  assert.equal((seen[0]!['body'] as Json)['model'], 'gpt-4.1')
  assert.deepEqual((seen[0]!['body'] as Json)['messages'], [{ role: 'user', content: 'ping' }])
})

test('route: a request without stream gets the whole message', async (t) => {
  const { url } = await routed(t, 'openai-responses', (_req, res) =>
    sse(res, [
      { type: 'response.output_text.delta', output_index: 0, delta: 'po' },
      { type: 'response.output_text.delta', output_index: 0, delta: 'ng' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } },
    ]),
  )
  const reply = await ask(url, { model: 'gpt-5.6', max_tokens: 50, messages: [{ role: 'user', content: 'ping' }] })
  const message = (await reply.json()) as Json
  assert.equal(message['type'], 'message')
  assert.deepEqual(message['content'], [{ type: 'text', text: 'pong' }])
  assert.equal(message['stop_reason'], 'end_turn')
})

test('route: an upstream refusal comes back with its status, as an Anthropic error the CLI knows', async (t) => {
  const { url } = await routed(t, 'gemini', (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }))
  })
  const reply = await ask(url, { model: 'gemini-3-flash', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'ping' }] })
  assert.equal(reply.status, 429)
  const body = (await reply.json()) as { error: { type: string; message: string } }
  assert.equal(body.error.type, 'rate_limit_error')
  assert.match(body.error.message, /429：Resource has been exhausted/)
})

test('route: a wrong token, an unknown channel or another path is refused before any upstream request', async (t) => {
  const { url, seen } = await routed(t, 'openai-chat', () => assert.fail('the upstream must not be asked'))
  const body = { model: 'm', messages: [{ role: 'user', content: 'x' }] }
  assert.equal((await ask(url, body, `${TOKEN.slice(0, -1)}0`)).status, 401)
  assert.equal((await ask(url, body, TOKEN, '/route/other/v1/messages')).status, 401)
  assert.equal((await ask(url, body, TOKEN, '/route/c1/v1/complete')).status, 404)
  assert.equal((await ask(url, { nope: true })).status, 400)
  assert.equal(seen.length, 0)
})

test('route: count_tokens is answered here, with an estimate', async (t) => {
  const { url, seen } = await routed(t, 'openai-chat', () => assert.fail('the upstream must not be asked'))
  const reply = await ask(url, { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(400) }] }, TOKEN, '/route/c1/v1/messages/count_tokens?beta=true')
  const { input_tokens } = (await reply.json()) as { input_tokens: number }
  assert.ok(input_tokens > 90 && input_tokens < 130)
  assert.equal(seen.length, 0)
})

test('behind a proxy the CLI is told to reach loopback directly, every host already excluded kept', () => {
  const env = cliEnv({ HTTPS_PROXY: 'http://proxy:8080', no_proxy: 'corp.lan, 10.*', PATH: '/bin' })
  assert.equal(env['NO_PROXY'], 'corp.lan,10.*,localhost,127.0.0.1,::1')
  assert.equal(env['no_proxy'], env['NO_PROXY'])
  assert.equal(env['PATH'], '/bin')
  assert.deepEqual(cliEnv({ PATH: '/bin' }), { PATH: '/bin' }, 'no proxy, nothing added')
})
