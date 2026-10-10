import type { ServerEvent, SessionConfig, SessionSummary } from '@ccw/shared'

import { SessionRunner } from './runner.ts'

/**
 * Owns every live {@link SessionRunner} and fans their events out to the
 * connected browsers.
 *
 * The downlink is unfiltered — every subscriber sees every session's events
 * and filters client-side by `sessionId`. That keeps a second tab in sync for
 * free, and matches how deepseek-harness's `events.mux` stream behaves.
 */
export class SessionManager {
  readonly #runners = new Map<string, SessionRunner>()
  /**
   * The most recent runner per session id, kept past `close()` so a runner that
   * exits after the same session was reopened can be recognised as stale — its
   * `session_closed` must not unregister or close the new one.
   */
  readonly #owners = new Map<string, SessionRunner>()
  readonly #subscribers = new Set<(event: ServerEvent) => void>()

  create(config: SessionConfig): SessionRunner {
    // Idempotent on the session id: the browser eagerly attaches on open and
    // again on first send, and a second runner for the same id would leak the
    // first process while both append to the same JSONL.
    const existing = this.#runners.get(config.resume ?? config.sessionId ?? '')
    if (existing) return existing
    // Tagged onto every frame so #broadcast can tell whose it is. Assigned
    // right after construction — the constructor emits nothing synchronously.
    let self: SessionRunner | null = null
    const runner = new SessionRunner(config, (event) => this.#broadcast(self, event))
    self = runner
    this.#runners.set(runner.sessionId, runner)
    this.#owners.set(runner.sessionId, runner)
    this.#broadcast(runner, { type: 'session_updated', sessionId: runner.sessionId, summary: runner.summary })
    return runner
  }

  /** Throws rather than returning undefined — an unknown id is a client bug. */
  require(sessionId: string): SessionRunner {
    const runner = this.#runners.get(sessionId)
    if (!runner) throw new Error(`unknown session: ${sessionId}`)
    return runner
  }

  has(sessionId: string): boolean {
    return this.#runners.has(sessionId)
  }

  liveIds(): string[] {
    return [...this.#runners.keys()]
  }

  liveSummaries(): SessionSummary[] {
    return [...this.#runners.values()].map((runner) => runner.summary)
  }

  close(sessionId: string): void {
    const runner = this.#runners.get(sessionId)
    if (!runner) return
    this.#runners.delete(sessionId)
    runner.close()
  }

  closeAll(): void {
    for (const sessionId of this.liveIds()) this.close(sessionId)
  }

  subscribe(handler: (event: ServerEvent) => void): () => void {
    this.#subscribers.add(handler)
    return () => this.#subscribers.delete(handler)
  }

  #broadcast(sender: SessionRunner | null, event: ServerEvent): void {
    // Every other frame type carries the session id the CLI itself reported, so
    // only lifecycle bookkeeping needs the identity check.
    if (event.type === 'session_closed') {
      if (this.#owners.get(event.sessionId) !== sender) return
      this.#owners.delete(event.sessionId)
      this.#runners.delete(event.sessionId)
    }
    for (const subscriber of this.#subscribers) {
      // One bad socket must not stop the others from seeing the frame.
      try {
        subscriber(event)
      } catch (error) {
        console.error('[ccw] downlink subscriber failed:', error)
      }
    }
  }
}
