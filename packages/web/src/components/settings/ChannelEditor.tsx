import { API_FORMATS, type ApiFormat, type ChannelRoute } from '@ccw/shared'
import { useState } from 'react'

import { FORMAT_LABELS } from '../../utils/channels.ts'
import { formProblems, type AuthField, type SettingsForm } from '../../utils/settings.ts'
import dialog from '../auth/Auth.module.css'
import { ArrowLeftIcon, EyeIcon, EyeOffIcon } from '../Icons.tsx'
import { ModelList, type UpstreamAnswer } from './ModelList.tsx'
import { RoleMap } from './RoleMap.tsx'
import styles from './Settings.module.css'

const URL_EXAMPLES: Record<ApiFormat, string> = {
  anthropic: '留空使用官方地址，例如 https://api.example.com',
  'openai-chat': '例如 https://api.openai.com/v1',
  'openai-responses': '例如 https://api.openai.com/v1',
  gemini: '例如 https://generativelanguage.googleapis.com',
}

/**
 * One channel's whole setup: its name, the API its upstream speaks, where
 * and how it connects, and its models. A routed channel's address and key are
 * its route's, the upstream's own.
 */
export function ChannelEditor({
  name,
  onName,
  form,
  onChange,
  route,
  routeUrl,
  routable,
  onRoute,
  onFormat,
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
  /** Where a routed channel's requests really go; null for an Anthropic one. */
  route: ChannelRoute | null
  /** The address settings.json gives the CLI for this routed channel. */
  routeUrl: string | null
  /** Whether this server can route at all. */
  routable: boolean
  onRoute: (next: Partial<ChannelRoute>) => void
  onFormat: (format: ApiFormat) => void
  /** In use: its edits are settings.json's, and saving writes them there. */
  active: boolean
  upstream: UpstreamAnswer | null
  fetching: boolean
  onFetch: () => void
  onBack: () => void
}): JSX.Element {
  const [showKey, setShowKey] = useState(false)
  const format = route?.format ?? 'anthropic'
  const badUrl = route ? !/^https?:\/\/\S+$/i.test(route.baseUrl.trim()) : formProblems(form).some((problem) => problem.startsWith('请求地址'))

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
          <label className={styles.label} htmlFor="ccw-channel-format">
            API 格式
          </label>
          <select
            id="ccw-channel-format"
            className={styles.input}
            value={format}
            onChange={(event) => onFormat(event.target.value as ApiFormat)}
          >
            {API_FORMATS.map((option) => (
              <option key={option} value={option} disabled={option !== 'anthropic' && !routable && option !== format}>
                {FORMAT_LABELS[option]}
                {option === 'anthropic' ? '' : routable ? '（经 WebUI 转换）' : '（不可用：WebUI 直接以 HTTPS 提供服务）'}
              </option>
            ))}
          </select>
        </div>
        {route && (
          <div className={styles.hint}>
            Claude Code 只会发 Anthropic Messages 请求。这个渠道在 settings.json 里的请求地址是本机 WebUI 服务的路由
            {routeUrl && (
              <>
                （<code>{routeUrl}</code>）
              </>
            )}
            ，由它把请求转换成 {FORMAT_LABELS[route.format]} 发给下面的上游，再把回答转换回来。终端里的 claude
            也走这条路，WebUI 服务要一直开着；终端设了 HTTP(S)_PROXY 的话，NO_PROXY 里要有 127.0.0.1。模型 ID
            要填上游认得的名字，并在下面设好默认模型和角色映射。
          </div>
        )}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ccw-settings-url">
            请求地址
          </label>
          <input
            id="ccw-settings-url"
            className={`${styles.input} ${badUrl ? styles.invalid : ''}`}
            value={route ? route.baseUrl : form.baseUrl}
            onChange={(event) => (route ? onRoute({ baseUrl: event.target.value }) : onChange({ baseUrl: event.target.value }))}
            placeholder={URL_EXAMPLES[format]}
            spellCheck={false}
          />
        </div>
        {!route && (
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
        )}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="ccw-settings-key">
            Key
          </label>
          <div className={styles.secret}>
            <input
              id="ccw-settings-key"
              className={styles.input}
              type={showKey ? 'text' : 'password'}
              value={route ? route.key : form.key}
              onChange={(event) => (route ? onRoute({ key: event.target.value }) : onChange({ key: event.target.value }))}
              placeholder={route ? (route.format === 'gemini' ? '上游的 API Key（x-goog-api-key）' : '上游的 API Key（Authorization: Bearer）') : '留空使用 CLI 自己的登录'}
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
      <ModelList
        form={form}
        onChange={onChange}
        upstream={upstream}
        fetching={fetching}
        onFetch={onFetch}
        address={route ? route.baseUrl : form.baseUrl}
      />
      <RoleMap form={form} onChange={onChange} upstream={upstream?.models ?? []} />
    </>
  )
}
