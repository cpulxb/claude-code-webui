import { PERMISSION_MODES, type EffortLevel, type ModelInfo, type PermissionMode } from '@ccw/shared'

import styles from './Composer.module.css'
import { EFFORT_LABEL, EffortSlider, effortChoices } from './EffortSlider.tsx'
import { ModeIcon } from './ModeIcon.tsx'
import { findModel, modelLabel } from './ModelPicker.tsx'

type ModeMeta = { label: string; hint: string; danger?: boolean }

/** Mirrors the terminal's Modes popover, including the order it lists them in. */
export const MODE_META: Record<PermissionMode, ModeMeta> = {
  default: { label: '手动', hint: 'Claude 每次编辑前都会请求批准' },
  acceptEdits: { label: '自动编辑', hint: 'Claude 会直接编辑文件，其余操作仍需批准' },
  plan: { label: '规划', hint: 'Claude 只探索代码并给出方案，不做任何修改' },
  auto: { label: '自动', hint: '通过安全检查的操作自动批准，有风险的仍会暂停询问' },
  bypassPermissions: { label: '跳过权限', hint: '执行任何操作前都不再询问', danger: true },
  dontAsk: { label: '不询问', hint: '从不弹窗；未预先授权的操作直接拒绝' },
}

/**
 * Permission mode, reasoning effort, and model. All three are live control
 * requests, so a change applies to the next turn without restarting the CLI.
 */
export function ModesPopover(props: {
  mode: PermissionMode
  effort: EffortLevel
  model: string | null
  models: ModelInfo[]
  rootRef?: React.Ref<HTMLDivElement>
  onMode: (mode: PermissionMode) => void
  onEffort: (effort: EffortLevel) => void
  onModel: (model: string) => void
}): JSX.Element {
  const selected = findModel(props.models, props.model)
  const efforts = effortChoices(props.models, props.model)

  return (
    <div ref={props.rootRef} className={`${styles.popover} ${styles.modesPopover}`} role="menu">
      <div className={styles.sectionTitle}>模式</div>
      {PERMISSION_MODES.map((mode) => {
        const meta = MODE_META[mode]
        return (
          <button
            key={mode}
            className={`${styles.modeRow} ${mode === props.mode ? styles.modeRowActive : ''}`}
            onClick={() => props.onMode(mode)}
            type="button"
            role="menuitemradio"
            aria-checked={mode === props.mode}
          >
            <span className={`${styles.modeIcon} ${meta.danger ? styles.modeDanger : ''}`}>
              <ModeIcon mode={mode} size={17} />
            </span>
            <span className={styles.modeText}>
              <span className={`${styles.modeTitle} ${meta.danger ? styles.modeDanger : ''}`}>{meta.label}</span>
              <span className={styles.modeHint} style={{ display: 'block' }}>
                {meta.hint}
              </span>
            </span>
            {mode === props.mode && <span className={styles.modeCheck}>✓</span>}
          </button>
        )
      })}

      {efforts.length > 0 && (
        <>
          <div className={styles.divider} />
          <div className={styles.effortRow}>
            <span className={styles.effortLabel}>思考强度（{EFFORT_LABEL[props.effort]}）</span>
            <EffortSlider levels={efforts} value={props.effort} onChange={props.onEffort} />
          </div>
        </>
      )}

      {props.models.length > 0 && (
        <>
          <div className={styles.divider} />
          <div className={styles.sectionTitle}>模型</div>
          <select
            className={styles.select}
            value={selected?.value ?? props.model ?? ''}
            onChange={(event) => props.onModel(event.target.value)}
          >
            {props.models.map((model) => (
              <option key={model.value} value={model.value}>
                {modelLabel(model, props.models)}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  )
}
