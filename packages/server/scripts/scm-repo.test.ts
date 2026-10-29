import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import {
  scmBranches,
  scmChangeDiff,
  scmCommit,
  scmLog,
  scmRepo,
  scmRestore,
  scmShow,
  scmShowDiff,
  scmStage,
  scmSwitch,
  scmSync,
  scmUnstage,
} from '../src/scm/repo.ts'

const exec = promisify(execFile)

/** Identity and hook settings local to each fixture, so the machine's own config cannot leak in. */
async function configure(dir: string): Promise<void> {
  for (const [key, value] of [
    ['user.name', 'Test'],
    ['user.email', 'test@localhost'],
    ['core.hooksPath', '/dev/null'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ]) {
    await exec('git', ['config', key, value!], { cwd: dir })
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccw-scm-repo-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout
  await git('init', '--quiet', '-b', 'main')
  await configure(root)
  await writeFile(join(root, 'a.txt'), 'a1\n')
  await writeFile(join(root, 'b.txt'), 'b1\n')
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'first')
  return { root, git }
}

test('status keeps the index and the work tree apart', async (t) => {
  const { root, git } = await fixture(t)
  await writeFile(join(root, 'a.txt'), 'a2\n')
  await git('add', 'a.txt')
  await writeFile(join(root, 'a.txt'), 'a3\n')
  await writeFile(join(root, 'new.txt'), 'new\n')
  await rm(join(root, 'b.txt'))

  const repo = await scmRepo(root)
  assert.ok(repo)
  assert.equal(repo.branch, 'main')
  assert.match(repo.head ?? '', /^[0-9a-f]{7}$/)
  assert.equal(repo.upstream, null)
  assert.equal(repo.hasRemote, false)
  assert.equal(repo.root, null)
  assert.deepEqual(repo.staged, [{ path: 'a.txt', status: 'modified' }])
  assert.deepEqual(repo.unstaged, [
    { path: 'a.txt', status: 'modified' },
    { path: 'b.txt', status: 'deleted' },
    { path: 'new.txt', status: 'untracked' },
  ])

  // Each side diffs against its own base: index vs HEAD, work tree vs index.
  assert.match((await scmChangeDiff(root, 'a.txt', true)).diff, /-a1\n\+a2/)
  assert.match((await scmChangeDiff(root, 'a.txt', false)).diff, /-a2\n\+a3/)
  assert.match((await scmChangeDiff(root, 'new.txt', false)).diff, /\+new/)
})

test('a subdirectory workspace lists its own files and counts staged ones elsewhere', async (t) => {
  const { root, git } = await fixture(t)
  const cwd = join(root, 'sub')
  await mkdir(cwd)
  await writeFile(join(cwd, 'in.txt'), 'in\n')
  await writeFile(join(root, 'a.txt'), 'outside edit\n')
  await git('add', 'a.txt')

  const repo = await scmRepo(cwd)
  assert.ok(repo)
  assert.ok(repo.root)
  assert.deepEqual(repo.staged, [])
  assert.deepEqual(repo.unstaged, [{ path: 'in.txt', status: 'untracked' }])
  assert.equal(repo.stagedOutside, 1)

  await assert.rejects(scmStage(cwd, ['../a.txt']), /escapes workspace/)
  await assert.rejects(scmRestore(cwd, ['../b.txt']), /escapes workspace/)
})

test('staging, unstaging and a staged rename', async (t) => {
  const { root, git } = await fixture(t)
  await writeFile(join(root, 'new.txt'), 'new\n')
  await scmStage(root, ['new.txt'])
  assert.deepEqual((await scmRepo(root))?.staged, [{ path: 'new.txt', status: 'added' }])
  await scmUnstage(root, ['new.txt'])
  assert.deepEqual((await scmRepo(root))?.staged, [])

  await git('mv', 'b.txt', 'c.txt')
  assert.deepEqual((await scmRepo(root))?.staged, [{ path: 'c.txt', status: 'renamed', oldPath: 'b.txt' }])
  assert.match((await scmChangeDiff(root, 'c.txt', true, 'b.txt')).diff, /rename from b\.txt/)
  await scmUnstage(root, ['c.txt', 'b.txt'])
  const repo = await scmRepo(root)
  assert.deepEqual(repo?.staged, [])
  assert.deepEqual(repo?.unstaged.map((file) => `${file.status} ${file.path}`), [
    'deleted b.txt',
    'untracked c.txt',
    'untracked new.txt',
  ])
})

test('unstaging works before the first commit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccw-scm-repo-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await exec('git', ['init', '--quiet', '-b', 'main'], { cwd: root })
  await writeFile(join(root, 'x.txt'), 'x\n')
  await scmStage(root, ['x.txt'])
  const staged = await scmRepo(root)
  assert.equal(staged?.head, null)
  assert.deepEqual(staged?.staged, [{ path: 'x.txt', status: 'added' }])
  await scmUnstage(root, ['x.txt'])
  assert.deepEqual((await scmRepo(root))?.staged, [])
  assert.deepEqual(await scmLog(root, 0), { commits: [], more: false })
})

test('restore drops only work-tree changes and deletes untracked files', async (t) => {
  const { root, git } = await fixture(t)
  await writeFile(join(root, 'a.txt'), 'staged\n')
  await git('add', 'a.txt')
  await writeFile(join(root, 'a.txt'), 'unstaged\n')
  await writeFile(join(root, 'new.txt'), 'new\n')
  await rm(join(root, 'b.txt'))

  await scmRestore(root, ['a.txt', 'new.txt', 'b.txt'])
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'staged\n')
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'b1\n')
  await assert.rejects(access(join(root, 'new.txt')), { code: 'ENOENT' })
  assert.deepEqual((await scmRepo(root))?.staged, [{ path: 'a.txt', status: 'modified' }])
})

test('commit, then find it in the log with its refs and files', async (t) => {
  const { root, git } = await fixture(t)
  await assert.rejects(scmCommit(root, '  ', false), /empty/)

  await writeFile(join(root, 'a.txt'), 'a2\n')
  await git('mv', 'b.txt', 'renamed.txt')
  await writeFile(join(root, 'loose.txt'), 'loose\n')
  // Nothing beyond the rename is staged; stageAll takes the rest along.
  const hash = await scmCommit(root, 'second\n\nwith a body', true)
  assert.deepEqual((await scmRepo(root))?.unstaged, [])
  await git('tag', 'v1')

  const { commits, more } = await scmLog(root, 0)
  assert.equal(more, false)
  assert.deepEqual(commits.map((commit) => commit.subject), ['second', 'first'])
  assert.equal(commits[0]!.shortHash, hash)
  assert.equal(commits[0]!.author, 'Test')
  assert.deepEqual(commits[0]!.refs, [
    { name: 'main', kind: 'head' },
    { name: 'v1', kind: 'tag' },
  ])

  const shown = await scmShow(root, commits[0]!.hash)
  assert.equal(shown.body, 'with a body')
  assert.deepEqual(shown.files, [
    { path: 'a.txt', status: 'modified' },
    { path: 'loose.txt', status: 'added' },
    { path: 'renamed.txt', status: 'renamed', oldPath: 'b.txt' },
  ])
  assert.match((await scmShowDiff(root, commits[0]!.hash, 'a.txt')).diff, /-a1\n\+a2/)
  assert.match((await scmShowDiff(root, commits[0]!.hash, 'renamed.txt', 'b.txt')).diff, /rename to renamed\.txt/)
  // The root commit has no parent and still lists what it added.
  assert.deepEqual((await scmShow(root, commits[1]!.hash)).files.map((file) => file.status), ['added', 'added'])

  await assert.rejects(scmShow(root, '--all'), /not a commit hash/)
})

test('the log pages and keeps to the workspace subtree', async (t) => {
  const { root, git } = await fixture(t)
  for (let i = 0; i < 51; i++) await git('commit', '--quiet', '--allow-empty', '-m', `empty ${i}`)
  const first = await scmLog(root, 0)
  assert.equal(first.commits.length, 50)
  assert.equal(first.more, true)
  const second = await scmLog(root, 50)
  assert.deepEqual(second.commits.map((commit) => commit.subject), ['empty 0', 'first'])
  assert.equal(second.more, false)

  const cwd = join(root, 'sub')
  await mkdir(cwd)
  await writeFile(join(cwd, 'in.txt'), 'in\n')
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'touches sub')
  const scoped = await scmLog(cwd, 0)
  assert.deepEqual(scoped.commits.map((commit) => commit.subject), ['touches sub'])
  assert.deepEqual((await scmShow(cwd, scoped.commits[0]!.hash)).files, [{ path: 'in.txt', status: 'added' }])
})

test('branches: create, switch, refuse option-like names', async (t) => {
  const { root } = await fixture(t)
  await scmSwitch(root, 'feature', 'create')
  assert.equal((await scmRepo(root))?.branch, 'feature')
  await scmSwitch(root, 'main', 'switch')
  const branches = await scmBranches(root)
  assert.deepEqual(
    branches.map((branch) => [branch.name, branch.current, branch.remote]),
    [
      ['feature', false, false],
      ['main', true, false],
    ],
  )
  await assert.rejects(scmSwitch(root, '-', 'switch'), /not a branch name/)
  await assert.rejects(scmSwitch(root, 'bad..name', 'create'), /not a valid branch name/)
  await assert.rejects(scmSwitch(root, 'main', 'bogus' as 'switch'), /unknown switch mode/)
})

test('sync against a remote: push sets the upstream, fetch and pull catch up', async (t) => {
  const { root, git } = await fixture(t)
  const remote = join(root, '..', `${root.split('/').pop()}-remote.git`)
  t.after(() => rm(remote, { recursive: true, force: true }))
  await exec('git', ['init', '--quiet', '--bare', '-b', 'main', remote])
  await git('remote', 'add', 'origin', remote)

  assert.equal((await scmRepo(root))?.hasRemote, true)
  await scmSync(root, 'push')
  let repo = await scmRepo(root)
  assert.equal(repo?.upstream, 'origin/main')
  assert.equal(repo?.ahead, 0)

  await writeFile(join(root, 'a.txt'), 'a2\n')
  await scmCommit(root, 'local change', true)
  assert.equal((await scmRepo(root))?.ahead, 1)
  await scmSync(root, 'push')
  assert.equal((await scmRepo(root))?.ahead, 0)

  // Someone else pushes; fetch sees it, pull fast-forwards to it.
  const other = `${remote}-clone`
  t.after(() => rm(other, { recursive: true, force: true }))
  await exec('git', ['clone', '--quiet', remote, other])
  await configure(other)
  await writeFile(join(other, 'b.txt'), 'b2\n')
  await exec('git', ['commit', '--quiet', '-am', 'their change'], { cwd: other })
  await exec('git', ['push', '--quiet'], { cwd: other })

  await scmSync(root, 'fetch')
  repo = await scmRepo(root)
  assert.equal(repo?.behind, 1)
  const remoteBranch = (await scmBranches(root)).find((branch) => branch.remote)
  assert.deepEqual(remoteBranch && [remoteBranch.name, remoteBranch.current], ['origin/main', false])
  assert.equal((await scmBranches(root)).find((branch) => branch.name === 'main')?.behind, 1)

  await scmSync(root, 'pull')
  assert.equal((await scmRepo(root))?.behind, 0)
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'b2\n')

  await assert.rejects(scmSync(root, 'bogus' as 'push'), /unknown sync action/)
})

test('diverged branches: pull and push say what to do instead of dumping hints', async (t) => {
  const { root, git } = await fixture(t)
  const remote = join(root, '..', `${root.split('/').pop()}-remote.git`)
  const other = `${remote}-clone`
  t.after(() => rm(remote, { recursive: true, force: true }))
  t.after(() => rm(other, { recursive: true, force: true }))
  await exec('git', ['init', '--quiet', '--bare', '-b', 'main', remote])
  await git('remote', 'add', 'origin', remote)
  await scmSync(root, 'push')

  await exec('git', ['clone', '--quiet', remote, other])
  await configure(other)
  await writeFile(join(other, 'b.txt'), 'theirs\n')
  await exec('git', ['commit', '--quiet', '-am', 'theirs'], { cwd: other })
  await exec('git', ['push', '--quiet'], { cwd: other })
  await writeFile(join(root, 'a.txt'), 'ours\n')
  await scmCommit(root, 'ours', true)

  await assert.rejects(scmSync(root, 'push'), (error: Error) => /推送被拒绝/.test(error.message))
  await scmSync(root, 'fetch')
  await assert.rejects(scmSync(root, 'pull'), (error: Error) => {
    assert.match(error.message, /已经分叉/)
    assert.doesNotMatch(error.message, /hint:/)
    return true
  })
})
