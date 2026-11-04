import type { SessionStatus, UsageReport } from '@ccw/shared'
import { useCallback, useEffect, useState } from 'react'

import { useActiveSessionValue, useStore } from '../../store/session.ts'
import styles from './DetailsPanel.module.css'

type Limits = NonNullable<UsageReport['rate_limits']>
type QuotaWindow = { utilization: number | null; resets_at: string | null }
type Breakdown = NonNullable<UsageReport['behaviors']>['day']

/** The plan's windows in the terminal's order; `model_scoped` rows follow the weekly one. */
const WINDOWS: { key: Exclude<keyof Limits, 'model_scoped' | 'extra_usage'>; label: string }[] = [
  { key: 'five_hour', label: '当前 5 小时' },
  { key: 'seven_day', label: '本周（全部模型）' },
  { key: 'seven_day_opus', label: '本周（Opus）' },
  { key: 'seven_day_sonnet', label: '本周（Sonnet）' },
  { key: 'seven_day_oauth_apps', label: '本周（OAuth 应用）' },
]

/** For a scan that names behaviors without wording a recommendation for them. */
const BEHAVIORS: Record<Breakdown['behaviors'][number]['key'], string> = {
  cache_miss: '缓存未命中',
  long_context: '长上下文',
  subagent_heavy: '大量子代理',
  high_parallel: '高并发请求',
  cron: '定时任务',
  max_effort: '最高推理强度',
  workflow: '工作流',
  always_on_context: '常驻上下文',
  large_tool_results: '大段工具结果',
}

/**
 * `/usage`: the session's cost and tokens, the plan's quota windows, and —
 * once scanned — what in the last day or week of local sessions used them.
 * The totals move only when a turn ends, so they are re-read then; the scan
 * reads a week of transcripts, so it waits for `/usage` or the button. While
 * it runs the CLI answers no other control request (seconds, on CLI 2.1.316),
 * so it goes out after this section's quick read: by then the reads the rest
 * of the panel made on opening are ahead of it.
 */
export function UsageSection({
  sessionId,
  attached,
  status,
}: {
  sessionId: string
  attached: boolean
  status: SessionStatus
}): JSX.Element {
  const usage = useActiveSessionValue((session) => session.usage)
  const loadUsage = useStore((state) => state.loadUsage)
  const [range, setRange] = useState<'day' | 'week'>('day')
  const report = usage?.report ?? null

  useEffect(() => {
    // Mid-turn the last reading stands until the turn's end brings a fresh one.
    if (!attached || (status === 'running' && report)) return
    void loadUsage(sessionId, false)
    // `report` only gates the first read; a new one must not trigger another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attached, status, loadUsage])

  const scan = useCallback(
    () => void loadUsage(sessionId, false).then(() => loadUsage(sessionId, true)),
    [sessionId, loadUsage],
  )

  const queued = usage?.scanQueued === true
  useEffect(() => {
    if (attached && queued) scan()
  }, [attached, queued, scan])

  return (
    <div className={styles.section} id="ccw-info-usage">
      <div className={styles.sectionTitle}>用量</div>
      {!attached || !report ? (
        <div className={styles.empty}>
          {!attached ? '会话启动后显示' : usage?.error ? `读取用量失败：${usage.error}` : '读取中…'}
        </div>
      ) : (
        <>
          <SessionTotals session={report.session} />
          <PlanQuota report={report} />
          {/* The scan answers null for anyone but a claude.ai subscriber, as the terminal's dialog does. */}
          {report.subscription_type !== null && (
            <>
              <div className={styles.usageHead}>
                <span className={styles.usageSub}>用量来源</span>
                {report.behaviors && (
                  <>
                    <button
                      className={`${styles.toggle} ${range === 'day' ? styles.rangeActive : ''}`}
                      onClick={() => setRange('day')}
                      type="button"
                    >
                      近 24 小时
                    </button>
                    <button
                      className={`${styles.toggle} ${range === 'week' ? styles.rangeActive : ''}`}
                      onClick={() => setRange('week')}
                      type="button"
                    >
                      近 7 天
                    </button>
                  </>
                )}
                <span className={styles.spacer} />
                <button className={styles.toggle} disabled={usage?.scanning} onClick={scan} type="button">
                  {usage?.scanning ? '分析中…' : report.behaviors ? '重新分析' : '分析'}
                </button>
              </div>
              {report.behaviors ? (
                <Contributors breakdown={report.behaviors[range]} />
              ) : (
                <div className={styles.note}>扫描本机近 7 天的会话记录，找出用掉额度的习惯、skill 和 MCP 服务器</div>
              )}
            </>
          )}
          {usage?.error && <div className={styles.mcpError}>刷新失败：{usage.error}</div>}
        </>
      )}
    </div>
  )
}

function SessionTotals({ session }: { session: UsageReport['session'] }): JSX.Element {
  const models = Object.entries(session.model_usage)
  return (
    <>
      <Field label="费用" value={cost(session.total_cost_usd)} title="按 API 标价估算，不是账单" />
      <Field label="API 耗时" value={elapsed(session.total_api_duration_ms)} />
      <Field label="总耗时" value={elapsed(session.total_duration_ms)} />
      <Field label="代码改动" value={`新增 ${session.total_lines_added} 行，删除 ${session.total_lines_removed} 行`} />
      {models.map(([model, usage]) => (
        <div key={model} className={styles.usageModel}>
          <span className={styles.mono}>{model}</span>
          <span className={styles.usageMeta}>
            {tokens(usage.inputTokens)} 输入 · {tokens(usage.outputTokens)} 输出 · {tokens(usage.cacheReadInputTokens)} 缓存读 ·{' '}
            {tokens(usage.cacheCreationInputTokens)} 缓存写 · {cost(usage.costUSD)}
          </span>
        </div>
      ))}
    </>
  )
}

function PlanQuota({ report }: { report: UsageReport }): JSX.Element {
  const limits = report.rate_limits
  // 'pro', 'max', … as the terminal's "Claude Pro" reads them.
  const type = report.subscription_type
  const plan = type ? `（${type.charAt(0).toUpperCase()}${type.slice(1)}）` : ''
  const windows: { label: string; window: QuotaWindow }[] = []
  if (limits) {
    for (const { key, label } of WINDOWS) {
      const window = limits[key]
      if (window && window.utilization !== null) windows.push({ label, window })
    }
    for (const row of limits.model_scoped ?? []) {
      if (row.utilization !== null) windows.push({ label: `本周（${row.display_name}）`, window: row })
    }
    const extra = limits.extra_usage
    if (extra?.is_enabled && extra.utilization !== null) {
      windows.push({ label: '额外用量（本月）', window: { utilization: extra.utilization, resets_at: null } })
    }
  }

  return (
    <>
      <div className={styles.usageHead}>
        <span className={styles.usageSub}>套餐额度{plan}</span>
      </div>
      {!report.rate_limits_available ? (
        <div className={styles.note}>当前账号没有套餐额度（API key、Bedrock、Vertex 或第三方网关按用量计费）</div>
      ) : windows.length === 0 ? (
        // The claude.ai usage endpoint often does not answer; the CLI then
        // falls back on the rate-limit headers of its own API calls.
        <div className={styles.note}>暂时读不到额度，本会话的下一轮对话结束后再读</div>
      ) : (
        windows.map(({ label, window }) => <QuotaBar key={label} label={label} window={window} />)
      )}
    </>
  )
}

function QuotaBar({ label, window }: { label: string; window: QuotaWindow }): JSX.Element {
  const percent = Math.min(100, Math.max(0, Math.round(window.utilization ?? 0)))
  return (
    <div className={styles.quota}>
      <div className={styles.quotaHead}>
        <span>{label}</span>
        <span className={styles.usagePct}>已用 {percent}%</span>
      </div>
      <div className={styles.quotaTrack}>
        <div className={styles.quotaFill} data-high={percent >= 80 || undefined} style={{ width: `${percent}%` }} />
      </div>
      {window.resets_at && <div className={styles.note}>{resetTime(window.resets_at)} 重置</div>}
    </div>
  )
}

function Contributors({ breakdown }: { breakdown: Breakdown }): JSX.Element {
  const rows = breakdown.recommendations?.map((entry) => ({
    key: entry.key + entry.title,
    pct: entry.pct,
    text: entry.detail ? `${entry.title} · ${entry.detail}` : entry.title,
  })) ?? breakdown.behaviors.map((entry) => ({ key: entry.key, pct: entry.pct, text: BEHAVIORS[entry.key] ?? entry.key }))
  const sources = [
    { title: 'Skills', items: breakdown.skills.map((item) => ({ ...item, name: `/${item.name}` })) },
    { title: '子代理', items: breakdown.agents },
    { title: '插件', items: breakdown.plugins },
    { title: 'MCP 服务器', items: breakdown.mcp_servers },
  ].filter((source) => source.items.length > 0)

  return (
    <>
      <div className={styles.note}>
        近似值 · 仅本机会话 · 各项互有重叠，合计不是 100% · {breakdown.request_count} 次请求 · {breakdown.session_count} 个会话
      </div>
      {rows.length === 0 && sources.length === 0 && <div className={styles.empty}>没有值得一提的用量来源</div>}
      {rows.map((row) => (
        <div key={row.key} className={styles.catRow}>
          <span className={styles.usagePct}>{row.pct}%</span>
          <span className={styles.usageText}>{row.text}</span>
        </div>
      ))}
      {sources.map((source) => (
        <div key={source.title} className={styles.usageGroup}>
          <div className={styles.usageMeta}>{source.title} · 占用量</div>
          {source.items.map((item) => (
            <div key={item.name} className={styles.catRow}>
              <span className={styles.catName}>{item.name}</span>
              <span className={styles.catTokens}>{item.pct}%</span>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

function Field({ label, value, title }: { label: string; value: string; title?: string }): JSX.Element {
  return (
    <div className={styles.field} title={title}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  )
}

/** The terminal's rounding: cents above half a dollar, four places below. */
function cost(usd: number): string {
  return `$${usd > 0.5 ? usd.toFixed(2) : usd.toFixed(4)}`
}

/** "1h 31m 43s", as the terminal's `/usage` reads. */
function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
  const units = ['h', 'm', 's']
  const first = parts.findIndex((part) => part > 0)
  if (first === -1) return '0s'
  return parts
    .slice(first)
    .map((part, index) => `${part}${units[first + index]}`)
    .join(' ')
}

function tokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** In the browser's own time zone: today's reset by the clock alone. */
function resetTime(iso: string, now = new Date()): string {
  const at = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return at.toDateString() === now.toDateString() ? `今天 ${clock}` : `${at.getMonth() + 1}月${at.getDate()}日 ${clock}`
}
