import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { scmDiff, scmDiscard, scmStatus } from '../src/scm/git.ts'

const exec = promisify(execFile)

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccw-scm-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'sub')
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout
  await mkdir(cwd)
  await writeFile(join(cwd, 'file.txt'), 'original\n')
  await writeFile(join(root, 'outside.txt'), 'outside\n')
  await git('init', '--quiet')
  await git('config', 'core.autocrlf', 'false')
  await git('add', '.')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'baseline')
  return { root, cwd, git }
}

test('subdirectory discard restores only the selected file', async (t) => {
  const { root, cwd } = await fixture(t)
  await writeFile(join(cwd, 'file.txt'), 'edited\n')
  await writeFile(join(root, 'outside.txt'), 'outside edited\n')
  const status = await scmStatus(cwd)
  assert.notEqual(status.kind, 'none')
  if (status.kind === 'none') return
  assert.deepEqual(status.files, [{ path: 'file.txt', status: 'modified' }])
  assert.match((await scmDiff(cwd, 'file.txt')).diff, /\+edited/)
  await scmDiscard(cwd, 'file.txt')
  assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'original\n')
  assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'outside edited\n')
})

test('a staged addition can still be discarded', async (t) => {
  const { cwd, git } = await fixture(t)
  await writeFile(join(cwd, 'added.txt'), 'added\n')
  await git('add', 'sub/added.txt')
  await scmDiscard(cwd, 'added.txt')
  await assert.rejects(access(join(cwd, 'added.txt')), { code: 'ENOENT' })
  assert.equal(await git('status', '--porcelain'), '')
})

for (const requested of ['file.txt', 'renamed.txt']) {
  test(`a rename inside the workspace can be discarded by ${requested}`, async (t) => {
    const { cwd, git } = await fixture(t)
    await git('mv', 'sub/file.txt', 'sub/renamed.txt')
    await scmDiscard(cwd, requested)
    assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'original\n')
    await assert.rejects(access(join(cwd, 'renamed.txt')), { code: 'ENOENT' })
    assert.equal(await git('status', '--porcelain'), '')
  })
}

for (const direction of ['out', 'in'] as const) {
  test(`a rename ${direction} of the workspace is rejected without changing either file or index`, async (t) => {
    const { root, cwd, git } = await fixture(t)
    const source = direction === 'out' ? 'sub/file.txt' : 'outside.txt'
    const destination = direction === 'out' ? 'moved-out.txt' : 'sub/moved-in.txt'
    const requested = direction === 'out' ? 'file.txt' : 'moved-in.txt'
    await git('mv', source, destination)
    const beforeStatus = await git('status', '--porcelain')
    const beforeIndex = await readFile(join(root, '.git', 'index'))
    const beforeContent = await readFile(join(root, destination))
    await assert.rejects(scmDiscard(cwd, requested), /path escapes workspace/)
    assert.deepEqual(await readFile(join(root, '.git', 'index')), beforeIndex)
    assert.deepEqual(await readFile(join(root, destination)), beforeContent)
    await assert.rejects(access(join(root, source)), { code: 'ENOENT' })
    assert.equal(await git('status', '--porcelain'), beforeStatus)
  })
}
