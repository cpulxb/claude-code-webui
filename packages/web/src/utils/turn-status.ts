import type { TurnProgress } from '@ccw/shared'

/** Convert server-clock instants once, rather than resetting a delay on replay. */
export function localTurnProgress(progress: TurnProgress | null, serverNow: number | undefined, localNow: number): TurnProgress | null {
  if (!progress) return null
  const offset = typeof serverNow === 'number' && Number.isFinite(serverNow) ? localNow - serverNow : 0
  return {
    ...progress,
    startedAt: progress.startedAt + offset,
    ...(progress.retry ? { retry: { ...progress.retry, retryAt: progress.retry.retryAt === null ? null : progress.retry.retryAt + offset } } : {}),
  }
}

const PHASE_LABEL: Record<TurnProgress['phase'], string> = {
  running: '任务执行中…',
  requesting: '请求模型，等待响应…',
  thinking: '思考中…',
  responding: '生成回复中…',
  tool: '执行工具中…',
  compacting: '压缩上下文中…',
  retrying: 'API 出错，自动重试中…',
}

const ERROR_LABEL: Record<string, string> = {
  authentication_failed: '认证失败',
  oauth_org_not_allowed: '当前组织无法使用',
  account_on_hold: '账户被暂停',
  verification_required: '需要验证账户',
  billing_error: '账户额度或计费异常',
  rate_limit: '请求限流',
  overloaded: '服务过载',
  invalid_request: '请求无效',
  model_not_found: '模型不存在',
  server_error: '服务端错误',
  cloud_credential_error: '云凭据异常',
  max_output_tokens: '达到输出上限',
  unknown: '连接或未知错误',
}

/** Only the countdown changes with time; reaching zero is not proof of success. */
export function turnStatusText(progress: TurnProgress | null, now: number, waiting = false): { label: string; detail: string | null; warning: boolean } {
  const retry = progress?.retry
  let retryDetail: string | null = null
  if (retry) {
    const reason = retry.noResponse ? '等待响应超时' : (ERROR_LABEL[retry.error] ?? retry.error)
    const error = retry.errorStatus === null ? reason : `HTTP ${retry.errorStatus} · ${reason}`
    const attempt = Number.isFinite(retry.attempt) ? `第 ${retry.attempt} 次` : '次数未知'
    const maximum = Number.isFinite(retry.maxRetries) ? `，最多 ${retry.maxRetries} 次` : ''
    const remaining = retry.retryAt === null ? null : Math.max(0, Math.ceil((retry.retryAt - now) / 1000))
    const timing = remaining === null ? '自动重试中，等待响应（剩余等待时间未知）' : remaining > 0 ? `${remaining}s 后重试` : '正在重试，等待响应…'
    retryDetail = `${error} · ${attempt}${maximum} · ${timing}`
  }
  if (waiting) return { label: '等待你确认…', detail: retryDetail, warning: true }
  if (retry) return { label: 'API 出错，自动重试', detail: retryDetail, warning: true }
  const label = progress?.phase === 'tool' && progress.toolName ? `执行 ${progress.toolName}…` : PHASE_LABEL[progress?.phase ?? 'running']
  return { label, detail: null, warning: false }
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}k`
}
