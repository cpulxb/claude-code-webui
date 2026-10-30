/**
 * The prompt a reply sends: each quoted passage as a Markdown blockquote, in
 * the order picked, then what was typed beneath them.
 */
export function withQuotes(quotes: string[], text: string): string {
  const blocks = quotes.map((quote) =>
    quote
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n'),
  )
  return [...blocks, text].filter(Boolean).join('\n\n')
}

/**
 * `withQuotes` the other way round, for the bubble: the blockquotes a prompt
 * opens with, and the text after them. A prompt typed with a leading `>`
 * reads as a quote too, as it would in Markdown.
 */
export function splitQuotes(text: string): { quotes: string[]; body: string } {
  const lines = text.split('\n')
  const quotes: string[] = []
  let index = 0
  while (lines[index]?.startsWith('>')) {
    const quote: string[] = []
    while (lines[index]?.startsWith('>')) quote.push(lines[index++]!.replace(/^> ?/, ''))
    quotes.push(quote.join('\n'))
    while (lines[index] === '') index++
  }
  return { quotes, body: lines.slice(index).join('\n') }
}
