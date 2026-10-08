import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision, PermissionRequest } from '@ccw/shared'

type Pending = {
  resolve: (result: PermissionResult) => void
  /** The frame the browser was sent, kept so a reloaded page can be re-served it. */
  request: PermissionRequest
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
  readonly #onAborted: (requestId: string) => void

  /** `onAborted` fires for prompts the SDK cancels, so the browser can drop the card. */
  constructor(onAborted: (requestId: string) => void) {
    this.#onAborted = onAborted
  }

  /** Parks until `respond()` is called, or the SDK aborts the request. */
  await(request: PermissionRequest, signal: AbortSignal): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.#pending.set(request.requestId, { resolve, request })

      const onAbort = (): void => {
        if (this.#pending.delete(request.requestId)) {
          resolve({ behavior: 'deny', message: 'Permission request aborted.' })
          this.#onAborted(request.requestId)
        }
      }
      // The SDK aborts when the turn is interrupted while a prompt is open.
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Every request still waiting on the user.
   *
   * A browser reload drops the cards it was showing while the CLI stays parked
   * on this promise, so the pending set has to be re-servable — otherwise the
   * session hangs with nothing on screen to unblock it.
   */
  list(): PermissionRequest[] {
    return [...this.#pending.values()].map((pending) => pending.request)
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
      ...(decision.remember && pending.request.suggestions ? { updatedPermissions: pending.request.suggestions } : {}),
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
