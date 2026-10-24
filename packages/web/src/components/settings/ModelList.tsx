import { useState } from 'react'

import { fullModelId, rowsFromRoles, shadowedModels, type PickerRow, type SettingsForm } from '../../utils/settings.ts'
import dialog from '../auth/Auth.module.css'
import { GripVerticalIcon, PlusIcon, XIcon } from '../Icons.tsx'
import styles from './Settings.module.css'

/** Ids this CLI knows, offered for behavesAs; any other can be typed. */
const KNOWN_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

const EMPTY_ROW: PickerRow = { model: '', oneM: false, label: '', description: '', behavesAs: '' }

/** The `modelPicker` rows, edited in place and dragged into menu order. */
export function ModelList({
  form,
  onChange,
}: {
  form: SettingsForm
  onChange: (next: Partial<SettingsForm>) => void
}): JSX.Element {
  /** A row just added, whose id field takes the focus as it mounts. */
  const [added, setAdded] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)

  const ids = form.models.map(fullModelId)
  const shadowed = shadowedModels(form)
  const imported = form.models.length === 0 ? rowsFromRoles(form) : []

  const editRow = (index: number, next: Partial<PickerRow>): void => {
    const old = form.models[index]!
    const row = { ...old, ...next }
    // The default follows its row through id and 1M edits.
    const wasDefault = form.defaultModel !== '' && fullModelId(old) === form.defaultModel
    onChange({
      models: form.models.map((entry, at) => (at === index ? row : entry)),
      ...(wasDefault ? { defaultModel: fullModelId(row) } : {}),
    })
  }

  const removeRow = (index: number): void =>
    onChange({
      models: form.models.filter((_, at) => at !== index),
      ...(ids[index] === form.defaultModel ? { defaultModel: '' } : {}),
    })

  const moveRow = (from: number, to: number): void => {
    if (from === to) return
    const models = [...form.models]
    models.splice(to, 0, ...models.splice(from, 1))
    onChange({ models })
  }

  const addRow = (): void => {
    setAdded(form.models.length)
    onChange({ models: [...form.models, EMPTY_ROW] })
  }

  const issue = (row: PickerRow, index: number): string | null => {
    if (!row.model.trim()) return row.label.trim() || row.description.trim() || row.behavesAs.trim() ? '缺少模型 ID' : null
    return ids.filter((id) => id === ids[index]).length > 1 ? '模型 ID 重复' : null
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={dialog.sectionTitle}>模型列表</span>
        {form.models.length > 0 && <span className={styles.count}>{form.models.length}</span>}
        <span className={dialog.spacer} />
        <label className={styles.check} title="勾选后菜单只有 Default 和这里的模型，Claude Code 内置的几行不再显示">
          <input
            type="checkbox"
            checked={form.replaceBuiltIn}
            onChange={(event) => onChange({ replaceBuiltIn: event.target.checked })}
          />
          只显示这些模型
        </label>
      </div>
      <div className={dialog.muted}>按顺序显示在输入框的模型菜单里，拖动左边的手柄调整顺序。选为「默认」的是新会话开始时用的模型。</div>

      {shadowed.length > 0 && (
        <div className={styles.hint}>
          {shadowed.length === 1 ? <code>{shadowed[0]}</code> : `${shadowed.length} 个模型`}
          和角色映射是同一个 ID，菜单里只会显示成角色那一行。
          <button className={styles.linkButton} onClick={() => onChange({ replaceBuiltIn: true })} type="button">
            只显示这些模型
          </button>
        </div>
      )}

      {form.models.length > 0 && form.defaultModel && !ids.includes(form.defaultModel) && (
        <div className={dialog.muted}>
          新会话现在默认用 <code className={styles.code}>{form.defaultModel}</code>，它不在列表里；在下面选一个就会替换它。
        </div>
      )}

      {form.models.length === 0 ? (
        <div className={styles.empty}>
          还没有自定义模型，菜单里只有 Claude Code 内置的几行。
          {imported.length > 0 && (
            <button
              className={styles.linkButton}
              // Rows with a role's id would hide behind that role's row otherwise.
              onClick={() => onChange({ models: imported, replaceBuiltIn: true })}
              type="button"
            >
              从角色映射导入 {imported.length} 个模型
            </button>
          )}
        </div>
      ) : (
        <div className={styles.grid}>
          <div className={styles.gridHead}>
            <span />
            <span>默认</span>
            <span>模型 ID</span>
            <span>显示名</span>
            <span>描述</span>
            <span className={styles.tip} title="声明支持 1M 上下文：保存时在 ID 后加上 [1m]">
              1M
            </span>
            <span className={styles.tip} title="Claude Code 不认识的模型，按哪个已知模型的能力处理（提示词、effort 默认值），不影响发出去的模型 ID">
              behavesAs
            </span>
            <span />
          </div>
          {form.models.map((row, index) => {
            const problem = issue(row, index)
            const target = drag && drag.over === index && drag.from !== index
            return (
              <div
                key={index}
                className={[
                  styles.row,
                  drag?.from === index ? styles.dragging : '',
                  target ? (drag.from < index ? styles.dropBelow : styles.dropAbove) : '',
                ].join(' ')}
                onDragOver={(event) => {
                  if (!drag) return
                  event.preventDefault()
                  if (drag.over !== index) setDrag({ ...drag, over: index })
                }}
                onDrop={(event) => {
                  // Also stops an input under the pointer from taking the drag as pasted text.
                  event.preventDefault()
                  if (drag) moveRow(drag.from, index)
                  setDrag(null)
                }}
              >
                <span
                  className={`${styles.grip} ${styles.cellGrip}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    // Firefox starts no drag without data.
                    event.dataTransfer.setData('text/plain', '')
                    const element = event.currentTarget.parentElement
                    if (element) event.dataTransfer.setDragImage(element, 12, 16)
                    setDrag({ from: index, over: index })
                  }}
                  onDragEnd={() => setDrag(null)}
                  title="拖动调整顺序"
                >
                  <GripVerticalIcon size={14} />
                </span>
                <input
                  className={styles.cellDefault}
                  type="radio"
                  name="ccw-settings-default"
                  checked={form.defaultModel !== '' && ids[index] === form.defaultModel}
                  onChange={() => onChange({ defaultModel: ids[index]! })}
                  disabled={!row.model.trim()}
                  title="新会话默认用这个模型"
                  aria-label="设为默认模型"
                />
                <input
                  className={`${styles.input} ${styles.cellId} ${problem ? styles.invalid : ''}`}
                  value={row.model}
                  onChange={(event) => editRow(index, { model: event.target.value })}
                  placeholder={problem ?? '模型 ID'}
                  aria-label="模型 ID"
                  title={problem ?? undefined}
                  autoFocus={index === added}
                  spellCheck={false}
                />
                <input
                  className={`${styles.input} ${styles.cellLabel}`}
                  value={row.label}
                  onChange={(event) => editRow(index, { label: event.target.value })}
                  // Unset, the menu shows the id: say so rather than "optional".
                  placeholder={row.model.trim() || '显示名（可选）'}
                  aria-label="显示名"
                />
                <input
                  className={`${styles.input} ${styles.cellDesc}`}
                  value={row.description}
                  onChange={(event) => editRow(index, { description: event.target.value })}
                  placeholder="描述（可选）"
                  aria-label="描述"
                />
                <label className={`${styles.check} ${styles.cellOneM}`} title="声明支持 1M 上下文：保存时在 ID 后加上 [1m]">
                  <input
                    type="checkbox"
                    checked={row.oneM}
                    onChange={(event) => editRow(index, { oneM: event.target.checked })}
                  />
                  <span className={styles.mobileOnly}>1M</span>
                </label>
                <input
                  className={`${styles.input} ${styles.cellAs}`}
                  list="ccw-known-models"
                  value={row.behavesAs}
                  onChange={(event) => editRow(index, { behavesAs: event.target.value })}
                  placeholder="behavesAs（可选）"
                  aria-label="behavesAs"
                  spellCheck={false}
                />
                <button
                  className={`${styles.iconButton} ${styles.remove} ${styles.cellDel}`}
                  onClick={() => removeRow(index)}
                  type="button"
                  title="删除"
                  aria-label="删除这个模型"
                >
                  <XIcon size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <datalist id="ccw-known-models">
        {KNOWN_MODELS.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <button className={styles.add} onClick={addRow} type="button">
        <PlusIcon size={14} />
        添加模型
      </button>
    </section>
  )
}
