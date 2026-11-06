/**
 * Where a routed channel's upstream answers, and how it is asked: each
 * format's endpoint under the address the user gave, its auth header, and
 * the request itself, through HTTPS_PROXY as the CLI's own would go.
 */

import http from 'node:http'
import https from 'node:https'

import type { RoutedFormat } from '@ccw/shared'

/** `proxyEnv` is Node 22.21 / 24.5+; @types/node 22.20 does not declare it. Older Nodes connect directly. */
type ProxiedAgentOptions = http.AgentOptions & { proxyEnv?: NodeJS.ProcessEnv }

// Node reads NO_PROXY as plain host names, not the `127.*` / `<local>` globs other tools accept, and a
// gateway on this machine is out of a remote proxy's reach: loopback never goes through one.
const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|\[::1\])$/i

/** Agent options for `url`: HTTPS_PROXY / NO_PROXY honoured, as by the CLI — Node's `fetch` ignores them. */
export function proxyOptions(url: URL): ProxiedAgentOptions {
  return LOOPBACK.test(url.hostname) ? {} : { proxyEnv: process.env }
}

/** A path segment naming an API version: `v1`, `v4`, `v1beta`. */
const VERSION = /\/v\d+[a-z\d]*$/i

/**
 * `path` under `baseUrl`: the address's own path, less a trailing `strip`,
 * then `version` unless the address names one already.
 */
function under(baseUrl: string, strip: RegExp, version: string, path: string): URL {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error('请求地址不是有效的网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('请求地址要以 http:// 或 https:// 开头')
  // Kept as a string: an empty URL pathname reads back as `/`.
  let prefix = url.pathname.replace(/\/+$/, '').replace(strip, '')
  if (!VERSION.test(prefix)) prefix += version
  url.pathname = prefix + path
  url.search = ''
  url.hash = ''
  return url
}

/**
 * `path` under an OpenAI-style address. Gateways are given with their version
 * (`…/v1`, `…/api/v3`, `…/paas/v4`) or without (`https://api.openai.com`),
 * and sometimes as a whole endpoint; each comes out at the same place.
 */
export function openAiUrl(baseUrl: string, path: '/chat/completions' | '/responses' | '/models'): URL {
  return under(baseUrl, /\/(?:chat\/completions|responses|models)$/, '/v1', path)
}

/** `path` under a Gemini address, `/v1beta` unless the address names its own version. */
export function geminiUrl(baseUrl: string, path: string): URL {
  return under(baseUrl, /\/models(?:\/.*)?$/, '/v1beta', path)
}

/** The streaming endpoint and auth header for one request to `model`. */
export function endpoint(format: RoutedFormat, baseUrl: string, key: string, model: string): { url: URL; headers: Record<string, string> } {
  const token = key.trim()
  if (format === 'gemini') {
    const url = geminiUrl(baseUrl, `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:streamGenerateContent`)
    url.search = '?alt=sse'
    return { url, headers: token ? { 'x-goog-api-key': token } : {} }
  }
  const url = openAiUrl(baseUrl, format === 'openai-chat' ? '/chat/completions' : '/responses')
  return { url, headers: token ? { authorization: `Bearer ${token}` } : {} }
}

/** POSTs `body` as JSON; the reply comes back unread, whatever its status. */
export function post(url: URL, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<http.IncomingMessage> {
  const secure = url.protocol === 'https:'
  const options = proxyOptions(url)
  const agent = secure ? new https.Agent(options) : new http.Agent(options)
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const settings = {
      method: 'POST',
      agent,
      signal,
      headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream, application/json', 'content-length': String(payload.length) },
    }
    const request = (secure ? https : http).request(url, settings, (res) => {
      res.once('close', () => agent.destroy())
      resolve(res)
    })
    request.on('error', (error) => {
      agent.destroy()
      reject(error)
    })
    request.end(payload)
  })
}

/** The message in an upstream's error body, or nothing for a web page or an empty body. */
export function upstreamError(body: string): string {
  let message = ''
  try {
    const json: unknown = JSON.parse(body)
    const root = Array.isArray(json) ? json[0] : json
    const error = typeof root === 'object' && root !== null ? (root as Record<string, unknown>)['error'] : undefined
    const found = typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['message'] : (error ?? (root as Record<string, unknown> | null)?.['message'])
    if (typeof found === 'string') message = found
  } catch {
    if (!body.trimStart().startsWith('<')) message = body
  }
  return message.replace(/\s+/g, ' ').trim().slice(0, 500)
}
