import type { CliConfigOverride, CliConfigRow } from '@ccw/shared'
import { useEffect, useRef, useState } from 'react'

import { call } from '../../api/client.ts'
import { CONFIG_GROUPS, configMeta, configRows } from '../../utils/cli-config.ts'
import { RefreshIcon } from '../Icons.tsx'
import styles from './ConfigView.module.css'
import panel from './DetailsPanel.module.css'

const OVERRIDES: Record<CliConfigOverride['source'], string> = {
  project: '项目配置',
  local: '项目本地配置',
  flag: '启动参数',
  managed: '组织管理配置',
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * 配置: the terminal's `/config` panel. The rows and their options are the
 * CLI's own in this directory, and a change runs `/config key=value` in a
 * one-off CLI, so it lands in the file the terminal's would. Read again each
 * time the tab comes to the front: the terminal edits the same files.
 */
export function ConfigView({ cwd, active }: { cwd: string; active: boolean }): JSX.Element {
  /** As last read, with each confirmed write applied. */
  const [rows, setRows] = useState<CliConfigRow[] | null>(null)
  /** Keys with a write out, each shown meanwhile at the value it is being set to. */
  const [saving, setSaving] = useState<ReadonlyMap<string, CliConfigRow['value']>>(new Map())
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ error: boolean; text: string; title?: string } | null>(null)
  /** Counts reads and writes, so a read sent before a write cannot land after it. */
  const requests = useRef(0)

  const load = async (): Promise<void> => {
    const request = ++requests.current
    setLoading(true)
    try {
      const { rows } = await call('config.read', { cwd })
      if (request === requests.current) setRows(rows)
    } catch (cause) {
      if (request === requests.current) setStatus({ error: true, text: `读取设置失败：${describe(cause)}` })
    } finally {
      if (request === requests.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (active) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, active])

  const change = async (row: CliConfigRow, value: string): Promise<void> => {
    const { label, reset } = configMeta(row.key)
    const shown = row.kind === 'boolean' ? value === 'true' : value === reset ? null : value
    requests.current += 1
    setSaving((current) => new Map(current).set(row.key, shown))
    try {
      const { message } = await call('config.write', { cwd, key: row.key, value })
      setRows((current) => current?.map((entry) => (entry.key === row.key ? { ...entry, value: shown } : entry)) ?? null)
      setStatus({ error: false, text: `已保存「${label}」`, title: message })
    } catch (cause) {
      setStatus({ error: true, text: `${label}：${describe(cause)}` })
    } finally {
      setSaving((current) => {
        const next = new Map(current)
        next.delete(row.key)
        return next
      })
      // What the CLI saved can differ from what was picked, and a row can come or go with it.
      void load()
    }
  }

  const groups = rows
    ? CONFIG_GROUPS.map((group) => ({ ...group, rows: configRows(rows, group.id, filter) })).filter((group) => group.rows.length > 0)
    : []

  return (
    <div>
      <div className={styles.head}>
        <input
          className={styles.filter}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={rows ? `搜索 ${rows.length} 项设置…` : '搜索设置…'}
          spellCheck={false}
        />
        <button className={panel.iconButton} onClick={() => void load()} disabled={loading} type="button" title="重新读取">
          <RefreshIcon size={14} />
        </button>
      </div>
      <div className={panel.note}>
        修改后直接保存，写入的是终端 /config 使用的同一组文件，终端里的 CLI 也会跟着变。多数设置对新会话生效。
      </div>
      {status && (
        <div className={status.error ? styles.error : styles.saved} title={status.title} role="status">
          {status.text}
        </div>
      )}

      {rows === null ? (
        <div className={panel.empty}>{loading ? '读取中…' : '没有读到设置'}</div>
      ) : groups.length === 0 ? (
        <div className={panel.empty}>没有匹配的设置</div>
      ) : (
        groups.map((group) => (
          <div key={group.id} className={panel.section}>
            <div className={panel.sectionTitle}>{group.title}</div>
            {group.note && <div className={panel.note}>{group.note}</div>}
            {group.rows.map((row) => (
              <Row
                key={row.key}
                // `??` keeps a pending `false`; only a pending null reads as unset.
                row={saving.has(row.key) ? { ...row, value: saving.get(row.key) ?? null } : row}
                saving={saving.has(row.key)}
                onChange={(value) => void change(row, value)}
              />
            ))}
          </div>
        ))
      )}
    </div>
  )
}

function Row({ row, saving, onChange }: { row: CliConfigRow; saving: boolean; onChange: (value: string) => void }): JSX.Element {
  const meta = configMeta(row.key)
  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <span>{meta.label}</span>
        <span className={styles.key}>{row.key}</span>
        {row.overriddenBy && (
          <span className={styles.warn} title={row.overriddenBy.path}>
            {OVERRIDES[row.overriddenBy.source]}设置了这一项，在这里修改不会生效
          </span>
        )}
        {meta.note && <span className={styles.hint}>{meta.note}</span>}
        {row.target === 'local' && <span className={styles.hint}>保存在本项目的 .claude/settings.local.json</span>}
      </div>
      {row.kind === 'text' ? (
        <TextField row={row} reset={meta.reset} disabled={saving} onChange={onChange} />
      ) : (
        <Choice row={row} disabled={saving} onChange={onChange} />
      )}
    </div>
  )
}

function Choice({ row, disabled, onChange }: { row: CliConfigRow; disabled: boolean; onChange: (value: string) => void }): JSX.Element {
  const options: [string, string][] =
    row.kind === 'boolean' ? [['true', '开启'], ['false', '关闭']] : row.options.map((option) => [option, option])
  const current = row.value === null ? '' : String(row.value)
  return (
    <select
      className={`${panel.skillState} ${styles.control}`}
      value={current}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {current === '' && (
        <option value="" disabled>
          {row.target ? '默认' : '—'}
        </option>
      )}
      {/* A value set outside the list, such as a full model id: shown, not offered. */}
      {current !== '' && !options.some(([value]) => value === current) && (
        <option value={current} disabled>
          {current}
        </option>
      )}
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  )
}

/** Saved on Enter or on leaving the box; emptied, it saves `reset` where the key has one. */
function TextField({
  row,
  reset,
  disabled,
  onChange,
}: {
  row: CliConfigRow
  reset: string | undefined
  disabled: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const saved = typeof row.value === 'string' ? row.value : ''
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])

  const commit = (): void => {
    const next = draft.trim()
    if (next === saved) return
    if (next) onChange(next)
    else if (reset) onChange(reset)
    else setDraft(saved)
  }

  return (
    <input
      className={`${styles.input} ${styles.control}`}
      value={draft}
      disabled={disabled}
      placeholder="默认"
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        else if (event.key === 'Escape') setDraft(saved)
      }}
    />
  )
}
