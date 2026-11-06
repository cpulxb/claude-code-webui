import http from 'node:http'
import https from 'node:https'

import type { RoutedFormat, RpcParams, UpstreamModel } from '@ccw/shared'

import { geminiUrl, openAiUrl, proxyOptions } from '../route/upstream.ts'

type Channel = RpcParams<'settings.fetchModels'>

const TIMEOUT_MS = 15_000

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ok = (status: number): boolean => status >= 200 && status < 300

/**
 * Lists what `<baseUrl>/v1/models` offers, asked the way the CLI asks its
 * channel: the same auth header for the chosen field, and HTTPS_PROXY /
 * NO_PROXY honoured. Node's `fetch` ignores those, and a gateway that is only
 * reachable through the proxy would time out here while the CLI works.
 */
export async function fetchUpstreamModels({ baseUrl, authField, key, format }: Channel, timeoutMs = TIMEOUT_MS): Promise<UpstreamModel[]> {
  if (format && format !== 'anthropic') return fetchRoutedModels(format, baseUrl, key, timeoutMs)
  const url = modelsUrl(baseUrl)
  const token = key.trim()
  const ask = async (field: Channel['authField']): Promise<{ status: number; body: string }> => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
      ...(token ? (field === 'ANTHROPIC_API_KEY' ? { 'x-api-key': token } : { authorization: `Bearer ${token}` }) : {}),
    }
    try {
      return await get(url, headers, timeoutMs)
    } catch (error) {
      throw new Error(`连不上 ${url.host}：${reason(error, timeoutMs)}`)
    }
  }

  let reply = await ask(authField)
  // Some gateways take x-api-key on /v1/messages, where the CLI uses it, but
  // list models only for a Bearer token (all CC Switch ever sends), or the
  // reverse. Refused in both, the chosen header's refusal is the one reported.
  if (token && (reply.status === 401 || reply.status === 403)) {
    const retry = await ask(authField === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY')
    if (ok(retry.status)) reply = retry
  }
  return listOf(url, reply, 'data', (item) => ({ id: item['id'], owner: item['owned_by'] }))
}

/**
 * The list a routed channel's upstream gives, in its own format's way: an
 * OpenAI-style `/models` for a Bearer key, or Gemini's `models` for an
 * `x-goog-api-key`, keeping the models that can generate content.
 */
async function fetchRoutedModels(format: RoutedFormat, baseUrl: string, key: string, timeoutMs: number): Promise<UpstreamModel[]> {
  const gemini = format === 'gemini'
  const url = gemini ? geminiUrl(baseUrl, '/models') : openAiUrl(baseUrl, '/models')
  if (gemini) url.search = '?pageSize=1000'
  const token = key.trim()
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(token ? (gemini ? { 'x-goog-api-key': token } : { authorization: `Bearer ${token}` }) : {}),
  }
  let reply: { status: number; body: string }
  try {
    reply = await get(url, headers, timeoutMs)
  } catch (error) {
    throw new Error(`连不上 ${url.host}：${reason(error, timeoutMs)}`)
  }
  if (!gemini) return listOf(url, reply, 'data', (item) => ({ id: item['id'], owner: item['owned_by'] }))
  return listOf(url, reply, 'models', (item) => {
    const methods = item['supportedGenerationMethods']
    if (Array.isArray(methods) && !methods.includes('generateContent')) return { id: '' }
    return { id: typeof item['name'] === 'string' ? item['name'].replace(/^models\//, '') : '' }
  })
}

/** The models in the reply's `field` array, each as `pick` reads it; entries without an id, or repeated, are dropped. */
function listOf(
  url: URL,
  reply: { status: number; body: string },
  field: string,
  pick: (item: Record<string, unknown>) => { id: unknown; owner?: unknown },
): UpstreamModel[] {
  const endpoint = `${url.origin}${url.pathname}`
  if (!ok(reply.status)) throw new Error(`${endpoint} 返回 ${reply.status}${detail(reply.body)}`)

  let json: unknown
  try {
    json = JSON.parse(reply.body)
  } catch {
    throw new Error(`${endpoint} 返回的不是 JSON，这个渠道可能没有模型列表端点`)
  }
  const data = isObject(json) ? json[field] : undefined
  if (!Array.isArray(data)) throw new Error(`${endpoint} 的响应里没有 ${field} 数组，这个渠道可能不支持模型列表`)

  const seen = new Set<string>()
  const models: UpstreamModel[] = []
  for (const item of data) {
    const picked = isObject(item) ? pick(item) : { id: '' }
    const id = typeof picked.id === 'string' ? picked.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const owner = typeof picked.owner === 'string' ? picked.owner.trim() : ''
    models.push(owner ? { id, owner } : { id })
  }
  return models
}

/** The CLI posts to `<base>/v1/messages`, so its sibling `<base>/v1/models` is the list. */
function modelsUrl(baseUrl: string): URL {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error('请求地址不是有效的网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('请求地址要以 http:// 或 https:// 开头')
  // Anthropic lists 20 a page by default; 1000 is its maximum, and others ignore the parameter.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/models`
  url.search = '?limit=1000'
  url.hash = ''
  return url
}

function get(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
  const options = proxyOptions(url)
  const secure = url.protocol === 'https:'
  const agent = secure ? new https.Agent(options) : new http.Agent(options)
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const onReply = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    }
    // A deadline for the whole exchange: the socket timeout alone would let a trickling reply run on.
    const settings = { agent, headers, signal: AbortSignal.timeout(timeoutMs) }
    const request = secure ? https.get(url, settings, onReply) : http.get(url, settings, onReply)
    request.on('error', reject)
  }).finally(() => agent.destroy())
}

function reason(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return `超过 ${timeoutMs / 1000} 秒没有响应`
    const { code } = error as NodeJS.ErrnoException
    if (code) return code
    return error.message
  }
  return String(error)
}

/** `：message` from an error body, or nothing when it is empty or a web page. */
function detail(body: string): string {
  let message = ''
  try {
    const json: unknown = JSON.parse(body)
    const error = isObject(json) ? json['error'] : undefined
    const found = isObject(error) ? error['message'] : isObject(json) ? (json['message'] ?? error) : undefined
    if (typeof found === 'string') message = found
  } catch {
    if (!body.trimStart().startsWith('<')) message = body
  }
  message = message.replace(/\s+/g, ' ').trim()
  return message ? `：${message.slice(0, 160)}` : ''
}
