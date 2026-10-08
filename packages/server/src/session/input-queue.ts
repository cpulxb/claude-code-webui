/**
 * A push-based `AsyncIterable` used as the SDK's streaming input.
 *
 * `query({ prompt })` wants an async iterable it can pull from, but prompts
 * arrive from HTTP requests at arbitrary times. This bridges the two: RPC
 * handlers `push()`, the SDK's `for await` pulls, and the iterator parks on a
 * promise while the queue is empty.
 *
 * Single-consumer only — the SDK is the sole reader.
 */
export class InputQueue<T> implements AsyncIterable<T> {
  #pending: T[] = []
  #wake: (() => void) | null = null
  #closed = false

  push(item: T): void {
    if (this.#closed) throw new Error('cannot push to a closed input queue')
    this.#pending.push(item)
    this.#notify()
  }

  /** Drops whatever the consumer has not pulled yet; used when a turn is interrupted. */
  drain(): void {
    this.#pending.length = 0
  }

  close(): void {
    this.#closed = true
    this.#notify()
  }

  get closed(): boolean {
    return this.#closed
  }

  #notify(): void {
    const wake = this.#wake
    this.#wake = null
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.#pending.length > 0) {
        yield this.#pending.shift()!
      }
      if (this.#closed) return
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }
}
