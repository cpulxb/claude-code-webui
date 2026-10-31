/**
 * Some upstreams (or replies quoting a tool result) put a serialized list of
 * text blocks inside an assistant's `text` field. Markdown cannot see the
 * newlines in that JSON string. Unwrap only complete, text-only envelopes
 * whose body has block-level Markdown; ordinary prose, other JSON shapes
 * and fenced code examples stay byte-for-byte intact.
 *
 * This is a presentation adapter, not transcript repair. Callers must opt in
 * for assistant replies, never file previews, user messages or tool output.
 */
export function decodeSerializedAssistantText(text: string): string {
  const source = text.trim()
  if (!source.startsWith('{') && !source.startsWith('[')) return text

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    // A few JSON-like replies use JavaScript's \u{…} string escapes. Accept
    // that one extension only, and still let JSON.parse validate everything
    // else. Never evaluate model output or globally replace literal \\n.
    const compatible = jsonCodePointEscapes(source)
    if (compatible === source) return text
    try {
      value = JSON.parse(compatible)
    } catch {
      return text
    }
  }

  const blocks = Array.isArray(value) ? value : [value]
  if (blocks.length === 0 || !blocks.every(isTextBlock)) return text
  // Test the source blocks, not the joined output: joining two plain `text`
  // values must not manufacture a Markdown paragraph boundary.
  if (!blocks.some((block) => hasBlockMarkdown(block.text))) return text
  return blocks.map((block) => block.text).join('\n\n')
}

type TextBlock = { text: string; type?: 'text' }

function isTextBlock(value: unknown): value is TextBlock {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const block = value as Record<string, unknown>
  return (
    typeof block.text === 'string' &&
    (block.type === undefined || block.type === 'text') &&
    Object.keys(block).every((key) => key === 'text' || key === 'type')
  )
}

/** A multiline Markdown body, not a one-line JSON example with a `text` key. */
function hasBlockMarkdown(text: string): boolean {
  if (!text.includes('\n')) return false
  return (
    /\n[ \t]*\r?\n/.test(text) ||
    /(?:^|\n)[ \t]{0,3}(?:#{1,6}[ \t]+|[-+*][ \t]+|\d+[.)][ \t]+|>[ \t]?|`{3,}|~{3,})\S/.test(text) ||
    /(?:^|\n)[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*\|/.test(text)
  )
}

/** Convert active JS code-point escapes only inside JSON strings, once. */
function jsonCodePointEscapes(source: string): string {
  if (!source.includes('\\u{')) return source
  const parts: string[] = []
  let inString = false
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      inString = !inString
    } else if (inString && character === '\\') {
      const escape = /^u\{([\da-fA-F]{1,6})\}/.exec(source.slice(index + 1, index + 10))
      if (escape) {
        const point = Number.parseInt(escape[1]!, 16)
        if (point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)) {
          parts.push(source.slice(start, index), JSON.stringify(String.fromCodePoint(point)).slice(1, -1))
          index += escape[0].length
          start = index + 1
          continue
        }
      }
      // Skip an escaped quote/backslash as a pair: \\u{…} is literal text,
      // not an active escape. Invalid escapes remain invalid for JSON.parse.
      index += 1
    }
  }
  return parts.length ? parts.join('') + source.slice(start) : source
}
