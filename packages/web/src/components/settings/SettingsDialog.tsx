import type { SettingsOverride, UserSettings } from '@ccw/shared'
import { useEffect, useRef, useState } from 'react'

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
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { CodeEditor } from '../details/CodeEditor.tsx'
import { ChevronRightIcon, EyeIcon, EyeOffIcon, XIcon } from '../Icons.tsx'
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
 * Edits the user-level settings.json: the channel and the model menu as a
 * form, everything else as JSON. Live sessions pick a saved channel up at
 * their next model refresh — the composer runs one every few seconds.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const cwd = useActiveSessionValue((session) => session.cwd)
  const refreshModels = useStore((state) => state.refreshModels)
  const [loaded, setLoaded] = useState<UserSettings | null>(null)
  /** What the form is applied over: the file, plus edits made in the JSON view. */
  const [base, setBase] = useState<Json>({})
  const [form, setForm] = useState<SettingsForm>(() => toForm({}))
  /** The JSON view's text; null while the form is shown. */
  const [json, setJson] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [rolesOpen, setRolesOpen] = useState(false)
  /** The last 获取模型列表, with the channel it was asked of. */
  const [asked, setAsked] = useState<(UpstreamAnswer & { channel: string }) | null>(null)
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Set by a save, and shown until the next edit. */
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Closing with unsaved edits, waiting on 放弃修改 / 继续编辑. */
  const [discarding, setDiscarding] = useState(false)

  const show = (next: UserSettings, asJson: boolean): void => {
    setLoaded(next)
    setBase(next.settings)
    setForm(toForm(next.settings))
    setJson(asJson ? showAsJson(next.settings) : null)
    setError(null)
  }

  const load = async (): Promise<void> => {
    try {
      show(await call('settings.read', cwd ? { cwd } : {}), false)
      setSaved(false)
    } catch (cause) {
      setError(describe(cause))
    }
  }

  useEffect(() => {
    void load()
    // Mount-only: switching sessions behind the dialog must not drop its edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  let draft: Json | null = null
  let jsonError: string | null = null
  try {
    draft = json === null ? applyForm(base, form) : unmaskSecrets(parseJson(json), base)
  } catch (cause) {
    jsonError = describe(cause)
  }
  const dirty = loaded !== null && (draft === null || JSON.stringify(draft) !== JSON.stringify(loaded.settings))
  const problems = jsonError ? [`JSON 有误：${jsonError}`] : json === null ? formProblems(form) : []
  const canSave = loaded !== null && dirty && problems.length === 0 && !saving

  const close = (): void => {
    if (dirty) setDiscarding(true)
    else onClose()
  }

  const save = async (): Promise<void> => {
    if (!canSave || !draft) return
    setSaving(true)
    setError(null)
    try {
      const next = await call('settings.write', { settings: draft, revision: loaded.revision, ...(cwd ? { cwd } : {}) })
      void refreshModels()
      show(next, json !== null)
      setSaved(true)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setSaving(false)
    }
  }

  const keys = useRef({ close, save })
  keys.current = { close, save }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') keys.current.close()
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void keys.current.save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const showJson = (): void => {
    const next = applyForm(base, form)
    setBase(next)
    setJson(showAsJson(next))
  }

  const showForm = (): void => {
    if (!draft) return
    setBase(draft)
    setForm(toForm(draft))
    setJson(null)
  }

  const patch = (next: Partial<SettingsForm>): void => setForm((current) => ({ ...current, ...next }))

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
    status = <span className={styles.statusDirty}>有未保存的修改</span>
  }

  return (
    <div className={dialog.backdrop} onMouseDown={close}>
      <div
        className={`${dialog.dialog} ${styles.dialog}`}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <div className={dialog.dialogHead}>
          <span className={dialog.dialogTitle}>设置</span>
          <div className={styles.tabs} role="tablist">
            <button
              className={json === null ? styles.tabActive : styles.tab}
              onClick={json === null ? undefined : showForm}
              disabled={!loaded || jsonError !== null}
              type="button"
              role="tab"
              aria-selected={json === null}
              title={jsonError ? 'JSON 有误，改好才能切回表单' : undefined}
            >
              表单
            </button>
            <button
              className={json !== null ? styles.tabActive : styles.tab}
              onClick={json === null ? showJson : undefined}
              disabled={!loaded}
              type="button"
              role="tab"
              aria-selected={json !== null}
            >
              JSON
            </button>
          </div>
          <span className={dialog.spacer} />
          <button className={dialog.close} onClick={close} type="button" aria-label="关闭">
            <XIcon />
          </button>
        </div>

        {loaded && <div className={styles.path}>{loaded.path}</div>}

        <div className={styles.body}>
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

          {!loaded ? (
            !error && <div className={dialog.muted}>读取中…</div>
          ) : json !== null ? (
            <>
              <div className={dialog.muted}>
                密钥显示为 {SECRET_MASK}，保持不变就不会修改；要查看或修改密钥，回到表单。这里的大多数设置对新会话生效。
              </div>
              <div className={styles.editor}>
                <CodeEditor path="settings.json" value={json} readOnly={false} dirty={false} onChange={setJson} />
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.status} role="status">
            {status}
          </div>
          <button className={dialog.button} onClick={close} type="button">
            {dirty ? '取消' : '关闭'}
          </button>
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

      {discarding && (
        <ConfirmDialog
          title="放弃未保存的修改？"
          message="设置里还有没保存的修改，关闭后会丢失。"
          confirmLabel="放弃修改"
          cancelLabel="继续编辑"
          danger
          onConfirm={onClose}
          onCancel={() => setDiscarding(false)}
        />
      )}
    </div>
  )
}
