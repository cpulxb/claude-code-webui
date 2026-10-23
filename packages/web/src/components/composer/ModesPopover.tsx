import { PERMISSION_MODES, type EffortLevel, type ModelInfo, type PermissionMode } from '@ccw/shared'

import { CheckIcon } from '../Icons.tsx'
import styles from './Composer.module.css'
import { EFFORT_LABEL, EffortSlider, effortChoices, nextEffort } from './EffortSlider.tsx'
import { EffortIcon, ModeIcon, UltracodeIcon } from './ModeIcon.tsx'

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
 * Permission mode, reasoning effort, and ultracode — the VS Code extension's
 * Modes menu. All are live control requests, so a change applies to the next
 * turn without restarting the CLI. The model moved to the composer's pill.
 */
export function ModesPopover(props: {
  mode: PermissionMode
  effort: EffortLevel
  model: string | null
  models: ModelInfo[]
  ultracode: boolean
  ultracodeAvailable: boolean
  rootRef?: React.Ref<HTMLDivElement>
  onMode: (mode: PermissionMode) => void
  onEffort: (effort: EffortLevel) => void
  onUltracode: (on: boolean) => void
}): JSX.Element {
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
              <ModeIcon mode={mode} size={18} />
            </span>
            <span className={styles.modeText}>
              <span className={`${styles.modeTitle} ${meta.danger ? styles.modeDanger : ''}`}>{meta.label}</span>
              <span className={styles.modeHint} style={{ display: 'block' }}>
                {meta.hint}
              </span>
            </span>
            {mode === props.mode && (
              <span className={styles.modeCheck}>
                <CheckIcon size={14} />
              </span>
            )}
          </button>
        )
      })}

      {(efforts.length > 0 || props.ultracodeAvailable) && <div className={styles.divider} />}

      {efforts.length > 0 && (
        <div
          className={styles.settingRow}
          role="button"
          tabIndex={-1}
          title="点击切换思考强度"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const next = nextEffort(efforts, props.effort)
            if (next) props.onEffort(next)
          }}
        >
          <span className={styles.settingLabel}>
            <EffortIcon size={18} />
            思考强度
            <span className={styles.settingValue}>（{EFFORT_LABEL[props.effort]}）</span>
          </span>
          <EffortSlider levels={efforts} value={props.effort} onChange={props.onEffort} />
        </div>
      )}

      {props.ultracodeAvailable && (
        <button
          type="button"
          role="switch"
          aria-checked={props.ultracode}
          className={styles.settingRow}
          title="每个任务都运行动态工作流（仅本会话）"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onUltracode(!props.ultracode)}
        >
          <span className={styles.settingLabel}>
            <UltracodeIcon size={18} />
            Ultracode
          </span>
          <span className={`${styles.switchTrack} ${props.ultracode ? styles.switchOn : ''}`}>
            <span className={styles.switchThumb} />
          </span>
        </button>
      )}
    </div>
  )
}
