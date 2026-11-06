/**
 * Messages ⇄ OpenAI Chat Completions. Mapping after CC Switch's
 * `proxy/providers/transform.rs` and `streaming.rs`: system blocks become one
 * system message, tool results their own `tool` messages, tool calls
 * `tool_calls`; the stream's deltas become Messages blocks, its last
 * `finish_reason` and usage the message's end.
 */

import {
  blocksOf,
  effortOf,
  isObject,
  isOpenAiReasoning,
  liveTools,
  mediaUrl,
  newId,
  systemText,
  textOf,
  toolResultOf,
  turns,
  type AnthropicStream,
  type Block,
  type Json,
  type Message,
  type MessagesRequest,
  type StopReason,
  type Usage,
} from './anthropic.ts'

export function toChat(request: MessagesRequest): Json {
  const reasoning = isOpenAiReasoning(request.model)
  const system = systemText(request)
  const messages: Json[] = system ? [{ role: 'system', content: system }] : []
  // DeepSeek and MiMo refuse a tool-calling assistant turn of a thinking model without its reasoning.
  const echoReasoning = /deepseek|mimo/i.test(request.model)
  for (const message of turns(request)) messages.push(...chatMessages(message, echoReasoning))

  const tools = liveTools(request).map(({ name, description, input_schema }) => ({
    type: 'function',
    function: { name, ...(description ? { description } : {}), parameters: input_schema },
  }))
  const choice = request.tool_choice
  const effort = reasoning ? effortOf(request) : null
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.max_tokens ? { [reasoning ? 'max_completion_tokens' : 'max_tokens']: request.max_tokens } : {}),
    ...(!reasoning && request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(!reasoning && request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.stop_sequences?.length ? { stop: request.stop_sequences } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && choice ? { tool_choice: chatToolChoice(choice) } : {}),
    ...(tools.length > 0 && choice?.disable_parallel_tool_use ? { parallel_tool_calls: false } : {}),
  }
}

function chatToolChoice(choice: NonNullable<MessagesRequest['tool_choice']>): unknown {
  if (choice.type === 'any') return 'required'
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } }
  return choice.type === 'none' ? 'none' : 'auto'
}

/**
 * One Messages turn as Chat messages. A user turn's tool results come first,
 * each a `tool` message right after the call it answers; a `tool` message
 * holds no image, so theirs follow in the user message after them.
 */
function chatMessages(message: Message, echoReasoning: boolean): Json[] {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  if (typeof message.content === 'string') return [{ role, content: message.content }]
  const blocks = blocksOf(message.content)

  if (role === 'assistant') {
    const text = blocks.filter((block) => block.type === 'text').map((block) => String(block['text'] ?? '')).join('')
    const calls = blocks
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: block['id'], type: 'function', function: { name: block['name'], arguments: JSON.stringify(block['input'] ?? {}) } }))
    if (!text && calls.length === 0) return []
    const reasoning = blocks.filter((block) => block.type === 'thinking').map((block) => String(block['thinking'] ?? '')).join('\n')
    return [{
      role,
      content: text || null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
      ...(echoReasoning && calls.length > 0 ? { reasoning_content: reasoning || 'tool call' } : {}),
    }]
  }

  const results: Json[] = []
  const parts: Json[] = []
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const result = toolResultOf(block)
      results.push({ role: 'tool', tool_call_id: block['tool_use_id'], content: result.text || (result.isError ? 'error' : '') })
      parts.push(...result.images.flatMap(chatPart))
    } else {
      parts.push(...chatPart(block))
    }
  }
  if (parts.length === 0) return results
  const content = parts.length === 1 && parts[0]!['type'] === 'text' ? parts[0]!['text'] : parts
  return [...results, { role, content }]
}

function chatPart(block: Block): Json[] {
  if (block.type === 'text') return block['text'] ? [{ type: 'text', text: block['text'] }] : []
  const media = mediaUrl(block)
  if (block.type === 'image' && media) return [{ type: 'image_url', image_url: { url: media.url } }]
  if (block.type === 'document') {
    if (media?.data) return [{ type: 'file', file: { filename: String(block['title'] ?? 'document.pdf'), file_data: media.url } }]
    const text = textOf([block])
    return text ? [{ type: 'text', text }] : []
  }
  return []
}

const STOP: Record<string, StopReason> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use' }

/**
 * Reads a Chat Completions stream into Messages events. Some gateways send
 * `finish_reason` more than once, or usage in a chunk after it, so the end
 * waits for `[DONE]` — or for the stream to close, once a finish was seen.
 */
export class ChatReader {
  readonly #out: AnthropicStream
  #finish: string | null = null
  #usage: Usage = { input_tokens: 0, output_tokens: 0 }
  /** Calls by `index`; the arguments that came before the name wait in `pending`. */
  readonly #calls = new Map<number, { id: string; name: string; pending: string }>()

  constructor(out: AnthropicStream) {
    this.#out = out
  }

  push(data: string): void {
    if (data.trim() === '[DONE]') return this.#end()
    let chunk: Json
    try {
      chunk = JSON.parse(data) as Json
    } catch {
      return
    }
    if (isObject(chunk['error'])) return this.#out.fail(String(chunk['error']['message'] ?? JSON.stringify(chunk['error'])))
    if (isObject(chunk['usage'])) this.#usage = chatUsage(chunk['usage'])
    const choice = Array.isArray(chunk['choices']) && isObject(chunk['choices'][0]) ? chunk['choices'][0] : null
    if (!choice) return
    const delta = isObject(choice['delta']) ? choice['delta'] : {}
    // OpenRouter, Kimi and others say `reasoning`, DeepSeek `reasoning_content`.
    const reasoning = delta['reasoning_content'] ?? delta['reasoning']
    if (typeof reasoning === 'string') this.#out.thinking(reasoning)
    if (typeof delta['content'] === 'string') this.#out.text(delta['content'])
    if (Array.isArray(delta['tool_calls'])) {
      for (const call of delta['tool_calls']) if (isObject(call)) this.#call(call)
    }
    if (typeof choice['finish_reason'] === 'string' && !this.#finish) this.#finish = choice['finish_reason']
  }

  /** The upstream closed: a stream cut before any finish is an error, not an answer. */
  end(): void {
    if (this.#out.done) return
    if (this.#finish) this.#end()
    else this.#out.fail('上游的流在回答结束之前断开了')
  }

  #call(call: Json): void {
    const index = typeof call['index'] === 'number' ? call['index'] : 0
    const fn = isObject(call['function']) ? call['function'] : {}
    let entry = this.#calls.get(index)
    if (!entry) {
      entry = { id: '', name: '', pending: '' }
      this.#calls.set(index, entry)
    }
    if (typeof call['id'] === 'string' && call['id']) entry.id ||= call['id']
    if (typeof fn['name'] === 'string' && fn['name']) entry.name ||= fn['name']
    const args = typeof fn['arguments'] === 'string' ? fn['arguments'] : ''
    const key = String(index)
    if (!entry.name) {
      entry.pending += args
      return
    }
    entry.id ||= newId('toolu_')
    this.#out.toolStart(key, entry.id, entry.name)
    this.#out.toolArgs(key, entry.pending + args)
    entry.pending = ''
  }

  #end(): void {
    const stop = this.#out.hasTools ? 'tool_use' : (STOP[this.#finish ?? ''] ?? 'end_turn')
    this.#out.finish(stop, this.#usage)
  }
}

/** OpenAI counts cached prompt tokens inside `prompt_tokens`; Anthropic apart from `input_tokens`. */
function chatUsage(usage: Json): Usage {
  const count = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0)
  const details = isObject(usage['prompt_tokens_details']) ? usage['prompt_tokens_details'] : {}
  const cached = count(usage['cache_read_input_tokens']) || count(details['cached_tokens']) || count(usage['prompt_cache_hit_tokens'])
  return {
    input_tokens: Math.max(0, count(usage['prompt_tokens']) - cached),
    output_tokens: count(usage['completion_tokens']),
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  }
}
