/**
 * Messages ⇄ OpenAI Responses. Mapping after CC Switch's
 * `transform_responses.rs` and `streaming_responses.rs`: the system prompt
 * becomes `instructions`, each turn input items — tool calls and results as
 * `function_call` / `function_call_output` items of their own — and the
 * named stream events become Messages blocks.
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
  type Usage,
} from './anthropic.ts'

/** The Responses API refuses a smaller `max_output_tokens`; Claude clients probe with 1. */
const MIN_OUTPUT_TOKENS = 16

export function toResponses(request: MessagesRequest): Json {
  const reasoning = isOpenAiReasoning(request.model)
  const instructions = systemText(request)
  const tools = liveTools(request).map(({ name, description, input_schema }) => ({
    type: 'function',
    name,
    ...(description ? { description } : {}),
    parameters: input_schema,
    // Omitted, `strict` counts as true: every optional parameter becomes required.
    strict: false,
  }))
  const choice = request.tool_choice
  const effort = reasoning ? effortOf(request) : null
  return {
    model: request.model,
    ...(instructions ? { instructions } : {}),
    input: turns(request).flatMap(inputItems),
    stream: true,
    // The conversation is sent whole every time; nothing needs keeping upstream.
    store: false,
    ...(request.max_tokens ? { max_output_tokens: Math.max(MIN_OUTPUT_TOKENS, request.max_tokens) } : {}),
    ...(!reasoning && request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(!reasoning && request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && choice ? { tool_choice: responsesToolChoice(choice) } : {}),
    ...(tools.length > 0 && choice?.disable_parallel_tool_use ? { parallel_tool_calls: false } : {}),
  }
}

function responsesToolChoice(choice: NonNullable<MessagesRequest['tool_choice']>): unknown {
  if (choice.type === 'any') return 'required'
  if (choice.type === 'tool' && choice.name) return { type: 'function', name: choice.name }
  return choice.type === 'none' ? 'none' : 'auto'
}

/** One turn as input items, in order: a tool call or result ends the message before it and stands alone. */
function inputItems(message: Message): Json[] {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  const items: Json[] = []
  let content: Json[] = []
  const flush = (): void => {
    if (content.length > 0) items.push({ role, content })
    content = []
  }
  for (const block of blocksOf(message.content)) {
    if (block.type === 'tool_use') {
      flush()
      items.push({ type: 'function_call', call_id: block['id'], name: block['name'], arguments: JSON.stringify(block['input'] ?? {}) })
    } else if (block.type === 'tool_result') {
      flush()
      const result = toolResultOf(block)
      const images = result.images.flatMap(inputPart)
      items.push({
        type: 'function_call_output',
        call_id: block['tool_use_id'],
        output: images.length > 0 ? [...(result.text ? [{ type: 'input_text', text: result.text }] : []), ...images] : result.text,
      })
    } else if (block.type === 'text' && block['text']) {
      content.push({ type: textType, text: block['text'] })
    } else if (role !== 'assistant') {
      content.push(...inputPart(block))
    }
  }
  flush()
  return items
}

function inputPart(block: Block): Json[] {
  const media = mediaUrl(block)
  if (block.type === 'image' && media) return [{ type: 'input_image', image_url: media.url }]
  if (block.type === 'document') {
    if (media?.data) return [{ type: 'input_file', filename: String(block['title'] ?? 'document.pdf'), file_data: media.url }]
    if (media) return [{ type: 'input_file', file_url: media.url }]
    const text = textOf([block])
    return text ? [{ type: 'input_text', text }] : []
  }
  return []
}

/**
 * Reads a Responses stream into Messages events. Calls are keyed by
 * `output_index`. Some gateways send a call's arguments only with its `done`
 * events, so those are used when no delta came first.
 */
export class ResponsesReader {
  readonly #out: AnthropicStream
  readonly #streamed = new Set<string>()

  constructor(out: AnthropicStream) {
    this.#out = out
  }

  push(data: string): void {
    let event: Json
    try {
      event = JSON.parse(data) as Json
    } catch {
      return
    }
    const key = String(event['output_index'] ?? event['item_id'] ?? '')
    const item = isObject(event['item']) ? event['item'] : null
    const delta = typeof event['delta'] === 'string' ? event['delta'] : ''
    switch (event['type']) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        return this.#out.text(delta)
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return this.#out.thinking(delta)
      case 'response.output_item.added':
        if (item?.['type'] === 'function_call') this.#start(key, item)
        return
      case 'response.function_call_arguments.delta':
        this.#streamed.add(key)
        return this.#out.toolArgs(key, delta)
      case 'response.function_call_arguments.done':
        if (typeof event['arguments'] === 'string') this.#late(key, event['arguments'])
        return
      case 'response.output_item.done':
        if (item?.['type'] === 'function_call') {
          this.#start(key, item)
          if (typeof item['arguments'] === 'string') this.#late(key, item['arguments'])
        }
        return
      case 'response.completed':
      case 'response.incomplete':
        return this.#finish(isObject(event['response']) ? event['response'] : {})
      case 'response.failed': {
        const response = isObject(event['response']) ? event['response'] : {}
        const error = isObject(response['error']) ? response['error'] : {}
        return this.#out.fail(String(error['message'] ?? '上游报告请求失败'))
      }
      case 'error': {
        const error = isObject(event['error']) ? event['error'] : event
        return this.#out.fail(typeof error['message'] === 'string' ? error['message'] : '上游返回了错误')
      }
    }
  }

  end(): void {
    if (!this.#out.done) this.#out.fail('上游的流在回答结束之前断开了')
  }

  #start(key: string, item: Json): void {
    this.#out.toolStart(key, String(item['call_id'] || item['id'] || newId('toolu_')), String(item['name'] ?? ''))
  }

  #late(key: string, args: string): void {
    if (this.#streamed.has(key)) return
    this.#streamed.add(key)
    this.#out.toolArgs(key, args)
  }

  #finish(response: Json): void {
    const incomplete = isObject(response['incomplete_details']) ? response['incomplete_details']['reason'] : undefined
    const stop =
      response['status'] === 'incomplete' && (incomplete === 'max_output_tokens' || incomplete === undefined)
        ? 'max_tokens'
        : this.#out.hasTools
          ? 'tool_use'
          : 'end_turn'
    this.#out.finish(stop, responsesUsage(isObject(response['usage']) ? response['usage'] : {}))
  }
}

/** `input_tokens` counts the cached ones too; Anthropic keeps them apart. */
function responsesUsage(usage: Json): Usage {
  const count = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0)
  const details = isObject(usage['input_tokens_details']) ? usage['input_tokens_details'] : {}
  const cached = count(details['cached_tokens'])
  return {
    input_tokens: Math.max(0, count(usage['input_tokens']) - cached),
    output_tokens: count(usage['output_tokens']),
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  }
}
