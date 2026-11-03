import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { MAX_UPLOAD_DIR_BYTES, safeName, saveUpload } from '../src/files/upload.ts'

const DOCX = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('[Content_Types].xml word/document.xml')])

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'ccw-upload-'))
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
