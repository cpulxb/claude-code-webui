import type { ChannelDraft } from '../../utils/channels.ts'
import type { SettingsForm } from '../../utils/settings.ts'
import dialog from '../auth/Auth.module.css'
import { CopyIcon, PencilIcon, PlusIcon, TrashIcon } from '../Icons.tsx'
import styles from './Settings.module.css'

/**
 * The saved channels as cards, each with a switch: turning one on switches
 * settings.json to it at once. Only one is on; the one on cannot be deleted.
 */
export function ChannelList({
  drafts,
  activeId,
  activeForm,
  locked,
  onActivate,
  onEdit,
  onDuplicate,
  onDelete,
  onAdd,
}: {
  drafts: ChannelDraft[]
  activeId: string
  /** The active channel as the page's form has it, edits included. */
  activeForm: SettingsForm
  /** Why the switches are held, or null when a switch may happen. */
  locked: string | null
  onActivate: (id: string) => void
  onEdit: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onAdd: () => void
}): JSX.Element {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={dialog.sectionTitle}>渠道</div>
        <button className={`${styles.action} ${styles.pushRight}`} onClick={onAdd} type="button">
          <PlusIcon size={13} />
          添加渠道
        </button>
      </div>
      <div className={dialog.muted}>
        打开哪个渠道的开关，就切换到哪个：它的请求地址、Key、模型列表和角色映射会写进 settings.json，会话空闲时自动切过去。
      </div>
      <div className={styles.channels}>
        {drafts.map(({ id, name, form: saved }) => {
          const active = id === activeId
          const form = active ? activeForm : saved
          const label = name.trim() || '未命名渠道'
          const models = form.models.filter((row) => row.model.trim()).length
          return (
            <div key={id} className={active ? `${styles.channel} ${styles.channelActive}` : styles.channel}>
              <span className={styles.channelAvatar} aria-hidden="true">
                {label.slice(0, 1).toUpperCase()}
              </span>
              <div className={styles.channelMain}>
                <div className={styles.channelName}>
                  <span className={styles.channelTitle}>{label}</span>
                  {active && <span className={styles.channelBadge}>使用中</span>}
                </div>
                <div className={styles.channelMeta}>
                  <span className={styles.channelUrl}>{form.baseUrl.trim() || '官方地址'}</span>
                  <span>{models > 0 ? `${models} 个模型` : '没有自定义模型'}</span>
                  {form.defaultModel && <span className={styles.channelUrl}>默认 {form.defaultModel}</span>}
                </div>
              </div>
              <div className={styles.channelActions}>
                <button className={styles.iconButton} onClick={() => onEdit(id)} type="button" title="编辑" aria-label={`编辑 ${label}`}>
                  <PencilIcon size={14} />
                </button>
                <button className={styles.iconButton} onClick={() => onDuplicate(id)} type="button" title="复制" aria-label={`复制 ${label}`}>
                  <CopyIcon size={14} />
                </button>
                <button
                  className={styles.iconButton}
                  onClick={() => onDelete(id)}
                  disabled={active}
                  type="button"
                  title={active ? '正在使用的渠道不能删除，先切换到别的渠道' : '删除'}
                  aria-label={`删除 ${label}`}
                >
                  <TrashIcon size={14} />
                </button>
                <button
                  className={styles.switch}
                  role="switch"
                  aria-checked={active}
                  aria-label={`切换到 ${label}`}
                  onClick={() => onActivate(id)}
                  disabled={active || locked !== null}
                  type="button"
                  title={active ? '正在使用' : (locked ?? `切换到 ${label}`)}
                >
                  <span className={styles.knob} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
