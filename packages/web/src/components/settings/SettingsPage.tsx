import type { SettingsOverride, UserSettings } from '@ccw/shared'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { call } from '../../api/client.ts'
import { useActiveSessionValue, useStore } from '../../store/session.ts'
import {
  applyForm,
  formProblems,
  fullModelId,
  maskSecrets,
  SECRET_MASK,
  toForm,
  unmaskSecrets,
  type AuthField,
  type SettingsForm,
} from '../../utils/settings.ts'
import dialog from '../auth/Auth.module.css'
import { CodeEditor } from '../details/CodeEditor.tsx'
import { ArrowLeftIcon, ChevronRightIcon, EyeIcon, EyeOffIcon } from '../Icons.tsx'
import { ModelList, type UpstreamAnswer } from './ModelList.tsx'
import styles from './Settings.module.css'

type Json = Record<string, unknown>

const ROLE_LABELS: Record<string, string> = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'Opus',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'Sonnet',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Haiku',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'Fable',
  CLAUDE_CODE_SUBAGENT_MODEL: '子 agent',
  ANTHROPIC_SMALL_FAST_MODEL: 'Small fast（旧）',
}

const SOURCE_LABELS: Record<SettingsOverride['source'], string> = {
  project: '项目配置',
  local: '项目本地配置',
  flag: '启动参数',
  managed: '组织管理配置',
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

function parseJson(text: string): Json {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('顶层必须是 JSON 对象')
  return parsed as Json
}

const showAsJson = (settings: Json): string => JSON.stringify(maskSecrets(settings), null, 2)

/**
 * The user-level settings.json at `/settings`: the channel and the model menu
 * as a form, beside the whole file as JSON, each following the other's edits.
 * Nothing is written until 保存, and leaving the page drops what was not
 * saved. Live sessions pick a saved channel up at their next model refresh —
 * the composer runs one every few seconds.
 */
export function SettingsPage({ onLeave }: { onLeave: () => void }): JSX.Element {
  const cwd = useActiveSessionValue((session) => session.cwd)
  const refreshModels = useStore((state) => state.refreshModels)
  const [loaded, setLoaded] = useState<UserSettings | null>(null)
  /** What the form is applied over: the file, or the JSON as last typed. */
  const [base, setBase] = useState<Json>({})
  const [form, setForm] = useState<SettingsForm>(() => toForm({}))
  /** The JSON as typed, until the next form edit; null while it shows what the form makes of `base`. */
  const [typed, setTyped] = useState<string | null>(null)
  /** Why `typed` does not parse; the form waits until it does. */
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [rolesOpen, setRolesOpen] = useState(false)
  /** The last 获取模型列表, with the channel it was asked of. */
  const [asked, setAsked] = useState<(UpstreamAnswer & { channel: string }) | null>(null)
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Set by a save, and shown until the next edit. */
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const page = useRef<HTMLDivElement>(null)
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

  const load = async (): Promise<void> => {
    const request = ++requests.current
    try {
      const next = await call('settings.read', cwd ? { cwd } : {})
      if (request !== requests.current) return
      show(next)
      setSaved(false)
    } catch (cause) {
      if (request === requests.current) setError(describe(cause))
    }
  }

  const draft: Json | null = jsonError !== null ? null : typed === null ? applyForm(base, form) : base
  const dirty = loaded !== null && (draft === null || JSON.stringify(draft) !== JSON.stringify(loaded.settings))
  const problems = jsonError !== null ? [`JSON 有误：${jsonError}`] : formProblems(form)
  const canSave = loaded !== null && dirty && problems.length === 0 && !saving

  // Read again as the session beneath changes, for the overrides its project
  // adds — a reload of this page opens that session a moment later. Never
  // over edits.
  useEffect(() => {
    if (!dirty) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  useEffect(() => page.current?.focus(), [])

  const save = async (): Promise<void> => {
    if (!canSave || !draft) return
    requests.current += 1
    setSaving(true)
    setError(null)
    try {
      const next = await call('settings.write', { settings: draft, revision: loaded.revision, ...(cwd ? { cwd } : {}) })
      void refreshModels()
      show(next)
      setSaved(true)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setSaving(false)
    }
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
  const channel = JSON.stringify([form.baseUrl.trim(), form.authField, form.key])
  const upstream = asked?.channel === channel ? asked : null

  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    try {
      const { models } = await call('settings.fetchModels', { baseUrl: form.baseUrl, authField: form.authField, key: form.key })
      setAsked({ channel, models, error: null })
    } catch (cause) {
      setAsked({ channel, models: [], error: describe(cause) })
    } finally {
      setFetching(false)
    }
  }

  const pickerIds = form.models.filter((row) => row.model.trim()).map((row) => ({ id: fullModelId(row), label: row.label }))
  const known = new Set(pickerIds.map(({ id }) => id))
  const roleChoices = [
    ...pickerIds,
    ...(upstream?.models ?? []).filter(({ id }) => !known.has(id)).map(({ id, owner }) => ({ id, label: owner ?? '' })),
  ]
  const rolesSet = Object.values(form.roles).filter((value) => value.trim()).length

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
    status = <span className={styles.statusSaved}>已保存。渠道和模型列表在会话空闲时切换，其他设置对新会话生效。</span>
  } else if (dirty) {
    status = <span className={styles.statusDirty}>有未保存的修改，离开这个页面就会丢弃</span>
  }

  return (
    <div ref={page} className={styles.page} tabIndex={-1} onKeyDown={onKeyDown} role="region" aria-label="设置">
      <div className={styles.head}>
        <button className={styles.back} onClick={onLeave} type="button" title="回到会话，没保存的修改会丢弃">
          <ArrowLeftIcon size={15} />
          返回
        </button>
        <span className={styles.title}>设置</span>
        {loaded && (
          <span className={styles.path} title={loaded.path}>
            {loaded.path}
          </span>
        )}
      </div>

      <div className={styles.panes}>
        <div className={styles.formPane}>
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

          {!loaded ? (
            !error && <div className={dialog.muted}>读取中…</div>
          ) : (
            <fieldset className={styles.form} disabled={jsonError !== null}>
              <section className={styles.section}>
                <div className={dialog.sectionTitle}>渠道</div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ccw-settings-url">
                    请求地址
                  </label>
                  <input
                    id="ccw-settings-url"
                    className={`${styles.input} ${problems.some((p) => p.startsWith('请求地址')) ? styles.invalid : ''}`}
                    value={form.baseUrl}
                    onChange={(event) => patch({ baseUrl: event.target.value })}
                    placeholder="留空使用官方地址，例如 https://api.example.com"
                    spellCheck={false}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ccw-settings-auth">
                    认证字段
                  </label>
                  <select
                    id="ccw-settings-auth"
                    className={styles.input}
                    value={form.authField}
                    onChange={(event) => patch({ authField: event.target.value as AuthField })}
                  >
                    <option value="ANTHROPIC_AUTH_TOKEN">ANTHROPIC_AUTH_TOKEN（Authorization: Bearer）</option>
                    <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY（x-api-key）</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ccw-settings-key">
                    Key
                  </label>
                  <div className={styles.secret}>
                    <input
                      id="ccw-settings-key"
                      className={styles.input}
                      type={showKey ? 'text' : 'password'}
                      value={form.key}
                      onChange={(event) => patch({ key: event.target.value })}
                      placeholder="留空使用 CLI 自己的登录"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      className={styles.iconButton}
                      onClick={() => setShowKey(!showKey)}
                      type="button"
                      title={showKey ? '隐藏' : '显示'}
                      aria-label={showKey ? '隐藏 Key' : '显示 Key'}
                    >
                      {showKey ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
                    </button>
                  </div>
                </div>
              </section>

              <ModelList form={form} onChange={patch} upstream={upstream} fetching={fetching} onFetch={() => void fetchModels()} />

              <section className={styles.section}>
                <button
                  className={styles.disclosure}
                  onClick={() => setRolesOpen(!rolesOpen)}
                  type="button"
                  aria-expanded={rolesOpen}
                >
                  <span className={rolesOpen ? styles.chevronOpen : styles.chevron}>
                    <ChevronRightIcon size={14} />
                  </span>
                  角色映射
                  {rolesSet > 0 && <span className={styles.count}>{rolesSet}</span>}
                </button>
                {rolesOpen && (
                  <>
                    <div className={dialog.muted}>
                      Claude Code 内部仍按 opus、sonnet、haiku 这些别名调用模型，比如后台的小任务和子 agent。接第三方网关时，要把它们映射到网关认识的模型。
                    </div>
                    <button
                      className={styles.add}
                      onClick={() =>
                        patch({ roles: Object.fromEntries(Object.keys(form.roles).map((key) => [key, form.defaultModel])) })
                      }
                      disabled={!form.defaultModel}
                      type="button"
                      title={form.defaultModel ? `全部设为 ${form.defaultModel}` : '先在模型列表里选一个默认模型'}
                    >
                      全部设为默认模型
                    </button>
                    <div className={styles.roles}>
                      {Object.entries(form.roles).map(([key, value]) => (
                        <div className={styles.field} key={key}>
                          <label className={styles.label} htmlFor={`ccw-settings-${key}`} title={key}>
                            {ROLE_LABELS[key] ?? key}
                          </label>
                          <input
                            id={`ccw-settings-${key}`}
                            className={styles.input}
                            list="ccw-picker-models"
                            value={value}
                            onChange={(event) => patch({ roles: { ...form.roles, [key]: event.target.value } })}
                            placeholder={key}
                            spellCheck={false}
                          />
                        </div>
                      ))}
                    </div>
                    <datalist id="ccw-picker-models">
                      {roleChoices.map(({ id, label }) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </datalist>
                  </>
                )}
              </section>
            </fieldset>
          )}
        </div>

        <div className={styles.jsonPane}>
          <div className={dialog.sectionTitle}>settings.json</div>
          <div className={dialog.muted}>
            和左边的表单互相同步。密钥显示为 {SECRET_MASK}，保持不变就不会修改；要查看或修改密钥，在表单里改。这里的大多数设置对新会话生效。
          </div>
          {loaded && (
            <div className={styles.editor}>
              <CodeEditor
                path="settings.json"
                value={typed ?? (draft ? showAsJson(draft) : '')}
                readOnly={false}
                dirty={false}
                onChange={editJson}
              />
            </div>
          )}
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.status} role="status">
          {status}
        </div>
        <button
          className={`${dialog.button} ${dialog.primary}`}
          onClick={() => void save()}
          disabled={!canSave}
          type="button"
          title="Ctrl/⌘ + S"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
