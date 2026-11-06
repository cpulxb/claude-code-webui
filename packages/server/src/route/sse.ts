/**
 * Server-sent events, both ways: the upstream's stream read event by event,
 * however its chunks split them, and the Messages events written for the CLI.
 */

export type SseEvent = { event: string; data: string }

export class SseParser {
  #buffer = ''
  /** A chunk's last `\r`, held back: with the next chunk's `\n` it makes one line break, not two. */
  #cr = false

  /** The events `chunk` completes; a partial one waits for the next chunk. */
  push(chunk: string): SseEvent[] {
    let text = (this.#cr ? '\r' : '') + chunk
    this.#cr = text.endsWith('\r')
    if (this.#cr) text = text.slice(0, -1)
    this.#buffer += text.replace(/\r\n?/g, '\n')
    const blocks = this.#buffer.split('\n\n')
    this.#buffer = blocks.pop() ?? ''
    return blocks.flatMap(parse)
  }

  /** What is left once the stream ends: a last event some servers send without its blank line. */
  end(): SseEvent[] {
    const rest = this.#buffer
    this.#buffer = ''
    this.#cr = false
    return parse(rest)
  }
}

function parse(block: string): SseEvent[] {
  let event = ''
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5))
    else if (line.startsWith('event:')) event = line.slice(6).trim()
  }
  return data.length > 0 ? [{ event, data: data.join('\n') }] : []
}

export const sseFrame = (event: { type?: unknown }): string => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
