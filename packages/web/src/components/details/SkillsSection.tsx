import type { SkillInfo, SkillState } from '@ccw/shared'
import { useEffect, useState } from 'react'

import { call } from '../../api/client.ts'
import { useActiveSessionValue } from '../../store/session.ts'
import styles from './DetailsPanel.module.css'

/** In the order the terminal cycles through them. */
const STATES: { value: SkillState; label: string; hint: string }[] = [
  { value: 'on', label: '开启', hint: '模型能看到名称和描述，会自动调用' },
  { value: 'name-only', label: '仅名称', hint: '只向模型列出名称，省上下文' },
  { value: 'user-invocable-only', label: '仅手动', hint: '模型看不到，只能用 /名称 调用' },
  { value: 'off', label: '关闭', hint: '模型和 / 命令都用不了' },
]

const LOCKED: Record<NonNullable<SkillInfo['locked_by']>, string> = {
  plugin: '随插件启用或禁用',
  author: 'skill 文件自己关掉了模型调用',
  policy: '由托管策略设定',
  flag: '由启动参数设定',
  'reserved-name': '这个名字写不进设置，改名后才能配置',
}

/**
 * `/skills`: the terminal menu's rows, each with its state. A plugin's skills
 * follow the plugin, so they are listed but locked. Refetched whenever the
 * session's command list changes: the CLI pushes a new one after any skill
 * or plugin edit, the terminal's included.
 */
export function SkillsSection({ sessionId, attached }: { sessionId: string; attached: boolean }): JSX.Element {
  const commands = useActiveSessionValue((session) => session.commands)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!attached) return
    let stale = false
    call('session.skills', { sessionId })
      .then(({ skills }) => {
        if (stale) return
        setSkills(skills)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (!stale) setError(`读取 skills 失败：${message(reason)}`)
      })
    return () => {
      stale = true
    }
  }, [sessionId, attached, commands])

  const change = async (name: string, state: SkillState): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSkills((await call('session.setSkillState', { sessionId, name, state })).skills)
    } catch (reason) {
      setError(`修改 ${name} 失败：${message(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  // Name matches first; a description match still finds a skill by what it
  // does, but a short query hits most descriptions, so those come after.
  const needle = filter.trim().toLowerCase()
  const named = (skill: SkillInfo): boolean => `${skill.display_name} ${skill.name}`.toLowerCase().includes(needle)
  const shown = needle
    ? [
        ...(skills ?? []).filter(named),
        ...(skills ?? []).filter((skill) => !named(skill) && skill.description.toLowerCase().includes(needle)),
      ]
    : (skills ?? [])

  return (
    <div className={styles.section} id="ccw-info-skills">
      <div className={styles.sectionTitle}>Skills</div>
      {!attached || skills === null ? (
        <div className={styles.empty}>{attached ? '读取中…' : '会话启动后显示'}</div>
      ) : skills.length === 0 ? (
        <div className={styles.empty}>没有可用的 skill</div>
      ) : (
        <>
          <div className={styles.note}>修改保存在本项目的 .claude/settings.local.json</div>
          <input
            className={styles.filter}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`搜索 ${skills.length} 个 skill…`}
            spellCheck={false}
          />
          {shown.map((skill) => (
            <div key={`${skill.source}/${skill.name}`} className={styles.mcpRow} title={skill.description}>
              <span className={`${styles.mcpName} ${skill.state === 'off' ? styles.skillOff : ''}`}>
                {skill.display_name}
              </span>
              <span className={styles.mcpMeta}>
                {skill.source} · ~{skill.tokens} tokens
              </span>
              {skill.locked_by ? (
                <span className={styles.skillLocked} title={LOCKED[skill.locked_by]}>
                  {STATES.find((entry) => entry.value === skill.state)?.label}
                </span>
              ) : (
                <select
                  className={styles.skillState}
                  value={skill.state}
                  disabled={busy}
                  onChange={(event) => void change(skill.name, event.target.value as SkillState)}
                  title={STATES.find((entry) => entry.value === skill.state)?.hint}
                >
                  {STATES.map((entry) => (
                    <option key={entry.value} value={entry.value} title={entry.hint}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </>
      )}
      {error && <div className={styles.mcpError}>{error}</div>}
    </div>
  )
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
