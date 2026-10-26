import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, test, type TestContext } from 'node:test'

import { fetchUpstreamModels } from '../src/settings/upstream-models.ts'

const PROXY_ENV = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']
let saved: Record<string, string | undefined>

// A developer's own proxy would otherwise swallow the requests to these local servers.
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

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** A gateway on a free port; `seen` collects what it was asked. */
async function gateway(t: TestContext, handler: Handler): Promise<{ url: string; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = []
  const server = createServer((req, res) => {
    seen.push(req)
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const json = (body: unknown, status = 200): Handler => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const bearer = { authField: 'ANTHROPIC_AUTH_TOKEN', key: 'sk-secret' } as const

test('models are listed from /v1/models with the owner, skipping duplicates and entries without an id', async (t) => {
  const { url, seen } = await gateway(t, json({
    object: 'list',
    data: [
      { id: 'jamba-1-5-large', owned_by: 'ai21' },
      { id: 'qwen-plus', owned_by: 'alibaba' },
      { id: 'jamba-1-5-large', owned_by: 'ai21' },
      { id: 'claude-opus-4-8' },
      { owned_by: 'nobody' },
      'garbage',
    ],
  }))
  const models = await fetchUpstreamModels({ baseUrl: url, ...bearer })
  assert.deepEqual(models, [
    { id: 'jamba-1-5-large', owner: 'ai21' },
    { id: 'qwen-plus', owner: 'alibaba' },
    { id: 'claude-opus-4-8' },
  ])
  assert.equal(seen[0]!.url, '/v1/models?limit=1000')
})

test('the key goes in the header of the chosen auth field, and only there', async (t) => {
  const { url, seen } = await gateway(t, json({ data: [] }))
  await fetchUpstreamModels({ baseUrl: url, authField: 'ANTHROPIC_AUTH_TOKEN', key: ' sk-a ' })
  await fetchUpstreamModels({ baseUrl: url, authField: 'ANTHROPIC_API_KEY', key: 'sk-b' })
  await fetchUpstreamModels({ baseUrl: url, authField: 'ANTHROPIC_API_KEY', key: '  ' })
  const [token, apiKey, none] = seen.map((req) => req.headers)
  assert.equal(token!['authorization'], 'Bearer sk-a')
  assert.equal(token!['x-api-key'], undefined)
  assert.equal(apiKey!['x-api-key'], 'sk-b')
  assert.equal(apiKey!['authorization'], undefined)
  assert.equal(none!['x-api-key'], undefined)
  assert.equal(none!['authorization'], undefined)
  assert.equal(apiKey!['anthropic-version'], '2023-06-01')
})

test('a key refused in the chosen header is tried in the other, as a gateway listing models only for one needs', async (t) => {
  const onlyBearer = await gateway(t, (req, res) => {
    if (req.headers['authorization'] === 'Bearer sk-a') json({ data: [{ id: 'claude-opus-5-5' }] })(req, res)
    else json({ error: { message: 'Invalid or revoked API key.' } }, 401)(req, res)
  })
  const models = await fetchUpstreamModels({ baseUrl: onlyBearer.url, authField: 'ANTHROPIC_API_KEY', key: 'sk-a' })
  assert.deepEqual(models, [{ id: 'claude-opus-5-5' }])
  assert.deepEqual(onlyBearer.seen.map((req) => [req.headers['x-api-key'], req.headers['authorization']]), [
    ['sk-a', undefined],
    [undefined, 'Bearer sk-a'],
  ])

  const onlyApiKey = await gateway(t, (req, res) => {
    if (req.headers['x-api-key'] === 'sk-b') json({ data: [{ id: 'claude-haiku-5-5' }] })(req, res)
    else json({ error: { message: 'missing x-api-key' } }, 403)(req, res)
  })
  const others = await fetchUpstreamModels({ baseUrl: onlyApiKey.url, authField: 'ANTHROPIC_AUTH_TOKEN', key: 'sk-b' })
  assert.deepEqual(others, [{ id: 'claude-haiku-5-5' }])
})

test('refused in both headers, the chosen one is reported; without a key, nothing is retried', async (t) => {
  const { url, seen } = await gateway(t, (req, res) => {
    json({ error: { message: req.headers['x-api-key'] ? 'invalid x-api-key' : 'OAuth is not supported' } }, 401)(req, res)
  })
  const error = await fetchUpstreamModels({ baseUrl: url, authField: 'ANTHROPIC_API_KEY', key: 'sk-c' }).catch((cause: Error) => cause)
  assert.ok(error instanceof Error)
  assert.equal(error.message, `${url}/v1/models 返回 401：invalid x-api-key`)
  assert.equal(seen.length, 2)

  await fetchUpstreamModels({ baseUrl: url, authField: 'ANTHROPIC_API_KEY', key: ' ' }).catch(() => {})
  assert.equal(seen.length, 3)
})

test('a base address with a path keeps it, trailing slashes dropped', async (t) => {
  const { url, seen } = await gateway(t, json({ data: [] }))
  await fetchUpstreamModels({ baseUrl: `${url}/anthropic//`, ...bearer })
  assert.equal(seen[0]!.url, '/anthropic/v1/models?limit=1000')
})

test('a refusal says which endpoint answered what, without the key', async (t) => {
  const { url } = await gateway(t, json({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401))
  const error = await fetchUpstreamModels({ baseUrl: url, ...bearer }).catch((cause: Error) => cause)
  assert.ok(error instanceof Error)
  assert.equal(error.message, `${url}/v1/models 返回 401：invalid x-api-key`)
  assert.ok(!error.message.includes('sk-secret'))
})

test('an error page is reported by its status alone', async (t) => {
  const { url } = await gateway(t, (_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<html><body>Not Found</body></html>')
  })
  await assert.rejects(fetchUpstreamModels({ baseUrl: url, ...bearer }), (error: Error) => error.message === `${url}/v1/models 返回 404`)
})

test('a reply that is no model list says so', async (t) => {
  const page = await gateway(t, (_req, res) => res.end('<html>hello</html>'))
  await assert.rejects(fetchUpstreamModels({ baseUrl: page.url, ...bearer }), /不是 JSON/)
  const other = await gateway(t, json({ models: ['a'] }))
  await assert.rejects(fetchUpstreamModels({ baseUrl: other.url, ...bearer }), /没有 data 数组/)
})

test('an address that is not http(s) is refused before any request', async () => {
  await assert.rejects(fetchUpstreamModels({ baseUrl: 'not a url', ...bearer }), /不是有效的网址/)
  await assert.rejects(fetchUpstreamModels({ baseUrl: 'ftp://example.com', ...bearer }), /http:\/\/ 或 https:\/\//)
})

test('a gateway that never answers is given up on at the deadline', async (t) => {
  const { url } = await gateway(t, () => {})
  await assert.rejects(fetchUpstreamModels({ baseUrl: url, ...bearer }, 100), /连不上 127\.0\.0\.1:\d+：超过 0\.1 秒没有响应/)
})

test('a gateway that is down says the connection was refused', async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  await assert.rejects(fetchUpstreamModels({ baseUrl: `http://127.0.0.1:${port}`, ...bearer }), /连不上 127\.0\.0\.1:\d+：ECONNREFUSED/)
})

test('HTTP_PROXY is honoured, as the CLI does and Node fetch does not', async (t) => {
  const proxy = await gateway(t, json({ data: [{ id: 'via-proxy' }] }))
  process.env['HTTP_PROXY'] = proxy.url
  const models = await fetchUpstreamModels({ baseUrl: 'http://gateway.test:8080', ...bearer })
  assert.deepEqual(models, [{ id: 'via-proxy' }])
  // A proxy is sent the whole address, not just the path.
  assert.equal(proxy.seen[0]!.url, 'http://gateway.test:8080/v1/models?limit=1000')
})

test('a gateway on this machine is never sent through the proxy, whatever NO_PROXY says', async (t) => {
  const proxy = await gateway(t, json({ data: [{ id: 'via-proxy' }] }))
  const direct = await gateway(t, json({ data: [{ id: 'direct' }] }))
  process.env['HTTP_PROXY'] = proxy.url
  // Node does not understand this glob, which would send 127.0.0.1 to the proxy.
  process.env['NO_PROXY'] = '127.*,<local>'
  assert.deepEqual(await fetchUpstreamModels({ baseUrl: direct.url, ...bearer }), [{ id: 'direct' }])
  assert.equal(proxy.seen.length, 0)
})
