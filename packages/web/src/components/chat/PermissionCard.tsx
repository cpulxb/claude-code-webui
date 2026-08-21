import type { PermissionRequest } from '@ccw/shared'

import { useStore } from '../../store/session.ts'
import styles from './PermissionCard.module.css'

/**
 * An open `canUseTool` prompt.
 *
 * `title` / `description` come pre-rendered from the CLI bridge, so they are
 * shown verbatim rather than rebuilt from the tool name and input — the bridge
 * knows things the raw input does not (which path tripped the check, why).
 *
 * "总是允许" replays the request's own `suggestions` back as permission rules,
 * which is what stops the same tool from asking again this session.
 */
export function PermissionCard({ request }: { request: PermissionRequest }): JSX.Element {
  const respond = useStore((state) => state.respondToPermission)
  const detail = summarize(request)

  return (
    <div className={styles.card}>
      <div className={styles.title}>{request.title ?? `Claude 想要使用 ${request.toolName}`}</div>
      {request.description && <div className={styles.description}>{request.description}</div>}
      {detail && <div className={styles.detail}>{detail}</div>}
      {request.decisionReason && <div className={styles.reason}>触发原因：{request.decisionReason}</div>}

      <div className={styles.actions}>
        <button
          className={`${styles.button} ${styles.primary}`}
          onClick={() => void respond(request.requestId, { behavior: 'allow' })}
          type="button"
        >
          允许
        </button>
        {request.suggestions && request.suggestions.length > 0 && (
          <button
            className={styles.button}
            onClick={() => void respond(request.requestId, { behavior: 'allow', remember: true })}
            type="button"
          >
            总是允许
          </button>
        )}
        <button
          className={`${styles.button} ${styles.danger}`}
          onClick={() => void respond(request.requestId, { behavior: 'deny' })}
          type="button"
        >
          拒绝
        </button>
      </div>
    </div>
  )
}

function summarize(request: PermissionRequest): string {
  const input = request.input
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
  return request.blockedPath ?? ''
}
