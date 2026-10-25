/**
 * Unsaved buffers, keyed by absolute path, kept outside React so switching
 * workspaces unmounts a file's view without dropping its edits: reopening the
 * same file restores them. `base` travels with the text — it is the on-disk
 * content the buffer was typed on, so a restored buffer is compared against the
 * version it was written against instead of silently overwriting whatever the
 * file holds now. Cleared as soon as the buffer stops being dirty (saved,
 * discarded, or typed back to the on-disk text), or when its tab is closed.
 */
export type Draft = { text: string; base: string }

const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()

/**
 * The paths that have a draft, for the tab strip's dots. Replaced only when a
 * path gains or loses its draft — typing into one that has it changes nothing
 * here, so the strip does not re-render per keystroke — and stable otherwise,
 * as `useSyncExternalStore` requires of a snapshot.
 */
let dirty: ReadonlySet<string> = new Set()

function changed(): void {
  dirty = new Set(drafts.keys())
  for (const listener of listeners) listener()
}

export function getDraft(path: string): Draft | undefined {
  return drafts.get(path)
}

export function putDraft(path: string, draft: Draft | null): void {
  const had = drafts.has(path)
  if (draft === null) drafts.delete(path)
  else drafts.set(path, draft)
  if (had !== drafts.has(path)) changed()
}

export function dirtyPaths(): ReadonlySet<string> {
  return dirty
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
