/**
 * The route: where settings.json sends the CLI for a channel whose upstream
 * speaks another API. Each Messages request is translated for the channel's
 * upstream, and its answer back, streamed as it comes.
 *
 * It sits outside `/api`, with its own key: the CLI has no device cookie,
 * and behind a tunnel this server is reachable from anywhere, so without the
 * channel's route token nobody spends its upstream key.
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { ROUTE_PATH, type ChannelRoute, type RoutedFormat } from '@ccw/shared'

import { readChannels } from '../settings/channels.ts'
import { AnthropicStream, collect, errorBody, estimateTokens, isObject, type Json, type MessagesRequest } from './anthropic.ts'
import { GeminiReader, toGemini } from './gemini.ts'
import { ChatReader, toChat } from './openai-chat.ts'
import { ResponsesReader, toResponses } from './openai-responses.ts'
import { SseParser, sseFrame } from './sse.ts'
import { endpoint, post, upstreamError } from './upstream.ts'

/** Anthropic's own limit for a request. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** A reasoning model can think for minutes before its first token; pings keep the CLI from taking the silence for a dead stream. */
const PING_MS = 15_000
const PATH = new RegExp(`^${ROUTE_PATH}/([\\w-]{1,64})/v1/messages(/count_tokens)?$`)

type Reader = { push(data: string): void; end(): void }

const FORMATS: Record<RoutedFormat, { request: (request: MessagesRequest) => Json; reader: (out: AnthropicStream) => Reader }> = {
  'openai-chat': { request: toChat, reader: (out) => new ChatReader(out) },
  'openai-responses': { request: toResponses, reader: (out) => new ResponsesReader(out) },
  gemini: { request: toGemini, reader: (out) => new GeminiReader(out) },
}

export async function serveRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  res.setHeader('cache-control', 'no-store')
  const match = PATH.exec(path)
  if (!match || req.method !== 'POST') return reply(res, 404, errorBody(404, `这里只转发 POST ${ROUTE_PATH}/<渠道>/v1/messages`))
  const route = (await readChannels()).channels.find(({ id }) => id === match[1])?.route
  if (!route || !tokenMatches(req, route.token)) {
    return reply(res, 401, errorBody(401, '路由令牌对不上：这个渠道可能已被删除或改回原生格式，请到 WebUI 的设置里重新保存渠道'))
  }

  let request: MessagesRequest
  try {
    request = await readRequest(req)
  } catch (error) {
    const status = (error as { status?: number }).status ?? 400
    return reply(res, status, errorBody(status, (error as Error).message))
  }
  if (match[2]) return reply(res, 200, { input_tokens: estimateTokens(request) })
  await relay(res, route, request)
}

async function relay(res: ServerResponse, route: ChannelRoute, request: MessagesRequest): Promise<void> {
  const format = FORMATS[route.format]
  // The CLI's 1M-context marker names no model upstream.
  const model = request.model.replace(/\[1m\]$/i, '')
  const abort = new AbortController()
  // The CLI gave up (Esc, a retry): the upstream stops generating for nobody.
  res.once('close', () => abort.abort())

  let target: ReturnType<typeof endpoint>
  try {
    target = endpoint(route.format, route.baseUrl, route.key, model)
  } catch (error) {
    return reply(res, 400, errorBody(400, `渠道的请求地址有误：${(error as Error).message}`))
  }
  const { url, headers } = target
  let upstream: IncomingMessage
  try {
    upstream = await post(url, headers, format.request({ ...request, model }), abort.signal)
  } catch (error) {
    if (abort.signal.aborted) return
    return reply(res, 502, errorBody(502, `连不上 ${url.host}：${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`))
  }
  upstream.setEncoding('utf8')
  const status = upstream.statusCode ?? 502
  const type = String(upstream.headers['content-type'] ?? '')
  if (status < 200 || status >= 300 || type.includes('json')) {
    const detail = upstreamError(await readAll(upstream).catch(() => ''))
    const code = status >= 200 && status < 300 ? 502 : status
    console.error(`[ccw] route ${route.format} ${url.host} answered ${status}${detail ? `: ${detail}` : ''}`)
    return reply(res, code, errorBody(code, `${url.host} 返回 ${status}${detail ? `：${detail}` : ''}`))
  }

  const streaming = request.stream === true
  const events: Json[] = []
  let ping: NodeJS.Timeout | undefined
  if (streaming) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' })
    ping = setInterval(() => res.write(sseFrame({ type: 'ping' })), PING_MS)
  }
  const out = new AnthropicStream((event) => (streaming ? res.write(sseFrame(event)) : events.push(event)), request.model)
  const reader = format.reader(out)
  const parser = new SseParser()
  try {
    for await (const chunk of upstream as AsyncIterable<string>) {
      for (const event of parser.push(chunk)) reader.push(event.data)
    }
    for (const event of parser.end()) reader.push(event.data)
    reader.end()
  } catch (error) {
    if (abort.signal.aborted) return
    out.fail(`读取 ${url.host} 的响应时出错：${(error as Error).message}`)
  } finally {
    clearInterval(ping)
  }
  if (streaming) return void res.end()
  try {
    reply(res, 200, collect(events))
  } catch (error) {
    reply(res, 502, errorBody(502, (error as Error).message))
  }
}

/** The CLI sends its key as a Bearer token or as `x-api-key`, by the auth field settings.json sets. */
function tokenMatches(req: IncomingMessage, token: string): boolean {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
  const apiKey = req.headers['x-api-key']
  const given = Buffer.from((typeof apiKey === 'string' ? apiKey : bearer) ?? '')
  const expected = Buffer.from(token)
  return token.length > 0 && given.length === expected.length && timingSafeEqual(given, expected)
}

async function readRequest(req: IncomingMessage): Promise<MessagesRequest> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error(`请求超过 ${MAX_BODY_BYTES / 1024 / 1024}MB`), { status: 413 })
    chunks.push(chunk)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是 JSON')
  }
  if (!isObject(body) || typeof body['model'] !== 'string' || !Array.isArray(body['messages'])) throw new Error('请求体不是 Messages 请求')
  return body as MessagesRequest
}

async function readAll(stream: IncomingMessage): Promise<string> {
  let text = ''
  for await (const chunk of stream as AsyncIterable<string>) text += chunk
  return text
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
