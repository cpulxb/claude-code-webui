import type { ChannelLibrary, SettingsOverride, UserSettings } from '@ccw/shared'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { call } from '../../api/client.ts'
import { settingsHref, useActiveSessionValue, useStore, type ChatLayout, type SettingsSection } from '../../store/session.ts'
import { channelProblems, fromLibrary, newChannelId, switchTo, toLibrary, type ChannelDraft } from '../../utils/channels.ts'
import { applyForm, formProblems, maskSecrets, SECRET_MASK, toForm, unmaskSecrets, type SettingsForm } from '../../utils/settings.ts'
import { NARROW, useNarrow } from '../../utils/narrow.ts'
import { notificationsSupported } from '../Attention.tsx'
import dialog from '../auth/Auth.module.css'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { CodeEditor } from '../details/CodeEditor.tsx'
import {
  ArrowLeftIcon,
  BoxIcon,
  BracesIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MonitorIcon,
  PlugIcon,
  ShareIcon,
} from '../Icons.tsx'
import { ChannelEditor } from './ChannelEditor.tsx'
import { ChannelList } from './ChannelList.tsx'
import { ModelList, type UpstreamAnswer } from './ModelList.tsx'
import { RoleMap } from './RoleMap.tsx'
import styles from './Settings.module.css'
import { SharesSection } from './SharesSection.tsx'

type Json = Record<string, unknown>

const SOURCE_LABELS: Record<SettingsOverride['source'], string> = {
  project: '项目配置',
  local: '项目本地配置',
  flag: '启动参数',
  managed: '组织管理配置',
}

const SECTIONS: { id: SettingsSection; label: string; desc: string; icon: JSX.Element }[] = [
  { id: 'general', label: '通用', desc: '对话显示和提醒，只保存在这个浏览器里', icon: <MonitorIcon /> },
  { id: 'channels', label: '渠道', desc: '连接哪个服务、用哪把密钥', icon: <PlugIcon /> },
  { id: 'models', label: '模型', desc: '当前渠道的模型列表和角色映射', icon: <BoxIcon /> },
  { id: 'json', label: 'settings.json', desc: '直接编辑配置文件', icon: <BracesIcon /> },
  { id: 'shares', label: '分享', desc: '管理已发出的分享链接', icon: <ShareIcon /> },
]

const LAYOUTS: [ChatLayout, string, string][] = [
  ['compact', '简洁', '连续的工具调用合成一行，跑完的回合只露出最终回复'],
  ['detailed', '详细', '每次工具调用都是一张展开的卡片'],
]

/** A thumbnail of each layout: a prompt, then the turn as that layout draws it. */
function LayoutPreview({ layout }: { layout: ChatLayout }): JSX.Element {
  return (
    <span className={styles.preview} aria-hidden="true">
      <span className={`${styles.previewLine} ${styles.previewPrompt}`} />
      {layout === 'compact' ? (
        <span className={styles.previewFold} />
      ) : (
        <>
          <span className={styles.previewCard} />
          <span className={styles.previewCard} />
        </>
      )}
      <span className={`${styles.previewLine} ${styles.previewWide}`} />
      <span className={styles.previewLine} />
    </span>
  )
}

/** The desktop-notification switch, and what the browser says about it. */
function NotifySetting(): JSX.Element {
  const notify = useStore((state) => state.notify)
  const setNotify = useStore((state) => state.setNotify)
  const supported = notificationsSupported()
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    supported ? Notification.permission : 'denied',
  )

  const toggle = async (on: boolean): Promise<void> => {
    if (!on) return setNotify(false)
    // Asked from the click itself: most browsers only show the prompt for one.
    const answer = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    setPermission(answer)
    setNotify(answer === 'granted')
    // One straight away, so a system that silences the browser shows up now rather than when it matters.
    if (answer === 'granted') {
      new Notification('Claude Code', {
        body: '通知已开启：页面不在前台时，会话跑完、出错或等你确认都会在这里提醒。',
        icon: '/apple-touch-icon.png',
      })
    }
  }

  // Text and control share a row: the text column gives way (min-width: 0),
  // the switch never does, so a phone no longer breaks the label a glyph a line.
  return (
    <div className={styles.prefs}>
      <label className={styles.pref}>
        <span className={styles.prefText}>
          <span className={styles.prefLabel}>桌面通知</span>
          <span className={styles.prefDesc}>页面不在前台时，会话跑完、出错或等你确认就弹出通知</span>
          {!supported ? (
            <span className={styles.prefWarning}>当前地址不支持桌面通知：需要通过 HTTPS 或 localhost 打开。</span>
          ) : permission === 'denied' ? (
            <span className={styles.prefWarning}>
              浏览器已阻止这个网站的通知。到地址栏左侧的网站设置里把「通知」改成允许，再回来打开。
            </span>
          ) : null}
        </span>
        <input
          className={styles.checkSwitch}
          type="checkbox"
          role="switch"
          checked={notify && permission === 'granted'}
          disabled={!supported}
          onChange={(event) => void toggle(event.target.checked)}
        />
      </label>
      <div className={styles.pref}>
        <span className={styles.prefText}>
          <span className={styles.prefLabel}>标签页计数</span>
          <span className={styles.prefDesc}>标签页标题会显示需要你关注的会话数，例如「(2) Claude Code」，不需要授权</span>
        </span>
        <span className={styles.prefValue}>始终开启</span>
      </div>
    </div>
  )
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

function parseJson(text: string): Json {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('顶层必须是 JSON 对象')
  return parsed as Json
}

const showAsJson = (settings: Json): string => JSON.stringify(maskSecrets(settings), null, 2)

/** Which upstream answer belongs to a form: one asked with another address or key is another channel's. */
const connectionOf = (form: SettingsForm): string => JSON.stringify([form.baseUrl.trim(), form.authField, form.key])

/**
 * The settings page at `/settings/<section>`, a section per sidebar entry:
 * what only this browser keeps, then the user-level settings.json as the
 * channel and model forms and as the whole file in JSON, each following the
 * other's edits, and the saved channels to switch between. The form is the
 * active channel. The draft spans the sections, so moving between them keeps
 * it; nothing is written until 保存 — or a channel's switch, which saves at
 * once — and leaving the page drops what was not saved. Live sessions pick a
 * saved channel up at their next model refresh — the composer runs one every
 * few seconds.
 */
export function SettingsPage({ section, onLeave }: { section: SettingsSection; onLeave: () => void }): JSX.Element {
  const cwd = useActiveSessionValue((session) => session.cwd)
  const setSettingsSection = useStore((state) => state.setSettingsSection)
  const refreshModels = useStore((state) => state.refreshModels)
  const chatLayout = useStore((state) => state.chatLayout)
  const setChatLayout = useStore((state) => state.setChatLayout)
  const [loaded, setLoaded] = useState<UserSettings | null>(null)
  /** What the form is applied over: the file, or the JSON as last typed. */
  const [base, setBase] = useState<Json>({})
  const [form, setForm] = useState<SettingsForm>(() => toForm({}))
  /** The JSON as typed, until the next form edit; null while it shows what the form makes of `base`. */
  const [typed, setTyped] = useState<string | null>(null)
  /** Why `typed` does not parse; the form waits until it does. */
  const [jsonError, setJsonError] = useState<string | null>(null)
  /** The channel list as last read or saved. */
  const [library, setLibrary] = useState<ChannelLibrary | null>(null)
  /** The channels as edited; the active entry's form is stale, the page's `form` stands for it. */
  const [drafts, setDrafts] = useState<ChannelDraft[]>([])
  const [activeId, setActiveId] = useState('')
  /** What `toLibrary` gave for the channels as read, to tell when they were edited. */
  const [baseline, setBaseline] = useState('')
  /** The channel open in the 渠道 section's editor, or null for the list. */
  const [editing, setEditing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ChannelDraft | null>(null)
  /** The last 获取模型列表, with the channel it was asked of. */
  const [asked, setAsked] = useState<(UpstreamAnswer & { channel: string }) | null>(null)
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Set by a save, and shown until the next edit. */
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const page = useRef<HTMLDivElement>(null)
  const narrow = useNarrow()
  // A phone opens on the list of sections, as its settings apps do; a link
  // to one of the others opens that one.
  const [picking, setPicking] = useState(() => NARROW.matches && section === 'general')
  const listing = narrow && picking
  const current = SECTIONS.find(({ id }) => id === section) ?? SECTIONS[0]!
  /** Counts reads and writes, so a read still out cannot land over a later one. */
  const requests = useRef(0)

  const show = (next: UserSettings): void => {
    setLoaded(next)
    setBase(next.settings)
    setForm(toForm(next.settings))
    setTyped(null)
    setJsonError(null)
    setError(null)
  }

  const showLibrary = (next: ChannelLibrary, settings: Json): void => {
    const derived = fromLibrary(next, settings)
    setLibrary(next)
    setDrafts(derived.drafts)
    setActiveId(derived.activeId)
    setBaseline(JSON.stringify(toLibrary(derived.drafts, derived.activeId, toForm(settings))))
  }

  const load = async (): Promise<void> => {
    const request = ++requests.current
    try {
      const [next, channels] = await Promise.all([call('settings.read', cwd ? { cwd } : {}), call('channels.read', {})])
      if (request !== requests.current) return
      show(next)
      showLibrary(channels, next.settings)
      setSaved(false)
    } catch (cause) {
      if (request === requests.current) setError(describe(cause))
    }
  }

  const draft: Json | null = jsonError !== null ? null : typed === null ? applyForm(base, form) : base
  const settingsDirty = loaded !== null && (draft === null || JSON.stringify(draft) !== JSON.stringify(loaded.settings))
  const channelsDirty = library !== null && JSON.stringify(toLibrary(drafts, activeId, form)) !== baseline
  const dirty = settingsDirty || channelsDirty
  const problems = jsonError !== null ? [`JSON 有误：${jsonError}`] : [...formProblems(form), ...channelProblems(drafts, activeId)]
  const canSave = loaded !== null && library !== null && dirty && problems.length === 0 && !saving

  // Read again as the session beneath changes, for the overrides its project
  // adds — a reload of this page opens that session a moment later. Never
  // over edits.
  useEffect(() => {
    if (!dirty) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  useEffect(() => page.current?.focus(), [])

  /**
   * Writes the channel list, with settings.json when it changed, in one
   * request that checks both revisions before writing either. The active
   * channel is saved as `settings` makes it.
   */
  const persist = async (settings: Json, channels: ChannelDraft[], active: string): Promise<void> => {
    if (!loaded || !library) return
    requests.current += 1
    setSaving(true)
    setError(null)
    try {
      const changed = JSON.stringify(settings) !== JSON.stringify(loaded.settings)
      const result = await call('channels.write', {
        ...toLibrary(channels, active, toForm(settings)),
        revision: library.revision,
        ...(changed ? { settings: { settings, revision: loaded.revision, ...(cwd ? { cwd } : {}) } } : {}),
      })
      void refreshModels()
      const written = result.settings ?? loaded
      show(written)
      showLibrary(result.library, written.settings)
      setSaved(true)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setSaving(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!canSave || !draft) return
    await persist(draft, drafts, activeId)
  }

  /** Turning a channel on: settings.json switches to it at once, the one it leaves keeping its latest form. */
  const activate = (id: string): void => {
    const target = drafts.find((entry) => entry.id === id)
    if (!loaded || !target || dirty || saving || id === activeId) return
    const kept = drafts.map((entry) => (entry.id === activeId ? { ...entry, form } : entry))
    void persist(switchTo(loaded.settings, target.form), kept, id)
  }

  const patchChannel = (id: string, next: Partial<ChannelDraft>): void =>
    setDrafts((current) => current.map((entry) => (entry.id === id ? { ...entry, ...next } : entry)))

  const addChannel = (): void => {
    const id = newChannelId()
    setDrafts((current) => [...current, { id, name: '', form: toForm({}) }])
    setEditing(id)
  }

  const duplicateChannel = (id: string): void => {
    const source = drafts.find((entry) => entry.id === id)
    if (!source) return
    const copy = { id: newChannelId(), name: `${source.name.trim()} 副本`, form: structuredClone(id === activeId ? form : source.form) }
    setDrafts((current) => current.flatMap((entry) => (entry.id === id ? [entry, copy] : [entry])))
  }

  // Keys stay on the page: the workspace beneath listens on the window for
  // its own shortcuts, such as Ctrl+P for its file tree.
  const onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation()
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  const patch = (next: Partial<SettingsForm>): void => {
    setForm((current) => ({ ...current, ...next }))
    // The JSON shows what the form makes again, in place of the text typed there.
    setTyped(null)
  }

  const editJson = (text: string): void => {
    setTyped(text)
    try {
      // A masked key stands for the one the form holds now.
      const next = unmaskSecrets(parseJson(text), draft ?? base)
      setBase(next)
      setForm(toForm(next))
      setJsonError(null)
    } catch (cause) {
      setJsonError(describe(cause))
    }
  }

  // A list fetched with another address or key belongs to another channel: it is dropped once those change.
  const upstreamOf = (of: SettingsForm): UpstreamAnswer | null => (asked?.channel === connectionOf(of) ? asked : null)

  const fetchModels = async (of: SettingsForm): Promise<void> => {
    const channel = connectionOf(of)
    setFetching(true)
    try {
      const { models } = await call('settings.fetchModels', { baseUrl: of.baseUrl, authField: of.authField, key: of.key })
      setAsked({ channel, models, error: null })
    } catch (cause) {
      setAsked({ channel, models: [], error: describe(cause) })
    } finally {
      setFetching(false)
    }
  }

  const activeName = drafts.find((entry) => entry.id === activeId)?.name.trim() || '未命名渠道'
  const edited = drafts.find((entry) => entry.id === editing)

  let status: JSX.Element | null = null
  if (error) {
    status = (
      <span className={styles.statusError}>
        {error}
        <button className={styles.linkButton} onClick={() => void load()} type="button">
          {loaded ? '重新载入（放弃修改）' : '重新载入'}
        </button>
      </span>
    )
  } else if (problems.length > 0) {
    status = <span className={styles.statusError}>{problems[0]}</span>
  } else if (saved && !dirty) {
    status = <span className={styles.statusSaved}>已保存，当前渠道是「{activeName}」。渠道和模型列表在会话空闲时切换，其他设置对新会话生效。</span>
  } else if (dirty) {
    status = <span className={styles.statusDirty}>有未保存的修改，离开这个页面就会丢弃</span>
  }

  const notices = (
    <>
      {loaded && loaded.overrides.length > 0 && (
        <div className={styles.warning}>
          下面这些设置被优先级更高的配置覆盖，在这里修改不会生效：
          <ul className={styles.overrides}>
            {loaded.overrides.map((override) => (
              <li key={`${override.source}:${override.key}`}>
                <code>{override.key}</code>（{SOURCE_LABELS[override.source]}
                {override.path ? ` ${override.path}` : ''}）
              </li>
            ))}
          </ul>
        </div>
      )}
      {jsonError !== null && <div className={styles.warning}>JSON 有误，改好之前表单停在上一次能解析的内容，不能编辑。</div>}
    </>
  )

  /** A settings.json section's fields, once the file is read; a JSON that does not parse disables them. */
  const fileForm = (children: JSX.Element): JSX.Element =>
    !loaded ? (
      <>{!error && <div className={dialog.muted}>读取中…</div>}</>
    ) : (
      <fieldset className={styles.form} disabled={jsonError !== null}>
        {children}
      </fieldset>
    )

  let content: JSX.Element
  switch (section) {
    case 'general':
      content = (
        // Not part of settings.json: it takes effect at once, with nothing to save.
        <section className={styles.section}>
          <div className={styles.groupTitle}>对话显示</div>
          <div className={styles.choices} role="radiogroup" aria-label="对话显示">
            {LAYOUTS.map(([value, label, note]) => (
              <label key={value} className={`${styles.choice} ${chatLayout === value ? styles.choiceOn : ''}`}>
                <input
                  className={styles.choiceInput}
                  type="radio"
                  name="ccw-chat-layout"
                  checked={chatLayout === value}
                  onChange={() => setChatLayout(value)}
                />
                <LayoutPreview layout={value} />
                <span className={styles.choiceText}>
                  <span className={styles.choiceTitle}>
                    <span className={styles.radio} />
                    {label}
                  </span>
                  <span className={styles.choiceNote}>{note}</span>
                </span>
              </label>
            ))}
          </div>
          <div className={`${styles.groupTitle} ${styles.subTitle}`}>提醒</div>
          <NotifySetting />
          <div className={dialog.muted}>以上切换后立即生效，不用点保存。</div>
        </section>
      )
      break
    case 'channels':
      content = edited ? (
        fileForm(
          <ChannelEditor
            key={edited.id}
            name={edited.name}
            onName={(name) => patchChannel(edited.id, { name })}
            form={edited.id === activeId ? form : edited.form}
            onChange={edited.id === activeId ? patch : (next) => patchChannel(edited.id, { form: { ...edited.form, ...next } })}
            active={edited.id === activeId}
            upstream={upstreamOf(edited.id === activeId ? form : edited.form)}
            fetching={fetching}
            onFetch={() => void fetchModels(edited.id === activeId ? form : edited.form)}
            onBack={() => setEditing(null)}
          />,
        )
      ) : (
        <>
          {notices}
          {fileForm(
            <ChannelList
              drafts={drafts}
              activeId={activeId}
              activeForm={form}
              locked={saving ? '保存中…' : dirty ? '有未保存的修改，先保存或放弃（重新载入）再切换渠道' : null}
              onActivate={activate}
              onEdit={setEditing}
              onDuplicate={duplicateChannel}
              onDelete={(id) => setDeleting(drafts.find((entry) => entry.id === id) ?? null)}
              onAdd={addChannel}
            />,
          )}
        </>
      )
      break
    case 'models':
      content = (
        <>
          {notices}
          <div className={dialog.muted}>
            当前渠道「{activeName}」的模型。要换一套模型，到
            <a
              className={styles.inlineLink}
              href={settingsHref('channels')}
              onClick={(event) => {
                event.preventDefault()
                setSettingsSection('channels')
              }}
            >
              渠道
            </a>
            里切换。
          </div>
          {fileForm(
            <>
              <ModelList form={form} onChange={patch} upstream={upstreamOf(form)} fetching={fetching} onFetch={() => void fetchModels(form)} />
              <RoleMap form={form} onChange={patch} upstream={upstreamOf(form)?.models ?? []} />
            </>,
          )}
        </>
      )
      break
    case 'shares':
      content = <SharesSection />
      break
    case 'json':
      content = (
        <>
          <div className={dialog.muted}>
            和「渠道」「模型」里的表单互相同步。密钥显示为 {SECRET_MASK}，保持不变就不会修改；要查看或修改密钥，在表单里改。这里的大多数设置对新会话生效。
          </div>
          {loaded ? (
            <div className={styles.editor}>
              <CodeEditor
                path="settings.json"
                value={typed ?? (draft ? showAsJson(draft) : '')}
                readOnly={false}
                dirty={false}
                onChange={editJson}
              />
            </div>
          ) : (
            !error && <div className={dialog.muted}>读取中…</div>
          )}
        </>
      )
      break
  }

  return (
    <div ref={page} className={styles.page} tabIndex={-1} onKeyDown={onKeyDown} role="region" aria-label="设置">
      <div className={styles.head}>
        {narrow ? (
          <button
            className={styles.iconButton}
            onClick={listing ? onLeave : () => setPicking(true)}
            type="button"
            title={listing ? '回到会话，没保存的修改会丢弃' : '所有设置'}
            aria-label={listing ? '回到会话' : '所有设置'}
          >
            <ChevronLeftIcon size={20} />
          </button>
        ) : (
          <button className={styles.back} onClick={onLeave} type="button" title="回到会话，没保存的修改会丢弃">
            <ArrowLeftIcon size={15} />
            返回
          </button>
        )}
        <span className={styles.title}>{narrow && !listing ? current.label : '设置'}</span>
        {loaded && !narrow && (
          <span className={styles.path} title={loaded.path}>
            {loaded.path}
          </span>
        )}
      </div>

      {listing ? (
        <div className={styles.listPage}>
          <div className={styles.hero}>设置</div>
          {loaded && <div className={styles.heroPath}>{loaded.path}</div>}
          <nav className={styles.list} aria-label="设置分类">
            {SECTIONS.map(({ id, label, desc, icon }) => (
              <a
                key={id}
                href={settingsHref(id)}
                className={styles.listRow}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                  event.preventDefault()
                  setSettingsSection(id)
                  setPicking(false)
                }}
              >
                <span className={styles.listIcon}>{icon}</span>
                <span className={styles.listText}>
                  {label}
                  <span className={styles.listDesc}>{desc}</span>
                </span>
                <ChevronRightIcon size={16} />
              </a>
            ))}
          </nav>
        </div>
      ) : (
        <div className={styles.body}>
          <nav className={styles.nav} aria-label="设置分类">
            {SECTIONS.map(({ id, label, icon }) => (
              // Links, so a section can be opened in a new tab or have its address copied.
              <a
                key={id}
                href={settingsHref(id)}
                className={id === section ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem}
                aria-current={id === section ? 'page' : undefined}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                  event.preventDefault()
                  setSettingsSection(id)
                }}
              >
                {icon}
                {label}
              </a>
            ))}
          </nav>
          <div className={styles.content}>
            <div className={section === 'json' ? `${styles.card} ${styles.cardFill}` : styles.card}>
              <header className={styles.pageHead}>
                <h2>{current.label}</h2>
                <p>{current.desc}</p>
              </header>
              {content}
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title="删除渠道"
          message={`删除渠道「${deleting.name.trim() || '未命名渠道'}」？点保存后才会真正删除。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            setDrafts((current) => current.filter((entry) => entry.id !== deleting.id))
            if (editing === deleting.id) setEditing(null)
            setDeleting(null)
          }}
          onCancel={() => setDeleting(null)}
        />
      )}

      {/* Only once there is something to say or save: a grayed-out 保存 sitting
          under every section read as a control that was broken. */}
      {(status || canSave || saving) && (
        <div className={styles.footer}>
          <div className={styles.status} role="status">
            {status}
          </div>
          <button className={styles.save} onClick={() => void save()} disabled={!canSave} type="button" title="Ctrl/⌘ + S">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}
    </div>
  )
}
