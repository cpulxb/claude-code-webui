import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'

import { MAX_UPLOAD_BYTES } from '@ccw/shared'

import { onUnauthorized, uploadFile } from '../src/api/client.ts'
import { MAX_ATTACHMENTS, UploadQueue, uploadBlockReason, withUploads } from '../src/utils/attachments.ts'

function transfers() {
  const requests = []
  const transfer = (params) => new Promise((resolve, reject) => requests.push({ ...params, resolve, reject }))
  return { requests, transfer }
}

const file = (name, size = 100) => ({ name, size })

test('PDFs, images and video all upload; bytes sent are not yet a usable @ reference', async () => {
  const { requests, transfer } = transfers()
  const queue = new UploadQueue('/work', transfer)
  assert.equal(queue.add([file('report.pdf'), file('screen.png'), file('clip.mp4')]), null)
  assert.equal(requests.length, 2)
  assert.deepEqual(queue.getSnapshot().map((item) => item.status), ['uploading', 'uploading', 'queued'])
  requests[0].onProgress(25)
  assert.equal(queue.getSnapshot()[0].loaded, 25)
  requests[0].onProgress(100)
  assert.equal(queue.getSnapshot()[0].status, 'processing')
  assert.equal(withUploads(queue.getSnapshot(), '检查附件'), '检查附件')
  assert.match(uploadBlockReason(queue.getSnapshot()), /校验/)

  requests[0].resolve({ path: 'upload/report.pdf', size: 100 })
  await settle()
  assert.equal(requests.length, 3)
  assert.equal(queue.getSnapshot()[0].status, 'ready')
  requests[1].resolve({ path: 'upload/screen.png', size: 100 })
  requests[2].resolve({ path: 'upload/clip.mp4', size: 100 })
  await settle()
  assert.equal(uploadBlockReason(queue.getSnapshot()), null)
  assert.equal(withUploads(queue.getSnapshot(), '检查附件'), '检查附件\n\n@upload/report.pdf @upload/screen.png @upload/clip.mp4')
  queue.clear()
})

test('cancellation aborts the request; late callbacks cannot overwrite a retry or a cleared session', async () => {
  const { requests, transfer } = transfers()
  const queue = new UploadQueue('/work', transfer)
  queue.add([file('clip.webm')])
  const key = queue.getSnapshot()[0].key
  queue.cancel(key)
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(queue.getSnapshot()[0].status, 'cancelled')
  assert.match(uploadBlockReason(queue.getSnapshot()), /重试或移除/)
  queue.retry(key)
  requests[0].onProgress(100)
  requests[0].resolve({ path: 'upload/stale.webm', size: 100 })
  await settle()
  assert.equal(queue.getSnapshot()[0].status, 'uploading')
  assert.equal(queue.getSnapshot()[0].path, undefined)

  requests[1].reject(new Error('服务器校验失败'))
  await settle()
  assert.equal(queue.getSnapshot()[0].status, 'error')
  assert.equal(queue.getSnapshot()[0].error, '服务器校验失败')
  assert.equal(withUploads(queue.getSnapshot(), ''), '')
  queue.retry(key)
  assert.equal(queue.getSnapshot()[0].error, undefined)
  requests[2].resolve({ path: 'upload/clip.webm', size: 100 })
  await settle()
  assert.equal(withUploads(queue.getSnapshot(), ''), '@upload/clip.webm')
  queue.remove(key)
  assert.deepEqual(queue.getSnapshot(), [])

  queue.add([file('second.pdf')])
  queue.clear()
  assert.equal(requests[3].signal.aborted, true)
  requests[3].onProgress(100)
  requests[3].resolve({ path: 'upload/second.pdf', size: 100 })
  await settle()
  assert.deepEqual(queue.getSnapshot(), [])
})

test('queued cancellation/removal never starts a request; repeated drops obey type, size and count limits', () => {
  const { requests, transfer } = transfers()
  const queue = new UploadQueue('/work', transfer)
  const error = queue.add([file('payload.exe'), file('empty.txt', 0), file('large.mp4', MAX_UPLOAD_BYTES + 1)])
  assert.match(error, /不支持/)
  assert.match(error, /空/)
  assert.match(error, /超过/)
  assert.equal(requests.length, 0)
  queue.add([file('a.pdf'), file('b.mp4'), file('c.txt')])
  const queued = queue.getSnapshot()[2].key
  queue.cancel(queued)
  assert.equal(requests.length, 2)
  queue.remove(queued)
  const limit = queue.add(Array.from({ length: MAX_ATTACHMENTS }, (_, index) => file(`${index}.md`)))
  assert.match(limit, /最多/)
  assert.equal(queue.getSnapshot().length, MAX_ATTACHMENTS)
  queue.clear()
})

function xhrFixture() {
  const previous = { window: globalThis.window, xhr: globalThis.XMLHttpRequest }
  const requests = []
  const browser = new EventTarget()
  browser.location = { href: 'https://ccw.example/chat' }
  globalThis.window = browser
  globalThis.XMLHttpRequest = class {
    upload = {}
    headers = {}
    constructor() { requests.push(this) }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(name, value) { this.headers[name] = value }
    send(body) { this.body = body }
    abort() { this.aborted = true; this.onabort?.() }
    reply(status, response) { this.status = status; this.response = response; this.onload() }
  }
  return {
    requests,
    restore() {
      if (previous.window === undefined) delete globalThis.window
      else globalThis.window = previous.window
      if (previous.xhr === undefined) delete globalThis.XMLHttpRequest
      else globalThis.XMLHttpRequest = previous.xhr
    },
  }
}

test('HTTP uploads send the raw file with encoded metadata, real progress and abort support', async () => {
  const f = xhrFixture()
  try {
    const picked = new File(['abc'], '报告 & 1.pdf', { type: 'application/pdf' })
    const controller = new AbortController()
    const progress = []
    const pending = uploadFile({ cwd: '/work/a & b', file: picked, signal: controller.signal, onProgress: (loaded) => progress.push(loaded) })
    const xhr = f.requests[0]
    assert.equal(xhr.method, 'POST')
    assert.equal(new URL(xhr.url).pathname, '/api/files/upload')
    assert.equal(new URL(xhr.url).searchParams.get('cwd'), '/work/a & b')
    assert.equal(new URL(xhr.url).searchParams.get('filename'), picked.name)
    assert.equal(xhr.body, picked)
    assert.equal(xhr.headers['content-type'], 'application/octet-stream')
    xhr.upload.onprogress({ loaded: 1 })
    xhr.upload.onload()
    assert.deepEqual(progress, [1, 3])
    xhr.reply(200, { ok: true, result: { path: 'upload/report.pdf', size: 3 } })
    assert.deepEqual(await pending, { path: 'upload/report.pdf', size: 3 })
    controller.abort()
    assert.equal(xhr.aborted, undefined) // settled requests detach their signal listener

    const cancel = new AbortController()
    const aborted = uploadFile({ cwd: '/work', file: picked, signal: cancel.signal })
    cancel.abort()
    await assert.rejects(aborted, { name: 'AbortError' })
    assert.equal(f.requests[1].aborted, true)
    await assert.rejects(uploadFile({ cwd: '/work', file: picked, signal: cancel.signal }), { name: 'AbortError' })
    assert.equal(f.requests.length, 2)
  } finally {
    f.restore()
  }
})

test('HTTP uploads surface proxy errors, invalid responses and revoked device authentication', async () => {
  const f = xhrFixture()
  const stop = onUnauthorized(() => { unauthorized++ })
  let unauthorized = 0
  try {
    const params = { cwd: '/work', file: new File(['x'], 'x.txt'), signal: new AbortController().signal }
    const large = uploadFile(params)
    f.requests[0].reply(413, null)
    await assert.rejects(large, /反向代理/)
    const invalid = uploadFile(params)
    f.requests[1].reply(200, { ok: true, result: {} })
    await assert.rejects(invalid, /上传失败/)
    const revoked = uploadFile(params)
    f.requests[2].reply(401, { ok: false, error: 'unauthorized' })
    await assert.rejects(revoked, /unauthorized/)
    assert.equal(unauthorized, 1)
  } finally {
    stop()
    f.restore()
  }
})
