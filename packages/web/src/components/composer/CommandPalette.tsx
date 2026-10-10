import { fuzzyFilter, type EffortLevel, type ModelInfo, type SlashCommand } from '@ccw/shared'
import { Fragment, useEffect, useRef } from 'react'

import { findModel } from '../../utils/models.ts'
import { DumbbellIcon } from '../Icons.tsx'
import styles from './Composer.module.css'
import { EFFORT_LABEL, EffortSlider } from './EffortSlider.tsx'

export type PaletteAction = 'attach' | 'mention' | 'switch-model'

/** One selectable row of the `/` palette: a built-in action or a slash command. */
export type PaletteEntry =
  | { kind: 'action'; key: string; group: string; action: PaletteAction; label: string; hint?: string }
  | { kind: 'command'; key: string; group: string; command: SlashCommand }

const GROUP_CONTEXT = '上下文'
const GROUP_MODEL = '模型'
const GROUP_COMMANDS = '斜杠命令'

type Searchable = { search: string; entry: PaletteEntry }

/**
 * The palette's rows for a given query.
 *
 * Empty query keeps VS Code's grouped browse order (context → model →
 * commands); a query ranks every row in one fuzzy-scored list instead, so
 * Enter lands on the best match rather than on whatever group comes first
 * (`/mo` must pick `/model`, not the context row that also happens to match).
 * Action rows carry English keywords because the `/` trigger only accepts
 * `\w` characters — the labels themselves are never typeable.
 */
export function buildPaletteEntries(
  query: string,
  commands: SlashCommand[],
  models: ModelInfo[],
  currentModel: string | null,
): PaletteEntry[] {
  const active = findModel(models, currentModel)
  const modelHint = active?.displayName ?? currentModel ?? undefined

  const rows: Searchable[] = [
    {
      search: 'attach file upload image 附加文件',
      entry: { kind: 'action', key: 'action:attach', group: GROUP_CONTEXT, action: 'attach', label: '附加文件…' },
    },
    {
      search: 'mention file from this project 引用文件',
      entry: { kind: 'action', key: 'action:mention', group: GROUP_CONTEXT, action: 'mention', label: '引用项目文件…' },
    },
    ...(models.length > 0
      ? [
          {
            search: 'switch model 切换模型',
            entry: {
              kind: 'action',
              key: 'action:switch-model',
              group: GROUP_MODEL,
              action: 'switch-model',
              label: '切换模型…',
              ...(modelHint ? { hint: modelHint } : {}),
            },
          } satisfies Searchable,
        ]
      : []),
    ...commands.map(
      (command): Searchable => ({
        search: command.name,
        entry: { kind: 'command', key: `command:${command.name}`, group: GROUP_COMMANDS, command },
      }),
    ),
  ]

  const ranked = query === '' ? rows : fuzzyFilter(query, rows, (row) => row.search)
  return ranked.map((row) => row.entry)
}

/**
 * The `/` menu, VS Code style: grouped rows with hairline dividers while
 * browsing, a flat ranked list while filtering, and the effort slider pinned
 * as a footer below the scroll area.
 */
export function CommandPalette(props: {
  entries: PaletteEntry[]
  /** True while the query is empty — renders group headers and dividers. */
  grouped: boolean
  activeIndex: number
  emptyText: string
  /** Extra muted line under the list, e.g. the read-only replay note. */
  note?: string
  efforts: readonly EffortLevel[]
  effort: EffortLevel
  onEffort: (level: EffortLevel) => void
  onSelect: (entry: PaletteEntry) => void
  onHover: (index: number) => void
}): JSX.Element {
  const activeRef = useRef<HTMLButtonElement>(null)

  // Keyboard navigation must drag the viewport with it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [props.activeIndex])

  return (
    <div className={`${styles.popover} ${styles.palette}`}>
      <div className={styles.paletteList} role="listbox">
        {props.entries.map((entry, index) => {
          const previous = props.entries[index - 1]
          const heading = props.grouped && (!previous || previous.group !== entry.group)
          return (
            <Fragment key={entry.key}>
              {heading && index > 0 && <div className={styles.divider} />}
              {heading && <div className={styles.menuGroup}>{entry.group}</div>}
              <button
                ref={index === props.activeIndex ? activeRef : null}
                className={`${styles.menuItem} ${index === props.activeIndex ? styles.menuItemActive : ''}`}
                // Mousedown, not click: click fires after blur, which would
                // close the menu before the selection is read.
                onMouseDown={(event) => {
                  event.preventDefault()
                  props.onSelect(entry)
                }}
                onMouseEnter={() => props.onHover(index)}
                type="button"
                role="option"
                aria-selected={index === props.activeIndex}
              >
                {entry.kind === 'action' ? (
                  <>
                    <span className={styles.menuName}>{entry.label}</span>
                    {entry.hint && <span className={styles.paletteRight}>{entry.hint}</span>}
                  </>
                ) : (
                  <>
                    <span className={styles.menuName}>/{entry.command.name}</span>
                    {entry.command.argumentHint && <span className={styles.menuHint}>{entry.command.argumentHint}</span>}
                    {entry.command.description && <span className={styles.menuDesc}>{entry.command.description}</span>}
                  </>
                )}
              </button>
            </Fragment>
          )
        })}
        {props.entries.length === 0 && <div className={styles.menuEmpty}>{props.emptyText}</div>}
        {props.note && <div className={styles.menuEmpty}>{props.note}</div>}
      </div>
      {props.efforts.length > 0 && (
        <div className={styles.paletteFooter}>
          <span className={styles.footerIcon}>
            <DumbbellIcon size={14} />
          </span>
          <span>思考强度（{EFFORT_LABEL[props.effort]}）</span>
          <EffortSlider levels={props.efforts} value={props.effort} onChange={props.onEffort} />
        </div>
      )}
    </div>
  )
}
