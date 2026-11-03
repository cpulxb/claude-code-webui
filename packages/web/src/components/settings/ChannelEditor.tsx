import { useState } from 'react'

import { formProblems, type AuthField, type SettingsForm } from '../../utils/settings.ts'
import dialog from '../auth/Auth.module.css'
import { ArrowLeftIcon, EyeIcon, EyeOffIcon } from '../Icons.tsx'
import { ModelList, type UpstreamAnswer } from './ModelList.tsx'
import { RoleMap } from './RoleMap.tsx'
import styles from './Settings.module.css'

/** One channel's whole setup: its name, where and how it connects, and its models. */
export function ChannelEditor({
  name,
  onName,
  form,
  onChange,
  active,
  upstream,
  fetching,
  onFetch,
  onBack,
}: {
  name: string
  onName: (name: string) => void
  form: SettingsForm
  onChange: (next: Partial<SettingsForm>) => void
  /** In use: its edits are settings.json's, and saving writes them there. */
  active: boolean
  upstream: UpstreamAnswer | null
  fetching: boolean
  onFetch: () => void
  onBack: () => void
}): JSX.Element {
  const [showKey, setShowKey] = useState(false)
  const badUrl = formProblems(form).some((problem) => problem.startsWith('请求地址'))

  return (
    <>
      <button className={styles.backLink} onClick={onBack} type="button">
        <ArrowLeftIcon size={14} />
        全部渠道
      </button>
      <section className={styles.section}>
        <div className={dialog.sectionTitle}>{active ? '编辑渠道（使用中，保存后立即生效）' : '编辑渠道'}</div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ccw-channel-name">
            名称
          </label>
          <input
            id="ccw-channel-name"
            className={`${styles.input} ${name.trim() ? '' : styles.invalid}`}
            value={name}
            onChange={(event) => onName(event.target.value)}
            placeholder="例如 anyrouter"
            maxLength={100}
            spellCheck={false}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ccw-settings-url">
            请求地址
          </label>
          <input
            id="ccw-settings-url"
            className={`${styles.input} ${badUrl ? styles.invalid : ''}`}
            value={form.baseUrl}
            onChange={(event) => onChange({ baseUrl: event.target.value })}
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
            onChange={(event) => onChange({ authField: event.target.value as AuthField })}
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
              onChange={(event) => onChange({ key: event.target.value })}
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
      <ModelList form={form} onChange={onChange} upstream={upstream} fetching={fetching} onFetch={onFetch} />
      <RoleMap form={form} onChange={onChange} upstream={upstream?.models ?? []} />
    </>
  )
}
