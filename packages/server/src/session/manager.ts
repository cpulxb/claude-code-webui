import type { ServerEvent, SessionConfig } from '@ccw/shared'

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
  readonly #subscribers = new Set<(event: ServerEvent) => void>()

  create(config: SessionConfig): SessionRunner {
    const runner = new SessionRunner(config, (event) => this.#broadcast(event))
    this.#runners.set(runner.sessionId, runner)
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

  #broadcast(event: ServerEvent): void {
    if (event.type === 'session_closed') this.#runners.delete(event.sessionId)
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
