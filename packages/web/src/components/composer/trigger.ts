/**
 * Detects the `/` and `@` token under the caret.
 *
 * `/` only fires when it is the first character of the input — that is where
 * Claude Code interprets a slash command; `/` inside prose is a path or a
 * fraction. `@` fires anywhere a whitespace boundary precedes it.
 */

export type TriggerKind = '/' | '@'

export type Trigger = {
  kind: TriggerKind
  /** Index of the trigger character itself, for replacing the whole token. */
  start: number
  /** Text typed after the trigger character. */
  query: string
}

const SLASH = /^\/([\w:.-]*)$/
const AT = /(?:^|\s)@(\S*)$/

export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret)

  const slash = SLASH.exec(before)
  if (slash) return { kind: '/', start: 0, query: slash[1] ?? '' }

  const at = AT.exec(before)
  if (at) {
    const query = at[1] ?? ''
    return { kind: '@', start: caret - query.length - 1, query }
  }

  return null
}

/** Replaces the trigger token with `replacement`, returning text and new caret. */
export function applyTrigger(
  text: string,
  caret: number,
  trigger: Trigger,
  replacement: string,
): { text: string; caret: number } {
  const head = text.slice(0, trigger.start)
  const tail = text.slice(caret)
  return { text: head + replacement + tail, caret: head.length + replacement.length }
}
