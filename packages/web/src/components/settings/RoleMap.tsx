import type { UpstreamModel } from '@ccw/shared'
import { useState } from 'react'

import { fullModelId, type SettingsForm } from '../../utils/settings.ts'
import dialog from '../auth/Auth.module.css'
import { ChevronRightIcon } from '../Icons.tsx'
import styles from './Settings.module.css'

const ROLE_LABELS: Record<string, string> = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'Opus',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'Sonnet',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Haiku',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'Fable',
  CLAUDE_CODE_SUBAGENT_MODEL: '子 agent',
  ANTHROPIC_SMALL_FAST_MODEL: 'Small fast（旧）',
}

/** The aliases the CLI still calls models by, each mapped to a model the channel knows; folded away until opened. */
export function RoleMap({
  form,
  onChange,
  upstream,
}: {
  form: SettingsForm
  onChange: (next: Partial<SettingsForm>) => void
  /** The channel's fetched models, offered beside the picker rows. */
  upstream: UpstreamModel[]
}): JSX.Element {
  const [open, setOpen] = useState(false)

  const pickerIds = form.models.filter((row) => row.model.trim()).map((row) => ({ id: fullModelId(row), label: row.label }))
  const known = new Set(pickerIds.map(({ id }) => id))
  const choices = [
    ...pickerIds,
    ...upstream.filter(({ id }) => !known.has(id)).map(({ id, owner }) => ({ id, label: owner ?? '' })),
  ]
  const set = Object.values(form.roles).filter((value) => value.trim()).length

  return (
    <section className={styles.section}>
      <button className={styles.disclosure} onClick={() => setOpen(!open)} type="button" aria-expanded={open}>
        <span className={open ? styles.chevronOpen : styles.chevron}>
          <ChevronRightIcon size={14} />
        </span>
        角色映射
        {set > 0 && <span className={styles.count}>{set}</span>}
      </button>
      {open && (
        <>
          <div className={dialog.muted}>
            Claude Code 内部仍按 opus、sonnet、haiku 这些别名调用模型，比如后台的小任务和子 agent。接第三方网关时，要把它们映射到网关认识的模型。
          </div>
          <button
            className={styles.add}
            onClick={() => onChange({ roles: Object.fromEntries(Object.keys(form.roles).map((key) => [key, form.defaultModel])) })}
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
                  onChange={(event) => onChange({ roles: { ...form.roles, [key]: event.target.value } })}
                  placeholder={key}
                  spellCheck={false}
                />
              </div>
            ))}
          </div>
          <datalist id="ccw-picker-models">
            {choices.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </datalist>
        </>
      )}
    </section>
  )
}
