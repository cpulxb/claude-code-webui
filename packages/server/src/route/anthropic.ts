/**
 * The Anthropic side of every translation: what the CLI's Messages request
 * holds, and the stream of Messages events it expects back. Each upstream
 * format reads the request through the helpers here and drives one
 * {@link AnthropicStream} with what its own stream says.
 */

import { randomBytes } from 'node:crypto'

export type Json = Record<string, unknown>
export type Block = Json & { type: string }
export type Message = { role: string; content: string | Block[] }
export type Tool = { name: string; description?: string; input_schema?: Json }

/** A Messages request; only the fields some translation reads are typed. */
export type MessagesRequest = {
  model: string
  messages: Message[]
  system?: string | Block[]
  tools?: (Tool & { type?: string; defer_loading?: boolean })[]
  tool_choice?: { type: string; name?: string; disable_parallel_tool_use?: boolean }
  max_tokens?: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  thinking?: { type: string; budget_tokens?: number }
  output_config?: { effort?: string }
}

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence'
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function blocksOf(content: Message['content']): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content.filter((block): block is Block => isObject(block) && typeof block['type'] === 'string') : []
}

/** Text blocks joined; documents of plain text count as text. */
export function textOf(blocks: Block[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? text(block['text']) : block.type === 'document' && isObject(block['source']) ? text(block['source']['data']) : ''))
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The system prompt as one text. Claude Code may open it with an
 * `x-anthropic-billing-header:` line meant for Anthropic alone; it changes
 * every request, so left in it would defeat the upstream's prompt cache.
 *
 * The `system` turns Claude Code puts among the messages (a hook's context)
 * are added at the end. Kept in place they break other APIs: DeepSeek answers
 * a trailing one instead of the user, and one between a tool call and its
 * result is refused outright.
 */
export function systemText(request: MessagesRequest): string {
  const raw = typeof request.system === 'string' ? request.system : textOf(blocksOf(request.system ?? []))
  const later = request.messages.filter(({ role }) => role === 'system').map(({ content }) => textOf(blocksOf(content)))
  return [raw.replace(/^x-anthropic-billing-header:[^\n]*\n?/, '').trim(), ...later].filter(Boolean).join('\n\n')
}

/** The user and assistant turns: the system ones go in {@link systemText}. */
export const turns = (request: MessagesRequest): Message[] => request.messages.filter(({ role }) => role !== 'system')

/** An image or PDF block's data URL (or its own URL); null for anything else. */
export function mediaUrl(block: Block): { url: string; mediaType: string; data?: string } | null {
  const source = block['source']
  if (!isObject(source)) return null
  if (source['type'] === 'url' && typeof source['url'] === 'string') return { url: source['url'], mediaType: text(source['media_type']) }
  if (source['type'] !== 'base64' || typeof source['data'] !== 'string') return null
  const mediaType = text(source['media_type']) || (block.type === 'document' ? 'application/pdf' : 'image/png')
  return { url: `data:${mediaType};base64,${source['data']}`, mediaType, data: source['data'] }
}

/**
 * A tool result as text, with its images apart: no upstream format takes an
 * image everywhere Anthropic's tool results do. A `tool_reference` (a
 * deferred tool the CLI's tool search loaded) is said in words.
 */
export function toolResultOf(block: Block): { text: string; images: Block[]; isError: boolean } {
  const parts = blocksOf((block['content'] ?? '') as Message['content'])
  const texts: string[] = []
  const images: Block[] = []
  for (const part of parts) {
    if (part.type === 'text') texts.push(text(part['text']))
    else if (part.type === 'image' || part.type === 'document') images.push(part)
    else if (part.type === 'tool_reference') texts.push(`Tool loaded: ${text(part['tool_name'])}`)
  }
  return { text: texts.join('\n'), images, isError: block['is_error'] === true }
}

/**
 * The tools the model can call now. Server tools (web search and the like)
 * run at Anthropic and nowhere else. A deferred tool counts once the CLI's
 * tool search has referenced it in the conversation, as Anthropic's API would.
 */
export function liveTools(request: MessagesRequest): Tool[] {
  const referenced = new Set<string>()
  for (const message of request.messages) {
    for (const block of blocksOf(message.content)) {
      if (block.type !== 'tool_result') continue
      for (const part of blocksOf((block['content'] ?? '') as Message['content'])) {
        if (part.type === 'tool_reference') referenced.add(text(part['tool_name']))
      }
    }
  }
  return (request.tools ?? [])
    .filter((tool) => (tool.type === undefined || tool.type === 'custom') && typeof tool.name === 'string')
    .filter((tool) => !tool.defer_loading || referenced.has(tool.name))
    .map(({ name, description, input_schema }) => ({ name, ...(description ? { description } : {}), input_schema: objectSchema(input_schema) }))
}

/** Every upstream wants an object schema at the root, and some reject `$schema`. */
function objectSchema(schema: unknown): Json {
  const { $schema: _, ...rest } = isObject(schema) ? schema : {}
  if (rest['type'] === undefined) rest['type'] = 'object'
  if (rest['type'] === 'object' && rest['properties'] === undefined) rest['properties'] = {}
  return rest
}

/** Every tool_use id in the conversation, with its tool's name: some formats answer a call by name. */
export function toolNames(request: MessagesRequest): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of request.messages) {
    for (const block of blocksOf(message.content)) {
      if (block.type === 'tool_use') names.set(text(block['id']), text(block['name']))
    }
  }
  return names
}

/**
 * How hard the client asked the model to think, in the three levels every
 * reasoning API takes: Claude Code's `xhigh` / `max` are `high` elsewhere,
 * and models that know no more than three would refuse them. With thinking
 * off the effort still comes, so it counts as `low`. Null leaves the
 * upstream's default.
 */
export function effortOf(request: MessagesRequest): 'low' | 'medium' | 'high' | null {
  const thinking = request.thinking?.type
  const asked = request.output_config?.effort
  if (asked) {
    if (!thinking || thinking === 'disabled') return 'low'
    return asked === 'low' || asked === 'medium' ? asked : 'high'
  }
  if (thinking === 'adaptive') return 'high'
  if (thinking !== 'enabled') return null
  const budget = request.thinking?.budget_tokens ?? Infinity
  return budget < 4000 ? 'low' : budget < 16000 ? 'medium' : 'high'
}

/** OpenAI's reasoning models — o-series and GPT-5 on — take `reasoning_effort` and refuse `max_tokens` / `temperature`. */
export function isOpenAiReasoning(model: string): boolean {
  const name = model.toLowerCase().replace(/^.*\//, '')
  return /^o\d/.test(name) || Number(/^gpt-(\d+)/.exec(name)?.[1] ?? 0) >= 5
}

export const newId = (prefix: string): string => `${prefix}${randomBytes(12).toString('hex')}`

/** Anthropic's error type for an HTTP status, which decides whether the CLI retries. */
export function errorType(status: number): string {
  if (status === 400) return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status === 529) return 'overloaded_error'
  return 'api_error'
}

export const errorBody = (status: number, message: string): Json => ({ type: 'error', error: { type: errorType(status), message } })

/** A rough count for `count_tokens`, which no other format has: about four characters a token. */
export function estimateTokens(request: Partial<MessagesRequest>): number {
  const size = JSON.stringify([request.system ?? '', request.messages ?? [], request.tools ?? []]).length
  return Math.max(1, Math.ceil(size / 4))
}

type Open = { index: number; kind: 'text' | 'thinking' }

/**
 * The Messages event stream for one response. Text and thinking run in one
 * block at a time, a switch closing the block before. Tool calls stay open
 * until the end: some upstreams interleave their argument deltas, and the
 * CLI files every delta under its block's index.
 */
export class AnthropicStream {
  readonly #send: (event: Json) => void
  #next = 0
  #open: Open | null = null
  readonly #tools = new Map<string, { index: number; id: string; args: boolean }>()
  #done = false

  constructor(send: (event: Json) => void, model: string) {
    this.#send = send
    send({
      type: 'message_start',
      message: {
        id: newId('msg_'),
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  get done(): boolean {
    return this.#done
  }

  get hasTools(): boolean {
    return this.#tools.size > 0
  }

  text(delta: string): void {
    if (delta) this.#delta('text', { type: 'text_delta', text: delta })
  }

  thinking(delta: string): void {
    if (delta) this.#delta('thinking', { type: 'thinking_delta', thinking: delta })
  }

  /** Opens tool call `key` (the upstream's own handle for it); returns its tool_use id. */
  toolStart(key: string, id: string, name: string): string {
    const known = this.#tools.get(key)
    if (known || this.#done) return known?.id ?? id
    this.#closeOpen()
    const index = this.#next++
    this.#tools.set(key, { index, id, args: false })
    this.#send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })
    return id
  }

  toolArgs(key: string, json: string): void {
    const tool = this.#tools.get(key)
    if (!tool || !json || this.#done) return
    tool.args = true
    this.#send({ type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: json } })
  }

  /** Closes every block, then ends the message. Only the first call counts. */
  finish(stopReason: StopReason, usage: Usage): void {
    if (this.#done) return
    this.#closeOpen()
    for (const tool of [...this.#tools.values()].sort((a, b) => a.index - b.index)) {
      // A call with no arguments still needs an input the CLI can parse.
      if (!tool.args) this.#send({ type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: '{}' } })
      this.#send({ type: 'content_block_stop', index: tool.index })
    }
    this.#done = true
    this.#send({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage })
    this.#send({ type: 'message_stop' })
  }

  /** Ends the stream with an error event: what came before stays, and no success is claimed. */
  fail(message: string): void {
    if (this.#done) return
    this.#done = true
    this.#send({ type: 'error', error: { type: 'api_error', message } })
  }

  #delta(kind: Open['kind'], delta: Json): void {
    if (this.#done) return
    if (this.#open?.kind !== kind) {
      this.#closeOpen()
      const index = this.#next++
      this.#open = { index, kind }
      this.#send({ type: 'content_block_start', index, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' } })
    }
    this.#send({ type: 'content_block_delta', index: this.#open.index, delta })
  }

  #closeOpen(): void {
    if (!this.#open) return
    this.#send({ type: 'content_block_stop', index: this.#open.index })
    this.#open = null
  }
}

/**
 * The whole message a stream of events makes, for a client that asked for no
 * stream: the CLI falls back to one when a stream breaks. Throws the error
 * event's message.
 */
export function collect(events: Json[]): Json {
  let message: Json = {}
  const content: Json[] = []
  const args = new Map<number, string>()
  for (const event of events) {
    const index = typeof event['index'] === 'number' ? event['index'] : -1
    const delta = isObject(event['delta']) ? event['delta'] : {}
    switch (event['type']) {
      case 'message_start':
        message = { ...(event['message'] as Json) }
        break
      case 'content_block_start':
        content[index] = { ...(event['content_block'] as Json) }
        break
      case 'content_block_delta': {
        const block = content[index]
        if (!block) break
        if (delta['type'] === 'text_delta') block['text'] = text(block['text']) + text(delta['text'])
        else if (delta['type'] === 'thinking_delta') block['thinking'] = text(block['thinking']) + text(delta['thinking'])
        else if (delta['type'] === 'input_json_delta') args.set(index, (args.get(index) ?? '') + text(delta['partial_json']))
        break
      }
      case 'content_block_stop': {
        const block = content[index]
        if (block?.['type'] === 'tool_use') block['input'] = parseArgs(args.get(index) ?? '')
        break
      }
      case 'message_delta':
        message = { ...message, ...delta, usage: { ...(message['usage'] as Json), ...(event['usage'] as Json) } }
        break
      case 'error':
        throw new Error(text((event['error'] as Json | undefined)?.['message']) || '上游返回了错误')
    }
  }
  return { ...message, content: content.filter(Boolean) }
}

/** A call's argument JSON as an object, `{}` when it is none: the CLI takes nothing else. */
export function parseArgs(json: string): Json {
  try {
    const value: unknown = JSON.parse(json)
    return isObject(value) ? value : {}
  } catch {
    return {}
  }
}
