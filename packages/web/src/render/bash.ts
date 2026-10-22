/**
 * The terminal's `!` mode, in the shape the CLI writes it to the transcript:
 * the command as `<bash-input>`, then its output as `<bash-stdout>` plus
 * `<bash-stderr>`. The CLI stores them as two user entries; the WebUI sends
 * both in one prompt. Either way the replay renders the same two rows, and
 * sessions move freely between the two front ends.
 */

const INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/
const OUTPUT = /<bash-stdout>([\s\S]*?)<\/bash-stdout>(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/

export function bashPrompt(command: string, stdout: string, stderr: string): string {
  return `<bash-input>${command}</bash-input>\n<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`
}

/** The bubble text for a command, as the terminal echoes it. */
export function bashEcho(command: string): string {
  return `! ${command}`
}

/** What the output row shows: stdout, then stderr, like an interleaved terminal. */
export function bashDisplay(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join('\n') || '(无输出)'
}

/** The command, when `text` opens with a `<bash-input>` block. */
export function parseBashInput(text: string): string | null {
  return INPUT.exec(text)?.[1] ?? null
}

/** The display text, when `text` ends with a `<bash-stdout>` block. */
export function parseBashOutput(text: string): string | null {
  const match = OUTPUT.exec(text)
  return match ? bashDisplay(match[1] ?? '', match[2] ?? '') : null
}
