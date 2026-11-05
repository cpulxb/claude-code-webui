import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'

import { MAX_UPLOAD_BYTES } from '@ccw/shared'

import { onUnauthorized, uploadFile } from '../src/api/client.ts'
import { historyPrompts } from '../src/render/history.ts'
import {
  MAX_ATTACHMENTS,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  UploadQueue,
  inlineAttachments,
  inlineImage,
  splitUploadRefs,
  uploadBlockReason,
  withUploads,
} from '../src/utils/attachments.ts'

function transfers() {
  const requests = []
  const transfer = (params) => new Promise((resolve, reject) => requests.push({ ...params, resolve, reject }))
  return { requests, transfer }
}

const file = (name, size = 100) => ({ name, size })
const noInline = async () => null
const inlined = async (picked) => ({ kind: 'image', mediaType: 'image/png', data: 'AAAA', filename: picked.name })

test('PDFs, images and video all upload; bytes sent are not yet a usable @ reference', async () => {
  const { requests, transfer } = transfers()
  const queue = new UploadQueue('/work', transfer, noInline)
  assert.equal(queue.add([file('report.pdf'), file('screen.png'), file('clip.mp4')]), null)
  // The image is first read for inlining; refused, it uploads like the rest.
  assert.deepEqual(queue.getSnapshot().map((item) => item.status), ['uploading', 'processing', 'queued'])
  await settle()
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
  assert.deepEqual(inlineAttachments(queue.getSnapshot()), [])
  queue.clear()
})

test('small images go inline without a request; large ones and the budget overflow upload', async () => {
  const { requests, transfer } = transfers()
  const queue = new UploadQueue('/work', transfer, inlined)
  const big = MAX_INLINE_IMAGE_BYTES - 1
  queue.add([file('a.png'), file('huge.png', MAX_INLINE_IMAGE_BYTES + 1)])
  assert.equal(requests.length, 1) // only the oversized image skips straight to an upload
  await settle()
  assert.deepEqual(queue.getSnapshot().map((item) => item.status), ['ready', 'uploading'])
  assert.deepEqual(inlineAttachments(queue.getSnapshot()).map((item) => item.filename), ['a.png'])
  assert.equal(withUploads(queue.getSnapshot(), 'hi'), 'hi') // not a mention

  // One image more than the per-message budget holds: that one uploads instead.
  const fitting = Math.floor((MAX_INLINE_TOTAL_BYTES - 100) / big)
  queue.add(Array.from({ length: fitting + 1 }, (_, index) => file(`${index}.png`, big)))
  for (let round = 0; round <= fitting; round++) await settle()
  const added = queue.getSnapshot().slice(2)
  assert.equal(added.filter((item) => item.inline).length, fitting)
  assert.equal(added.at(-1).status, 'uploading')
  assert.equal(requests.at(-1).file.name, `${fitting}.png`)
  assert.equal(requests.length, 2)
  queue.clear()
})

test('an image that cannot be inlined uploads; a retry asks again; removal mid-read is final', async () => {
  const { requests, transfer } = transfers()
  let answer = null
  let reads = 0
  const queue = new UploadQueue('/work', transfer, async () => { reads++; if (answer instanceof Error) throw answer; return answer })
  answer = new Error('decode failed')
  queue.add([file('odd.webp')])
  await settle()
  assert.equal(requests.length, 1)
  requests[0].reject(new Error('文件内容不是这种图片，扩展名和内容不符'))
  await settle()
  assert.equal(queue.getSnapshot()[0].status, 'error')

  answer = { kind: 'image', mediaType: 'image/webp', data: 'AAAA', filename: 'odd.webp' }
  queue.retry(queue.getSnapshot()[0].key)
  await settle()
  assert.equal(reads, 2)
  assert.equal(queue.getSnapshot()[0].status, 'ready')
  assert.equal(inlineAttachments(queue.getSnapshot()).length, 1)

  queue.add([file('late.png')])
  queue.remove(queue.getSnapshot()[1].key)
  await settle()
  assert.equal(queue.getSnapshot().length, 1)
  assert.equal(requests.length, 1)
  queue.clear()
})

test('removal aborts the request; late callbacks cannot overwrite a retry or a cleared session', async () => {
  const { requests, transfer } = transfers()
  const queue = new UploadQueue('/work', transfer, noInline)
  queue.add([file('clip.webm'), file('next.pdf')])
  const key = queue.getSnapshot()[0].key
  queue.remove(key)
  assert.equal(requests[0].signal.aborted, true)
  requests[0].onProgress(100)
  requests[0].resolve({ path: 'upload/stale.webm', size: 100 })
  await settle()
  assert.deepEqual(queue.getSnapshot().map((item) => item.file.name), ['next.pdf'])
  assert.equal(queue.getSnapshot()[0].status, 'uploading')

  requests[1].reject(new Error('服务器校验失败'))
  await settle()
  assert.equal(queue.getSnapshot()[0].status, 'error')
  assert.equal(queue.getSnapshot()[0].error, '服务器校验失败')
  assert.match(uploadBlockReason(queue.getSnapshot()), /重试或移除/)
  assert.equal(withUploads(queue.getSnapshot(), ''), '')
  queue.retry(queue.getSnapshot()[0].key)
  assert.equal(queue.getSnapshot()[0].error, undefined)
  requests[2].resolve({ path: 'upload/next.pdf', size: 100 })
  await settle()
  assert.equal(withUploads(queue.getSnapshot(), ''), '@upload/next.pdf')

  queue.add([file('second.pdf')])
  queue.clear()
  assert.equal(requests[3].signal.aborted, true)
  requests[3].onProgress(100)
  requests[3].resolve({ path: 'upload/second.pdf', size: 100 })
  await settle()
  assert.deepEqual(queue.getSnapshot(), [])
})

test('queued removal never starts a request; repeated drops obey type, size and count limits', () => {
  const { requests, transfer } = transfers()
  const queue = new UploadQueue('/work', transfer, noInline)
  const error = queue.add([file('payload.exe'), file('empty.txt', 0), file('large.mp4', MAX_UPLOAD_BYTES + 1)])
  assert.match(error, /不支持/)
  assert.match(error, /空/)
  assert.match(error, /超过/)
  assert.equal(requests.length, 0)
  queue.add([file('a.pdf'), file('b.mp4'), file('c.txt')])
  queue.remove(queue.getSnapshot()[2].key)
  assert.equal(requests.length, 2)
  const limit = queue.add(Array.from({ length: MAX_ATTACHMENTS }, (_, index) => file(`${index}.md`)))
  assert.match(limit, /最多/)
  assert.equal(queue.getSnapshot().length, MAX_ATTACHMENTS)
  queue.clear()
})

test('inlineImage takes the media type from the bytes and refuses what the API would', async () => {
  const previous = globalThis.createImageBitmap
  let side = 100
  globalThis.createImageBitmap = async () => ({ width: side, height: 10, close() {} })
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9])
    assert.deepEqual(await inlineImage(new File([png], 'a.png')), {
      kind: 'image',
      mediaType: 'image/png',
      data: Buffer.from(png).toString('base64'),
      filename: 'a.png',
    })
    // Saved from the web as .png, but a JPEG: the API checks the bytes too.
    assert.equal((await inlineImage(new File([jpeg], 'photo.png'))).mediaType, 'image/jpeg')
    assert.equal(await inlineImage(new File(['GIF87a'], 'x.webp')).then((item) => item.mediaType), 'image/gif')
    assert.equal(await inlineImage(new File(['not an image'], 'fake.png')), null)
    side = 8001
    assert.equal(await inlineImage(new File([png], 'tall.png')), null)
    assert.equal(await inlineImage({ name: 'big.png', size: MAX_INLINE_IMAGE_BYTES + 1 }), null)
  } finally {
    if (previous === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previous
  }
})

test('the bubble splits the trailing @upload mentions off the prompt', () => {
  assert.deepEqual(splitUploadRefs('看看\n\n@upload/a.png @upload/b-1.pdf'), { body: '看看', refs: ['upload/a.png', 'upload/b-1.pdf'] })
  assert.deepEqual(splitUploadRefs('@upload/only.docx'), { body: '', refs: ['upload/only.docx'] })
  // Only a whole trailing paragraph of mentions; one typed mid-sentence stays text.
  assert.deepEqual(splitUploadRefs('读 @upload/a.png 再说'), { body: '读 @upload/a.png 再说', refs: [] })
  assert.deepEqual(splitUploadRefs('x\n\n@upload/a.png and more'), { body: 'x\n\n@upload/a.png and more', refs: [] })
  assert.deepEqual(splitUploadRefs('x\n@upload/a.png'), { body: 'x\n@upload/a.png', refs: [] })
})

test('history keeps inline images for the bubble and counts documents apart', () => {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } },
    { type: 'text', text: '这两张图片是什么' },
  ]
  const [prompt] = historyPrompts([{ type: 'user', uuid: 'u', message: { role: 'user', content } }])
  assert.equal(prompt.attachments, 2)
  assert.deepEqual(prompt.images, [{ mediaType: 'image/png', data: 'iVBORw0K' }])
  // As the server sends history: payloads emptied, blocks kept.
  content[0].source.data = ''
  const [stripped] = historyPrompts([{ type: 'user', uuid: 's', message: { role: 'user', content } }])
  assert.deepEqual(stripped.images, [{ mediaType: 'image/png', data: '' }])
  const [plain] = historyPrompts([{ type: 'user', uuid: 'p', message: { role: 'user', content: 'hi' } }])
  assert.equal('images' in plain, false)
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
