/**
 * Messages ⇄ Gemini `streamGenerateContent`. Mapping after CC Switch's
 * `transform_gemini.rs` and `streaming_gemini.rs`, checked against the
 * Gemini API reference: the system prompt becomes `systemInstruction`,
 * assistant turns `model` contents, tool calls `functionCall` parts and
 * their results `functionResponse` parts — answered by the tool's name,
 * which the tool_use earlier in the conversation gives.
 */

import {
  blocksOf,
  isObject,
  liveTools,
  mediaUrl,
  newId,
  systemText,
  textOf,
  toolNames,
  toolResultOf,
  turns,
  type AnthropicStream,
  type Block,
  type Json,
  type MessagesRequest,
  type Usage,
} from './anthropic.ts'

/** Marks a tool_use id made up here, because Gemini gave none: it is never sent back as Gemini's. */
const MADE_UP = 'toolu_gemini_'

/**
 * Gemini 3 refuses a replayed function call without the `thoughtSignature`
 * it came with, and the Messages format has nowhere to keep one. So they are
 * kept here, by tool_use id, as many as a long session needs.
 */
const signatures = new Map<string, string>()
const MAX_SIGNATURES = 5000
/** Gemini's documented stand-in for a signature lost (a server restart): the call is taken unchecked. */
const SKIP_SIGNATURE = 'skip_thought_signature_validator'

function remember(id: string, signature: string): void {
  signatures.delete(id)
  signatures.set(id, signature)
  if (signatures.size > MAX_SIGNATURES) signatures.delete(signatures.keys().next().value!)
}

export function toGemini(request: MessagesRequest): Json {
  const names = toolNames(request)
  const contents: Json[] = []
  for (const message of turns(request)) {
    const blocks = blocksOf(message.content)
    if (message.role === 'assistant') {
      const parts = modelParts(blocks)
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }
    // A user turn's function responses go first and alone: Gemini refuses
    // them mixed with the text the CLI adds after its tool results.
    const answers: Json[] = []
    const parts: Json[] = []
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const id = String(block['tool_use_id'] ?? '')
        const result = toolResultOf(block)
        answers.push({
          functionResponse: {
            ...(id && !id.startsWith(MADE_UP) ? { id } : {}),
            name: names.get(id) || 'unknown',
            response: result.isError ? { error: result.text } : { output: result.text },
          },
        })
        parts.push(...result.images.flatMap(userPart))
      } else {
        parts.push(...userPart(block))
      }
    }
    if (answers.length > 0) contents.push({ role: 'user', parts: answers })
    if (parts.length > 0) contents.push({ role: 'user', parts })
  }

  const system = systemText(request)
  const tools = liveTools(request).map(({ name, description, input_schema }) => ({
    name,
    description: description ?? '',
    // The JSON Schema channel: `parameters` takes only an OpenAPI subset, and the CLI's schemas go beyond it.
    parametersJsonSchema: input_schema,
  }))
  const choice = request.tool_choice
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {}),
    ...(tools.length > 0 && choice ? { toolConfig: { functionCallingConfig: geminiToolChoice(choice) } } : {}),
    generationConfig: {
      ...(request.max_tokens ? { maxOutputTokens: request.max_tokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
      ...(request.top_k !== undefined ? { topK: request.top_k } : {}),
      ...(request.stop_sequences?.length ? { stopSequences: request.stop_sequences } : {}),
    },
  }
}

function geminiToolChoice(choice: NonNullable<MessagesRequest['tool_choice']>): Json {
  if (choice.type === 'tool' && choice.name) return { mode: 'ANY', allowedFunctionNames: [choice.name] }
  return { mode: choice.type === 'any' ? 'ANY' : choice.type === 'none' ? 'NONE' : 'AUTO' }
}

/**
 * An assistant turn's parts. Each call gets its signature back; Gemini only
 * checks the first call of a step, so that one alone gets the stand-in when
 * its own is lost.
 */
function modelParts(blocks: Block[]): Json[] {
  const parts: Json[] = []
  let first = true
  for (const block of blocks) {
    if (block.type === 'text' && block['text']) parts.push({ text: block['text'] })
    if (block.type !== 'tool_use') continue
    const id = String(block['id'] ?? '')
    const signature = signatures.get(id) ?? (first ? SKIP_SIGNATURE : undefined)
    first = false
    parts.push({
      functionCall: { ...(id && !id.startsWith(MADE_UP) ? { id } : {}), name: block['name'], args: isObject(block['input']) ? block['input'] : {} },
      ...(signature ? { thoughtSignature: signature } : {}),
    })
  }
  return parts
}

function userPart(block: Block): Json[] {
  if (block.type === 'text') return block['text'] ? [{ text: block['text'] }] : []
  const media = mediaUrl(block)
  if ((block.type === 'image' || block.type === 'document') && media?.data) return [{ inlineData: { mimeType: media.mediaType, data: media.data } }]
  if (block.type === 'image' && media) return [{ fileData: { mimeType: media.mediaType || 'image/png', fileUri: media.url } }]
  const text = block.type === 'document' ? textOf([block]) : ''
  return text ? [{ text }] : []
}

/**
 * Reads a Gemini stream into Messages events. Each chunk is a whole
 * GenerateContentResponse: text arrives in pieces, each function call whole.
 * The finish reason and usage of the last chunk end the message.
 */
export class GeminiReader {
  readonly #out: AnthropicStream
  #finish = ''
  #usage: Usage = { input_tokens: 0, output_tokens: 0 }
  readonly #seen = new Set<string>()

  constructor(out: AnthropicStream) {
    this.#out = out
  }

  push(data: string): void {
    let chunk: Json
    try {
      chunk = JSON.parse(data) as Json
    } catch {
      return
    }
    if (isObject(chunk['error'])) return this.#out.fail(String(chunk['error']['message'] ?? JSON.stringify(chunk['error'])))
    const feedback = isObject(chunk['promptFeedback']) ? chunk['promptFeedback'] : {}
    if (typeof feedback['blockReason'] === 'string') return this.#out.fail(`Gemini 拒绝了这次请求（${feedback['blockReason']}）`)
    if (isObject(chunk['usageMetadata'])) this.#usage = geminiUsage(chunk['usageMetadata'])
    const candidate = Array.isArray(chunk['candidates']) && isObject(chunk['candidates'][0]) ? chunk['candidates'][0] : {}
    const content = isObject(candidate['content']) ? candidate['content'] : {}
    for (const part of Array.isArray(content['parts']) ? content['parts'] : []) {
      if (!isObject(part)) continue
      if (typeof part['text'] === 'string') {
        if (part['thought'] === true) this.#out.thinking(part['text'])
        else this.#out.text(part['text'])
      }
      if (isObject(part['functionCall'])) this.#call(part['functionCall'], part['thoughtSignature'])
    }
    if (typeof candidate['finishReason'] === 'string') this.#finish = candidate['finishReason']
  }

  end(): void {
    if (this.#out.done) return
    if (this.#finish === 'MAX_TOKENS') return this.#out.finish('max_tokens', this.#usage)
    if (this.#finish && this.#finish !== 'STOP' && this.#finish !== 'FINISH_REASON_UNSPECIFIED') {
      return this.#out.fail(`Gemini 中止了回答（${this.#finish}）`)
    }
    if (!this.#finish && !this.#out.hasTools) return this.#out.fail('上游的流在回答结束之前断开了')
    this.#out.finish(this.#out.hasTools ? 'tool_use' : 'end_turn', this.#usage)
  }

  #call(call: Json, signature: unknown): void {
    const given = typeof call['id'] === 'string' ? call['id'] : ''
    // Some relays repeat a call in a later chunk; a call with an id is told once.
    if (given && this.#seen.has(given)) return
    if (given) this.#seen.add(given)
    const id = given || newId(MADE_UP)
    if (typeof signature === 'string' && signature) remember(id, signature)
    this.#out.toolStart(id, id, String(call['name'] ?? ''))
    this.#out.toolArgs(id, JSON.stringify(isObject(call['args']) ? call['args'] : {}))
  }
}

/** `promptTokenCount` counts the cached tokens too, and the output is the answer plus the thinking. */
function geminiUsage(usage: Json): Usage {
  const count = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0)
  const cached = count(usage['cachedContentTokenCount'])
  return {
    input_tokens: Math.max(0, count(usage['promptTokenCount']) - cached),
    output_tokens: count(usage['candidatesTokenCount']) + count(usage['thoughtsTokenCount']),
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  }
}
