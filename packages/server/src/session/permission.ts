import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision } from '@ccw/shared'

type Pending = {
  resolve: (result: PermissionResult) => void
  /** Permission rules to persist when the user picks "always allow". */
  suggestions: PermissionUpdate[] | undefined
}

/**
 * Bridges the SDK's `canUseTool` callback to the browser.
 *
 * The callback must return a promise that settles with the user's choice, but
 * that choice arrives on a separate HTTP request. `await()` parks the promise
 * here keyed by the control request's id; `respond()` settles it.
 */
export class PermissionBroker {
  #pending = new Map<string, Pending>()

  /** Parks until `respond()` is called, or the SDK aborts the request. */
  await(requestId: string, signal: AbortSignal, suggestions?: PermissionUpdate[]): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.#pending.set(requestId, { resolve, suggestions })

      const onAbort = (): void => {
        if (this.#pending.delete(requestId)) {
          resolve({ behavior: 'deny', message: 'Permission request aborted.' })
        }
      }
      // The SDK aborts when the turn is interrupted while a prompt is open.
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Returns false when the id is unknown — a stale click after an abort. */
  respond(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.#pending.get(requestId)
    if (!pending) return false
    this.#pending.delete(requestId)

    if (decision.behavior === 'deny') {
      pending.resolve({ behavior: 'deny', message: decision.message ?? 'The user rejected this tool call.' })
      return true
    }

    pending.resolve({
      behavior: 'allow',
      // The SDK's docs are explicit: hand the full suggestion set back so the
      // same tool is not re-prompted for the rest of the session.
      ...(decision.remember && pending.suggestions ? { updatedPermissions: pending.suggestions } : {}),
    })
    return true
  }

  /** Deny everything still open — used when the session is torn down. */
  drain(): string[] {
    const ids = [...this.#pending.keys()]
    for (const [, pending] of this.#pending) {
      pending.resolve({ behavior: 'deny', message: 'Session closed.' })
    }
    this.#pending.clear()
    return ids
  }
}
