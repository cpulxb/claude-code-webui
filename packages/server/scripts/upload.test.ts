import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { API_FILES_UPLOAD_PATH, MAX_UPLOAD_BYTES, uploadKind } from '@ccw/shared'

import { AuthGate } from '../src/auth/gate.ts'
import { issueCode } from '../src/auth/pairing.ts'
import { registerRoot } from '../src/files/roots.ts'
import { serveUpload } from '../src/files/upload-http.ts'
import { MAX_UPLOAD_DIR_BYTES, safeName, saveUpload, saveUploadStream } from '../src/files/upload.ts'
import { startServer } from '../src/rpc/server.ts'
import { SessionManager } from '../src/session/manager.ts'

const DOCX = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('[Content_Types].xml word/document.xml')])

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ccw-upload-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

test('a docx lands in upload/, readable but not executable, with the folder kept out of git', async () => {
  const saved = await saveUpload(cwd, '(A卷).docx', DOCX)
  assert.deepEqual(saved, { path: 'upload/(A卷).docx', size: DOCX.length })
  assert.deepEqual(await readFile(join(cwd, saved.path)), DOCX)
  assert.equal((await stat(join(cwd, saved.path))).mode & 0o777, 0o644)
  assert.equal(await readFile(join(cwd, 'upload', '.gitignore'), 'utf8'), '*\n')
})

test('a taken name gets a numbered suffix and the earlier upload is kept', async () => {
  await saveUpload(cwd, 'notes.md', Buffer.from('first'))
  const second = await saveUpload(cwd, 'notes.md', Buffer.from('second'))
  assert.equal(second.path, 'upload/notes-1.md')
  assert.equal(await readFile(join(cwd, 'upload', 'notes.md'), 'utf8'), 'first')
})

test('a name cannot climb out of the folder, hide as a dotfile or start an option', async () => {
  assert.equal(safeName('../../.bashrc.txt'), 'bashrc.txt')
  assert.equal(safeName('C:\\Users\\x\\report.docx'), 'report.docx')
  assert.equal(safeName('-rf $(id).sh'), 'rf_(id).sh')
  assert.equal(safeName('my report v2.DOCX'), 'my_report_v2.docx')
  assert.equal(safeName('...'), 'file')
  const saved = await saveUpload(cwd, '../../.bashrc.txt', Buffer.from('echo hi'))
  assert.equal(saved.path, 'upload/bashrc.txt')
  assert.deepEqual((await readdir(cwd)).sort(), ['upload'])
})

test('extensions outside the allowlist are refused', async () => {
  for (const name of ['setup.exe', 'payload.docm', 'macro.xlsm', 'noext', 'image.svg']) {
    await assert.rejects(saveUpload(cwd, name, Buffer.from('x')), /不支持上传/, name)
  }
})

test('content that does not match the extension is refused', async () => {
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])
  await assert.rejects(saveUpload(cwd, 'report.docx', elf), /不是 Office 文档/)
  await assert.rejects(saveUpload(cwd, 'archive.zip', elf), /不是 zip/)
  await assert.rejects(saveUpload(cwd, 'script.py', elf), /二进制/)
  await assert.rejects(saveUpload(cwd, 'empty.txt', Buffer.alloc(0)), /空的/)
})

test('office files carrying a VBA project are refused', async () => {
  const docm = Buffer.concat([DOCX, Buffer.from('word/vbaProject.bin', 'latin1')])
  await assert.rejects(saveUpload(cwd, 'renamed.docx', docm), /宏/)
  const ole = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from('_VBA_PROJECT', 'utf16le'),
  ])
  await assert.rejects(saveUpload(cwd, 'legacy.xls', ole), /宏/)
})

test('text in a non-UTF-8 encoding is still text', async () => {
  // "姓名,分数" in GBK, as Excel on a Chinese Windows saves a CSV.
  const gbk = Buffer.from([0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xb7, 0xd6, 0xca, 0xfd])
  assert.equal((await saveUpload(cwd, 'scores.csv', gbk)).path, 'upload/scores.csv')
})

test('an upload folder that is a symlink is not written through', async () => {
  const elsewhere = await mkdtemp(join(tmpdir(), 'ccw-upload-target-'))
  await symlink(elsewhere, join(cwd, 'upload'))
  await assert.rejects(saveUpload(cwd, 'notes.md', Buffer.from('x')), /符号链接/)
  assert.deepEqual(await readdir(elsewhere), [])
})

test('a planted symlink at the target name is neither followed nor overwritten', async () => {
  const outside = join(await mkdtemp(join(tmpdir(), 'ccw-upload-victim-')), 'victim.md')
  await writeFile(outside, 'original')
  await mkdir(join(cwd, 'upload'))
  await symlink(outside, join(cwd, 'upload', 'notes.md'))
  const saved = await saveUpload(cwd, 'notes.md', Buffer.from('new'))
  assert.equal(saved.path, 'upload/notes-1.md')
  assert.equal(await readFile(outside, 'utf8'), 'original')
})

test('the folder quota is enforced', async () => {
  await mkdir(join(cwd, 'upload'))
  const big = join(cwd, 'upload', 'big.zip')
  await writeFile(big, '')
  // Sparse: the size counts without taking the disk space.
  await truncate(big, MAX_UPLOAD_DIR_BYTES)
  await assert.rejects(saveUpload(cwd, 'notes.md', Buffer.from('x')), /清理旧文件/)
})

function ftyp(brand: string): Buffer {
  const data = Buffer.alloc(20)
  data.writeUInt32BE(data.length)
  data.write('ftyp', 4)
  data.write(brand, 8)
  data.write(brand, 16)
  return data
}

function ebml(type: string): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | (3 + type.length), 0x42, 0x82, 0x80 | type.length]), Buffer.from(type)])
}

test('images, PDF and common video containers need matching file headers', async () => {
  const files: [string, Buffer][] = [
    ['photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['photo.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe1])],
    ['photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['photo.gif', Buffer.from('GIF89a')],
    ['photo.webp', Buffer.from('RIFF\x10\x00\x00\x00WEBP', 'latin1')],
    ['report.pdf', Buffer.from('%PDF-1.7\n')],
    ['clip.mp4', ftyp('isom')], ['clip.m4v', ftyp('M4V ')], ['clip.mov', ftyp('qt  ')],
    ['clip.3gp', ftyp('3gp6')], ['clip.3g2', ftyp('3g2a')],
    ['clip.webm', ebml('webm')], ['clip.mkv', ebml('matroska')],
    ['clip.avi', Buffer.from('RIFF\x10\x00\x00\x00AVI ', 'latin1')],
    ['clip.mpeg', Buffer.from([0, 0, 1, 0xba])], ['clip.mpg', Buffer.from([0, 0, 1, 0xb3])],
    ['clip.ogv', Buffer.from('OggS\x00\x00\x80theora', 'latin1')],
  ]
  for (const [filename, data] of files) {
    assert.ok(uploadKind(filename), filename)
    assert.equal((await saveUpload(cwd, filename, data)).size, data.length, filename)
    await assert.rejects(saveUpload(cwd, filename, Buffer.from('not a media file')), /内容不是/, filename)
  }
  await assert.rejects(saveUpload(cwd, 'fake.mp4', ftyp('avif')), /视频/)
  await assert.rejects(saveUpload(cwd, 'fake.mp4', ftyp('M4A ')), /视频/)
  await assert.rejects(saveUpload(cwd, 'fake.webm', ebml('matroska')), /视频/)
  await assert.rejects(saveUpload(cwd, 'fake.webp', Buffer.from('RIFF\x10\x00\x00\x00AVI ', 'latin1')), /图片/)
  assert.equal((await readdir(join(cwd, 'upload'))).some((name) => name.endsWith('.part')), false)
})

test('the 100 MiB boundary accepts an exact stream and cleans a chunked overflow', async () => {
  assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024)
  const chunk = Buffer.alloc(1024 * 1024, 'x')
  async function* chunks(count: number): AsyncGenerator<Buffer> {
    for (let index = 0; index < count; index++) yield chunk
  }
  assert.equal((await saveUploadStream(cwd, 'exact.txt', chunks(100), { size: MAX_UPLOAD_BYTES })).size, MAX_UPLOAD_BYTES)
  await assert.rejects(saveUploadStream(cwd, 'declared.txt', [], { size: MAX_UPLOAD_BYTES + 1 }), /超过 100/)
  await assert.rejects(saveUploadStream(cwd, 'chunked.txt', chunks(101)), /超过 100/)
  await assert.rejects(saveUploadStream(cwd, 'short.txt', [Buffer.from('x')], { size: 2 }), /大小与声明不符/)
  assert.deepEqual((await readdir(join(cwd, 'upload'))).sort(), ['.gitignore', 'exact.txt'])
})

test('stream errors, cross-chunk macros and late binary text leave no partial file', async () => {
  await assert.rejects(saveUploadStream(cwd, 'renamed.docx', [DOCX, Buffer.from('word/vbaPro'), Buffer.from('ject.bin')]), /宏/)
  await assert.rejects(saveUploadStream(cwd, 'legacy.xls', [
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from('_VBA_PRO', 'utf16le'), Buffer.from('JECT', 'utf16le'),
  ]), /宏/)
  await assert.rejects(saveUploadStream(cwd, 'binary.txt', [Buffer.from('initial text'), Buffer.from([0])]), /二进制/)
  async function* broken(): AsyncGenerator<Buffer> {
    yield Buffer.from('partial')
    throw new Error('read failed')
  }
  await assert.rejects(saveUploadStream(cwd, 'broken.txt', broken()), /read failed/)
  assert.deepEqual(await readdir(join(cwd, 'upload')), ['.gitignore'])
})

test('chunked reservations also constrain concurrent RPC uploads and canonical cwd aliases, then release on cancel', async () => {
  await mkdir(join(cwd, 'upload'))
  const existing = join(cwd, 'upload', 'existing.zip')
  await writeFile(existing, '')
  await truncate(existing, MAX_UPLOAD_DIR_BYTES - 12)
  await symlink(cwd, join(cwd, 'alias'))
  let entered!: () => void
  let release!: () => void
  const receiving = new Promise<void>((resolve) => { entered = resolve })
  const resume = new Promise<void>((resolve) => { release = resolve })
  const controller = new AbortController()
  async function* slow(): AsyncGenerator<Buffer> {
    yield Buffer.from('123456')
    entered()
    await resume
  }
  const first = saveUploadStream(cwd, 'first.txt', slow(), { signal: controller.signal })
  // Observe rejection immediately so an assertion failure cannot leak it.
  const stopped = assert.rejects(first, /取消/)
  await receiving
  try {
    await assert.rejects(saveUpload(join(cwd, 'alias'), 'rpc.txt', Buffer.from('1234567')), /清理旧文件/)
  } finally {
    controller.abort()
    release()
    await stopped
  }
  assert.equal((await saveUpload(cwd, 'rpc.txt', Buffer.from('1234567'))).size, 7)
  assert.deepEqual((await readdir(join(cwd, 'upload'))).sort(), ['existing.zip', 'rpc.txt'])
})

test('closing the response after the entire body arrived cancels validation and cleans the temporary file', async () => {
  registerRoot(cwd, { trusted: true })
  const body = Buffer.from('fully received')
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false })
  const request = Object.assign(new EventEmitter(), {
    headers: { 'content-length': String(body.length) },
    url: `${API_FILES_UPLOAD_PATH}?${new URLSearchParams({ cwd, filename: 'cancelled.txt' })}`,
    complete: false,
    iterator: () => (async function* () {
      yield body
      request.complete = true
      // No req.aborted event: only the response connection goes away.
      response.destroyed = true
      response.emit('close')
    })(),
  })
  await serveUpload(request as unknown as IncomingMessage, response as unknown as ServerResponse)
  assert.deepEqual(await readdir(join(cwd, 'upload')), ['.gitignore'])
})

test('HTTP upload preserves authorization/CSRF/workspace gates, returns JSON, supports RPC and cleans a disconnected stream', async (t) => {
  registerRoot(cwd, { trusted: true })
  const authDir = join(cwd, '.auth')
  const auth = await AuthGate.open({ dir: authDir })
  const port = await freePort()
  const server = await startServer({ host: '127.0.0.1', port, manager: new SessionManager(), auth })
  t.after(() => server.close())
  const path = `${API_FILES_UPLOAD_PATH}?${new URLSearchParams({ cwd, filename: 'report.pdf' })}`
  const body = Buffer.from('%PDF-1.7\n')
  const binary = { 'content-type': 'application/octet-stream' }
  type Reply = { status: number; body: any; cookie?: string }
  const call = (target: string, data: Buffer, headers: Record<string, string> = binary): Promise<Reply> => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: target, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
    })
    req.on('error', reject)
    req.end(data)
  })
  const good = await call(path, body)
  assert.equal(good.status, 200)
  assert.deepEqual(good.body, { ok: true, result: { path: 'upload/report.pdf', size: body.length } })
  assert.deepEqual(await readFile(join(cwd, good.body.result.path)), body)
  assert.equal((await call(path, body, { ...binary, 'x-forwarded-for': '203.0.113.1' })).status, 401)
  assert.equal((await call(path, body, { ...binary, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await call(path, body, { ...binary, 'sec-fetch-site': 'same-site' })).status, 403)
  for (const contentType of ['text/plain', 'multipart/form-data', 'application/json', 'application/octet-stream-fake']) {
    assert.equal((await call(path, body, { 'content-type': contentType })).status, 415, contentType)
  }
  assert.equal((await call('/api/rpc', body, binary)).status, 415)
  assert.equal((await call(`${API_FILES_UPLOAD_PATH}?${new URLSearchParams({ cwd: '/__ccw_unknown_workspace__', filename: 'x.txt' })}`, Buffer.from('x'))).status, 404)
  assert.equal((await call(API_FILES_UPLOAD_PATH, body)).status, 400)
  const tooLarge = await call(path, Buffer.from('x'), { ...binary, 'content-length': String(MAX_UPLOAD_BYTES + 1) })
  assert.equal(tooLarge.status, 413)
  assert.equal(tooLarge.body.ok, false)
  const invalid = await call(path, Buffer.from('not PDF'))
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.ok, false)
  const chunked = await call(path, body, { ...binary, 'transfer-encoding': 'chunked' })
  assert.equal(chunked.status, 200)
  assert.equal(chunked.body.result.path, 'upload/report-1.pdf')

  const { code } = await issueCode(authDir)
  const paired = await call('/api/auth/pair', Buffer.from(JSON.stringify({ code })), { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.1' })
  assert.ok(paired.cookie)
  assert.equal((await call(path, body, { ...binary, 'x-forwarded-for': '203.0.113.1', cookie: paired.cookie })).status, 200)
  const rpc = await call('/api/rpc', Buffer.from(JSON.stringify({ method: 'files.upload', params: { cwd, filename: 'legacy.txt', data: Buffer.from('legacy').toString('base64') } })), { 'content-type': 'application/json' })
  assert.deepEqual(rpc.body, { ok: true, result: { path: 'upload/legacy.txt', size: 6 } })

  const cancelledPath = `${API_FILES_UPLOAD_PATH}?${new URLSearchParams({ cwd, filename: 'disconnected.txt' })}`
  const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: cancelledPath, headers: { ...binary, 'content-length': String(1024 * 1024) } })
  req.on('error', () => {}) // Client cancellation intentionally resets the socket.
  req.write(Buffer.alloc(64 * 1024, 'x'))
  try {
    await until(async () => {
      const partial = (await readdir(join(cwd, 'upload'))).find((name) => name.endsWith('.part'))
      return partial !== undefined && (await stat(join(cwd, 'upload', partial))).size > 0
    })
  } finally {
    req.destroy()
  }
  await until(async () => !(await readdir(join(cwd, 'upload'))).some((name) => name.endsWith('.part')))
  assert.equal((await readdir(join(cwd, 'upload'))).includes('disconnected.txt'), false)
})

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('upload state did not settle')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')))
    })
    probe.once('error', reject)
  })
}
