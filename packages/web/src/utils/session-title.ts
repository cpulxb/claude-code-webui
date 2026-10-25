/** How much of an untitled session's first prompt stands in for its title. */
const TITLE_CHARS = 50

/**
 * What a session is called on screen: its title, or the first prompt the
 * server names an untitled one by, cut to a headline. Counted in code points
 * so the cut never splits an emoji.
 */
export function sessionTitle(summary: string | undefined): string {
  const text = summary?.replace(/\s+/g, ' ').trim()
  if (!text) return '新会话'
  const chars = Array.from(text)
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('').trimEnd()}…` : text
}
