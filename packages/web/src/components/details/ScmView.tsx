import type { ScmBranch, ScmCommit, ScmFile, ScmRepo, ScmSyncAction, SessionStatus } from '@ccw/shared'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { call } from '../../api/client.ts'
import { CheckIcon, GitBranchIcon, MinusIcon, PlusIcon, RefreshIcon, UndoIcon } from '../Icons.tsx'
import panelStyles from './DetailsPanel.module.css'
import { basename, DiffView, dirname, STATUS_LETTER } from './ScmPanel.tsx'
import scmStyles from './ScmPanel.module.css'
import styles from './ScmView.module.css'

type View = 'changes' | 'history' | 'branches'
type Diff = { path: string; text: string; binary: boolean }

/**
 * Runs one git action at a time: its error shown, the repo re-read after.
 * `touchesFiles` also tells the file tree and editors that the work tree moved.
 */
type Act = (label: string, op: () => Promise<unknown>, options?: { touchesFiles?: boolean }) => Promise<boolean>

const SYNC_LABEL: Record<ScmSyncAction, [idle: string, running: string]> = {
  fetch: ['获取', '获取中…'],
  pull: ['拉取', '拉取中…'],
  push: ['推送', '推送中…'],
}

/**
 * 源代码管理 tab: what VS Code's Source Control view does for the repository
 * owning the workspace — stage and commit, browse history, switch branches,
 * fetch, pull and push. Anything naming files stays inside the workspace
 * subtree; see `scm/repo.ts` on the server for why.
 */
export function ScmView({
  cwd,
  turnStatus,
  fsVersion,
  active,
  onFilesChanged,
}: {
  cwd: string
  turnStatus: SessionStatus
  fsVersion: number
  /** Whether the tab is in front; a hidden one does not re-read. */
  active: boolean
  onFilesChanged: () => void
}): JSX.Element {
  // undefined while the first read is out, null when there is no repo.
  const [repo, setRepo] = useState<ScmRepo | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<View>('changes')

  const refresh = useCallback(async () => {
    try {
      setRepo((await call('scm.repo', { cwd })).repo)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [cwd])

  // A turn ending, a rewind, and coming back to the tab are when the repo can
  // have moved — a commit made in a terminal meanwhile included. The first
  // read does not wait for a running turn: until it lands there is nothing
  // to show, not even the refresh button.
  useEffect(() => {
    if (active && (turnStatus === 'idle' || repo === undefined)) void refresh()
  }, [active, turnStatus, fsVersion, refresh])

  const act: Act = async (label, op, options) => {
    setBusy(label)
    setError(null)
    let ok = true
    try {
      await op()
    } catch (cause) {
      ok = false
      setError(messageOf(cause))
    }
    if (options?.touchesFiles) onFilesChanged()
    await refresh()
    setBusy(null)
    return ok
  }

  if (repo === undefined) {
    return error ? <div className={styles.error}>{error}</div> : <div className={panelStyles.empty}>读取中…</div>
  }
  if (repo === null) {
    return (
      <div className={panelStyles.empty}>
        当前目录不是 git 仓库。没有仓库的目录可以在「详情」的源代码管理里启用影子跟踪，查看改动。
      </div>
    )
  }

  const sync = (action: ScmSyncAction): void => {
    void act(action, () => call('scm.sync', { cwd, action }), { touchesFiles: action === 'pull' })
  }
  const changeCount = repo.staged.length + repo.unstaged.length

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <button className={styles.branch} onClick={() => setView('branches')} type="button" title="分支">
          <GitBranchIcon size={13} />
          <span className={styles.branchName}>{repo.branch ?? (repo.head ? `(${repo.head})` : '(无提交)')}</span>
        </button>
        {repo.upstream ? (
          <span className={styles.track} title={`跟踪 ${repo.upstream}：领先 ${repo.ahead}，落后 ${repo.behind}`}>
            ↑{repo.ahead} ↓{repo.behind}
          </span>
        ) : (
          repo.hasRemote && repo.branch && <span className={styles.track}>未发布</span>
        )}
        <span className={panelStyles.spacer} />
        {repo.hasRemote && (
          <>
            <button className={styles.syncButton} onClick={() => sync('fetch')} disabled={busy !== null} type="button">
              {SYNC_LABEL.fetch[busy === 'fetch' ? 1 : 0]}
            </button>
            <button
              className={styles.syncButton}
              onClick={() => sync('pull')}
              disabled={busy !== null || !repo.upstream}
              type="button"
              title={repo.upstream ? '只做快进合并；分叉时请在终端处理' : '当前分支没有上游'}
            >
              {SYNC_LABEL.pull[busy === 'pull' ? 1 : 0]}
              {busy !== 'pull' && repo.behind > 0 && ` ↓${repo.behind}`}
            </button>
            <button
              className={styles.syncButton}
              onClick={() => sync('push')}
              disabled={busy !== null || !repo.branch}
              type="button"
              title={repo.upstream ? `推送到 ${repo.upstream}` : '发布分支并设为上游'}
            >
              {busy === 'push' ? SYNC_LABEL.push[1] : repo.upstream ? SYNC_LABEL.push[0] : '发布'}
              {busy !== 'push' && repo.ahead > 0 && ` ↑${repo.ahead}`}
            </button>
          </>
        )}
        <button
          className={panelStyles.iconButton}
          onClick={() => void refresh()}
          disabled={busy !== null}
          type="button"
          title="刷新"
        >
          <RefreshIcon size={14} />
        </button>
      </div>

      {repo.root && <div className={panelStyles.note}>仓库根目录是 {repo.root}，这里只列出会话目录里的文件。</div>}
      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.views}>
        <ViewButton current={view} view="changes" onPick={setView}>
          更改{changeCount > 0 && <span className={styles.count}>{changeCount}</span>}
        </ViewButton>
        <ViewButton current={view} view="history" onPick={setView}>
          历史
        </ViewButton>
        <ViewButton current={view} view="branches" onPick={setView}>
          分支
        </ViewButton>
      </div>

      {view === 'changes' && <ChangesView cwd={cwd} repo={repo} busy={busy} act={act} />}
      {view === 'history' && <HistoryView cwd={cwd} head={repo.head} onError={setError} />}
      {view === 'branches' && <BranchesView cwd={cwd} head={repo.head} busy={busy} act={act} />}
    </div>
  )
}

function ViewButton(props: {
  current: View
  view: View
  onPick: (view: View) => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      className={`${styles.viewButton} ${props.current === props.view ? styles.viewActive : ''}`}
      onClick={() => props.onPick(props.view)}
      type="button"
    >
      {props.children}
    </button>
  )
}

/* --- 更改 ---------------------------------------------------------------- */

function ChangesView({
  cwd,
  repo,
  busy,
  act,
}: {
  cwd: string
  repo: ScmRepo
  busy: string | null
  act: Act
}): JSX.Element {
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState<{ staged: boolean; file: ScmFile } | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  // Guards a slow diff response from landing on a row opened later.
  const openRef = useRef<string | null>(null)

  const { staged, unstaged } = repo
  // Committing with nothing staged stages everything first, as VS Code's
  // smart commit does — except over conflicts, which `git add` would mark
  // resolved with their markers still in the file.
  const stageAll = staged.length === 0
  const conflicted = unstaged.some((file) => file.status === 'conflicted')
  const canCommit = busy === null && message.trim() !== '' && (stageAll ? unstaged.length > 0 && !conflicted : true)

  const keyOf = (isStaged: boolean, path: string): string => `${isStaged ? 'S' : 'W'}:${path}`

  const loadDiff = async (isStaged: boolean, file: ScmFile): Promise<void> => {
    const key = keyOf(isStaged, file.path)
    setDiff(null)
    try {
      const result = await call('scm.changeDiff', {
        cwd,
        path: file.path,
        staged: isStaged,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      })
      if (openRef.current === key) setDiff({ path: key, text: result.diff, binary: result.binary })
    } catch (cause) {
      if (openRef.current === key) setDiff({ path: key, text: messageOf(cause), binary: false })
    }
  }

  // The listing is re-read after every action and turn; an open diff shows
  // the file as it was, so re-read it too — or close it once the row is gone.
  useEffect(() => {
    if (!open) return
    const list = open.staged ? staged : unstaged
    const file = list.find((entry) => entry.path === open.file.path)
    if (file) void loadDiff(open.staged, file)
    else {
      openRef.current = null
      setOpen(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo])

  const toggle = (isStaged: boolean, file: ScmFile): void => {
    const key = keyOf(isStaged, file.path)
    if (openRef.current === key) {
      openRef.current = null
      setOpen(null)
      return
    }
    openRef.current = key
    setOpen({ staged: isStaged, file })
    void loadDiff(isStaged, file)
  }

  const commit = async (): Promise<void> => {
    if (!canCommit) return
    const ok = await act('commit', () => call('scm.commit', { cwd, message, stageAll }))
    if (ok) setMessage('')
  }

  // A staged rename is two index entries; both names go, or half of it stays.
  const pathsOf = (files: ScmFile[]): string[] => files.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path]))

  return (
    <>
      <textarea
        className={styles.message}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void commit()
          }
        }}
        placeholder="提交信息（Ctrl+Enter 提交）"
        rows={3}
      />
      <button className={styles.commit} onClick={() => void commit()} disabled={!canCommit} type="button">
        {busy === 'commit' ? '提交中…' : stageAll ? '暂存全部并提交' : `提交 ${staged.length} 个文件`}
      </button>
      {stageAll && conflicted && <div className={panelStyles.note}>有未解决的冲突，先处理好再逐个暂存。</div>}
      {repo.stagedOutside > 0 && (
        <div className={panelStyles.note}>另有 {repo.stagedOutside} 个会话目录之外的已暂存文件，也会一起提交。</div>
      )}

      {staged.length === 0 && unstaged.length === 0 && <div className={panelStyles.empty}>工作区没有改动</div>}

      {staged.length > 0 && (
        <FileGroup
          title="已暂存的更改"
          files={staged}
          staged
          busy={busy}
          openKey={open ? keyOf(open.staged, open.file.path) : null}
          diff={diff}
          keyOf={keyOf}
          onToggle={toggle}
          groupAction={{
            label: '全部取消暂存',
            run: () => void act('unstage', () => call('scm.unstage', { cwd, paths: pathsOf(staged) })),
          }}
          rowAction={(file) => (
            <button
              className={styles.rowAction}
              onClick={() => void act('unstage', () => call('scm.unstage', { cwd, paths: pathsOf([file]) }))}
              disabled={busy !== null}
              type="button"
              title="取消暂存"
            >
              <MinusIcon size={13} />
            </button>
          )}
        />
      )}

      {unstaged.length > 0 && (
        <FileGroup
          title="更改"
          files={unstaged}
          staged={false}
          busy={busy}
          openKey={open ? keyOf(open.staged, open.file.path) : null}
          diff={diff}
          keyOf={keyOf}
          onToggle={toggle}
          groupAction={{
            label: '全部暂存',
            run: () => void act('stage', () => call('scm.stage', { cwd, paths: pathsOf(unstaged) })),
          }}
          rowAction={(file) => (
            <>
              <DiscardButton
                file={file}
                disabled={busy !== null}
                onDiscard={() =>
                  void act('restore', () => call('scm.restore', { cwd, paths: [file.path] }), { touchesFiles: true })
                }
              />
              <button
                className={styles.rowAction}
                onClick={() => void act('stage', () => call('scm.stage', { cwd, paths: [file.path] }))}
                disabled={busy !== null}
                type="button"
                title="暂存"
              >
                <PlusIcon size={13} />
              </button>
            </>
          )}
        />
      )}
    </>
  )
}

function FileGroup(props: {
  title: string
  files: ScmFile[]
  staged: boolean
  busy: string | null
  openKey: string | null
  diff: Diff | null
  keyOf: (staged: boolean, path: string) => string
  onToggle: (staged: boolean, file: ScmFile) => void
  groupAction: { label: string; run: () => void }
  rowAction: (file: ScmFile) => ReactNode
}): JSX.Element {
  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={panelStyles.sectionTitle}>
          {props.title} · {props.files.length}
        </span>
        <span className={panelStyles.spacer} />
        <button
          className={panelStyles.toggle}
          onClick={props.groupAction.run}
          disabled={props.busy !== null}
          type="button"
        >
          {props.groupAction.label}
        </button>
      </div>
      {props.files.map((file) => {
        const key = props.keyOf(props.staged, file.path)
        return (
          <div key={key}>
            <div className={styles.fileRow}>
              <button
                className={styles.fileMain}
                onClick={() => props.onToggle(props.staged, file)}
                type="button"
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              >
                <span className={scmStyles.fileName}>{basename(file.path)}</span>
                <span className={scmStyles.fileDir}>{dirname(file.path)}</span>
              </button>
              {props.rowAction(file)}
              <span className={`${scmStyles.badge} ${scmStyles[file.status]}`}>{STATUS_LETTER[file.status]}</span>
            </div>
            {props.openKey === key && <DiffView diff={props.diff?.path === key ? props.diff : null} />}
          </div>
        )
      })}
    </div>
  )
}

/** Two taps: the first turns the icon into 确认放弃?, which only lasts while hovered. */
function DiscardButton(props: { file: ScmFile; disabled: boolean; onDiscard: () => void }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  return (
    <button
      className={confirming ? styles.rowConfirm : styles.rowAction}
      onClick={() => (confirming ? props.onDiscard() : setConfirming(true))}
      onMouseLeave={() => setConfirming(false)}
      disabled={props.disabled}
      type="button"
      title={props.file.status === 'untracked' ? '删除此文件' : '放弃工作区的改动（已暂存的部分保留）'}
    >
      {confirming ? '确认放弃?' : <UndoIcon size={13} />}
    </button>
  )
}

/* --- 历史 ---------------------------------------------------------------- */

function HistoryView({
  cwd,
  head,
  onError,
}: {
  cwd: string
  /** Re-reads from the top whenever HEAD moves: a commit, a pull, a switch. */
  head: string | null
  onError: (error: string) => void
}): JSX.Element {
  const [commits, setCommits] = useState<ScmCommit[] | null>(null)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    setLoading(true)
    call('scm.log', { cwd, skip: 0 })
      .then((result) => {
        if (stale) return
        setCommits(result.commits)
        setMore(result.more)
      })
      .catch((cause: unknown) => {
        if (!stale) onError(messageOf(cause))
      })
      .finally(() => {
        if (!stale) setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [cwd, head, onError])

  const loadMore = async (): Promise<void> => {
    if (!commits) return
    setLoading(true)
    try {
      const result = await call('scm.log', { cwd, skip: commits.length })
      setCommits([...commits, ...result.commits])
      setMore(result.more)
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }

  if (!commits) return <div className={panelStyles.empty}>读取中…</div>
  if (commits.length === 0) return <div className={panelStyles.empty}>还没有提交</div>

  return (
    <div className={styles.history}>
      {commits.map((commit) => (
        <div key={commit.hash}>
          <button
            className={`${styles.commitRow} ${expanded === commit.hash ? styles.commitOpen : ''}`}
            onClick={() => setExpanded(expanded === commit.hash ? null : commit.hash)}
            type="button"
          >
            <span className={styles.commitSubject}>{commit.subject}</span>
            <span className={styles.commitMeta}>
              {commit.refs.map((ref) => (
                <span key={`${ref.kind}:${ref.name}`} className={`${styles.ref} ${styles[`ref_${ref.kind}`]}`}>
                  {ref.name}
                </span>
              ))}
              <span>{commit.author}</span>
              <span title={new Date(commit.date * 1000).toLocaleString()}>{ago(commit.date * 1000)}</span>
              <span className={styles.hash}>{commit.shortHash}</span>
            </span>
          </button>
          {expanded === commit.hash && <CommitDetail cwd={cwd} commit={commit} />}
        </div>
      ))}
      {more && (
        <button className={styles.more} onClick={() => void loadMore()} disabled={loading} type="button">
          {loading ? '读取中…' : '加载更多'}
        </button>
      )}
    </div>
  )
}

function CommitDetail({ cwd, commit }: { cwd: string; commit: ScmCommit }): JSX.Element {
  const [detail, setDetail] = useState<{ body: string; files: ScmFile[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)

  useEffect(() => {
    let stale = false
    call('scm.show', { cwd, hash: commit.hash })
      .then((result) => {
        if (!stale) setDetail(result)
      })
      .catch((cause: unknown) => {
        if (!stale) setError(messageOf(cause))
      })
    return () => {
      stale = true
    }
  }, [cwd, commit.hash])

  const toggle = async (file: ScmFile): Promise<void> => {
    if (openPath === file.path) {
      setOpenPath(null)
      return
    }
    setOpenPath(file.path)
    setDiff(null)
    try {
      const result = await call('scm.showDiff', {
        cwd,
        hash: commit.hash,
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      })
      setDiff({ path: file.path, text: result.diff, binary: result.binary })
    } catch (cause) {
      setDiff({ path: file.path, text: messageOf(cause), binary: false })
    }
  }

  return (
    <div className={styles.detail}>
      <div className={styles.detailMeta}>
        <span className={styles.hash}>{commit.hash}</span>
        <span>{new Date(commit.date * 1000).toLocaleString()}</span>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {!detail && !error && <div className={panelStyles.note}>读取中…</div>}
      {detail?.body && <div className={styles.body}>{detail.body}</div>}
      {detail && detail.files.length === 0 && <div className={panelStyles.note}>没有改动会话目录里的文件</div>}
      {detail?.files.map((file) => (
        <div key={file.path}>
          <div className={styles.fileRow}>
            <button
              className={styles.fileMain}
              onClick={() => void toggle(file)}
              type="button"
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            >
              <span className={scmStyles.fileName}>{basename(file.path)}</span>
              <span className={scmStyles.fileDir}>{dirname(file.path)}</span>
            </button>
            <span className={`${scmStyles.badge} ${scmStyles[file.status]}`}>{STATUS_LETTER[file.status]}</span>
          </div>
          {openPath === file.path && <DiffView diff={diff?.path === file.path ? diff : null} />}
        </div>
      ))}
    </div>
  )
}

/* --- 分支 ---------------------------------------------------------------- */

function BranchesView({
  cwd,
  head,
  busy,
  act,
}: {
  cwd: string
  /** Re-reads when HEAD moves; a fetch moves only remote branches, so `busy` going idle does too. */
  head: string | null
  busy: string | null
  act: Act
}): JSX.Element {
  const [branches, setBranches] = useState<ScmBranch[] | null>(null)
  const [name, setName] = useState('')

  useEffect(() => {
    if (busy !== null) return
    let stale = false
    call('scm.branches', { cwd })
      .then((result) => {
        if (!stale) setBranches(result.branches)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [cwd, head, busy])

  if (!branches) return <div className={panelStyles.empty}>读取中…</div>

  const local = branches.filter((branch) => !branch.remote)
  const remote = branches.filter((branch) => branch.remote)
  // `origin/feat/x` checks out as `feat/x`.
  const localName = (branch: ScmBranch): string => branch.name.slice(branch.name.indexOf('/') + 1)
  const hasLocal = (branch: ScmBranch): boolean => local.some((entry) => entry.name === localName(branch))

  const switchTo = (target: string, mode: 'switch' | 'create' | 'track'): Promise<boolean> =>
    act('switch', () => call('scm.switch', { cwd, name: target, mode }), { touchesFiles: true })

  const create = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || busy !== null) return
    if (await switchTo(trimmed, 'create')) setName('')
  }

  return (
    <>
      <div className={styles.newBranch}>
        <input
          className={panelStyles.filter}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void create()
          }}
          placeholder="新分支名称，从当前提交创建"
        />
        <button className={styles.syncButton} onClick={() => void create()} disabled={!name.trim() || busy !== null} type="button">
          创建并切换
        </button>
      </div>

      <div className={styles.group}>
        <div className={panelStyles.sectionTitle}>本地分支 · {local.length}</div>
        {local.map((branch) => (
          <div key={branch.name} className={styles.branchRow}>
            <span className={styles.branchMark}>{branch.current && <CheckIcon size={13} />}</span>
            <span className={`${styles.branchRowName} ${branch.current ? styles.branchCurrent : ''}`}>{branch.name}</span>
            {branch.upstream && (
              <span className={styles.track} title={`跟踪 ${branch.upstream}`}>
                {branch.upstream}
                {(branch.ahead > 0 || branch.behind > 0) && ` ↑${branch.ahead} ↓${branch.behind}`}
              </span>
            )}
            <span className={panelStyles.spacer} />
            {!branch.current && (
              <button
                className={panelStyles.toggle}
                onClick={() => void switchTo(branch.name, 'switch')}
                disabled={busy !== null}
                type="button"
              >
                切换
              </button>
            )}
          </div>
        ))}
      </div>

      {remote.length > 0 && (
        <div className={styles.group}>
          <div className={panelStyles.sectionTitle}>远程分支 · {remote.length}</div>
          {remote.map((branch) => (
            <div key={branch.name} className={styles.branchRow}>
              <span className={styles.branchMark} />
              <span className={styles.branchRowName}>{branch.name}</span>
              <span className={panelStyles.spacer} />
              {hasLocal(branch) ? (
                local.find((entry) => entry.name === localName(branch))?.current ? null : (
                  <button
                    className={panelStyles.toggle}
                    onClick={() => void switchTo(localName(branch), 'switch')}
                    disabled={busy !== null}
                    type="button"
                    title={`切换到本地的 ${localName(branch)}`}
                  >
                    切换
                  </button>
                )
              ) : (
                <button
                  className={panelStyles.toggle}
                  onClick={() => void switchTo(branch.name, 'track')}
                  disabled={busy !== null}
                  type="button"
                  title={`新建本地分支 ${localName(branch)} 并跟踪它`}
                >
                  检出
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* --- helpers ------------------------------------------------------------- */

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}
