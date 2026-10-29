import type { CliConfigRow } from '@ccw/shared'

export type ConfigGroup = 'session' | 'terminal' | 'other'

type Meta = {
  label: string
  group: Exclude<ConfigGroup, 'other'>
  /** Why the browser's sessions do not follow it, or what else it touches. */
  note?: string
  /** What an emptied text box saves: the CLI's word for "back to the default". */
  reset?: string
}

/**
 * The CLI's `/config` keys, named and sorted for the 配置 tab; the order here
 * is the order shown. A key the CLI adds later still shows, under its own
 * name, in 其他.
 */
const META: Record<string, Meta> = {
  model: { label: '默认模型', group: 'session', note: '新会话从这个模型开始，和设置页的「默认模型」是同一项' },
  language: { label: '回复语言', group: 'session', reset: 'default' },
  outputStyle: { label: '输出风格', group: 'session' },
  autoCompact: { label: '自动压缩', group: 'session' },
  thinking: { label: '思考模式', group: 'session', note: 'WebUI 会话启动时固定开启 adaptive 思考，这一项只影响终端' },
  checkpoints: { label: '代码回退（检查点）', group: 'session', note: 'WebUI 会话总是开启，这一项只影响终端' },
  permissionMode: { label: '默认权限模式', group: 'session', note: 'WebUI 新会话用输入框旁选的模式，这一项只影响终端' },
  useAutoModeDuringPlan: { label: '计划模式中使用 auto 模式', group: 'session' },
  switchModelsOnFlag: { label: '消息被标记时切换模型', group: 'session' },
  workflows: { label: '动态工作流', group: 'session' },
  workflowKeywordTriggerEnabled: { label: 'Ultracode 关键词触发', group: 'session' },
  workflowSizeGuideline: { label: '动态工作流规模', group: 'session' },
  worktreeBaseRef: { label: 'Worktree 基准', group: 'session' },

  theme: { label: '主题', group: 'terminal' },
  editor: { label: '编辑模式', group: 'terminal' },
  notifChannel: { label: '本地通知', group: 'terminal' },
  tips: { label: '显示提示', group: 'terminal' },
  promptSuggestionEnabled: { label: '输入建议', group: 'terminal' },
  recap: { label: '会话回顾', group: 'terminal' },
  verbose: { label: '详细输出', group: 'terminal' },
  turnDuration: { label: '显示回合耗时', group: 'terminal' },
  timeFormat: { label: '时间格式', group: 'terminal' },
  progressBar: { label: '终端进度条', group: 'terminal' },
  reduceMotion: { label: '减少动画', group: 'terminal' },
  autoScroll: { label: '自动滚动', group: 'terminal' },
  gitignore: { label: '文件选择器遵循 .gitignore', group: 'terminal' },
  copyFullResponse: { label: '跳过 /copy 选择器', group: 'terminal' },
  copyOnSelect: { label: '选中即复制', group: 'terminal' },
  defaultToAgentsView: { label: '默认打开 agents 视图', group: 'terminal' },
  leftArrowOpensAgents: { label: '← 打开 agents', group: 'terminal' },
  externalEditorContext: { label: '在外部编辑器显示最新回复', group: 'terminal' },
  prStatus: { label: '显示 PR 状态栏', group: 'terminal' },
  autoConnectIde: { label: '自动连接 IDE（外部终端）', group: 'terminal' },
}

const ORDER = Object.keys(META)

export const CONFIG_GROUPS: { id: ConfigGroup; title: string; note?: string }[] = [
  { id: 'session', title: '会话行为' },
  { id: 'terminal', title: '终端界面', note: 'WebUI 不用这些，它们只改终端里的 CLI' },
  { id: 'other', title: '其他' },
]

export function configMeta(key: string): Meta & { group: ConfigGroup } {
  return META[key] ?? { label: key, group: 'other' }
}

/** The rows of `group` whose name or key contains `query`: known keys in {@link META}'s order, then the rest A→Z. */
export function configRows(rows: CliConfigRow[], group: ConfigGroup, query: string): CliConfigRow[] {
  const needle = query.trim().toLowerCase()
  const rank = (key: string): number => (key in META ? ORDER.indexOf(key) : ORDER.length)
  return rows
    .filter((row) => configMeta(row.key).group === group)
    .filter((row) => !needle || `${configMeta(row.key).label} ${row.key}`.toLowerCase().includes(needle))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
}
