import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { configDir } from '../auth/pairing.ts'

/**
 * A conversation rewound here that its transcript does not show yet.
 *
 * A rewind restarts the CLI with `resumeSessionAt`, but the CLI writes the
 * shorter conversation only with the next prompt (CLI 2.1.316): until then
 * the file's newest entry is still the old branch's, and anything reading it
 * — a reload, a server restart — gets the dropped turns back. So the cut is
 * kept here: history reads stop short of `drop`, and a runner resuming the
 * session starts at `at`. Once the next prompt is saved the SDK reads the new
 * branch, `drop` is no longer on it, and the record has done its job.
 */
export type PendingRewind = {
  /** The entry the conversation now ends on — the dropped prompt's parent. */
  at: string
  /** The prompt rewound away, the first entry no longer in the conversation. */
  drop: string
}

const FILE = 'rewinds.json'

let loaded: Promise<Map<string, PendingRewind>> | null = null
/** Writes one at a time, each with the whole table as it was when asked. */
let writes: Promise<unknown> = Promise.resolve()

function table(): Promise<Map<string, PendingRewind>> {
  return (loaded ??= load())
}

export async function pendingRewind(sessionId: string): Promise<PendingRewind | undefined> {
  return (await table()).get(sessionId)
}

/** Records a session's cut; null forgets it. */
export async function setPendingRewind(sessionId: string, rewind: PendingRewind | null): Promise<void> {
  const rewinds = await table()
  if (rewind) rewinds.set(sessionId, rewind)
  else if (!rewinds.delete(sessionId)) return
  const content = `${JSON.stringify(Object.fromEntries(rewinds), null, 2)}\n`
  const write = writes.then(() => save(content))
  writes = write.catch(() => {})
  await write
}

async function load(): Promise<Map<string, PendingRewind>> {
  const raw = await readFile(join(configDir(), FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}'
    throw error
  })
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // Losing a cut shows the rewound turns again; it must not stop the server.
    console.warn(`[ccw] ${FILE} is not valid JSON; treating it as empty`)
    return new Map()
  }
  if (typeof value !== 'object' || value === null) return new Map()
  return new Map(Object.entries(value).filter((entry): entry is [string, PendingRewind] => isRewind(entry[1])))
}

async function save(content: string): Promise<void> {
  const dir = configDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, FILE)
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, content, { mode: 0o600 })
  await rename(temp, path)
}

function isRewind(value: unknown): value is PendingRewind {
  if (typeof value !== 'object' || value === null) return false
  const rewind = value as Record<string, unknown>
  return typeof rewind['at'] === 'string' && typeof rewind['drop'] === 'string'
}
