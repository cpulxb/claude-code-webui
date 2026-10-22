import { createHash, randomInt } from 'node:crypto'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PairingCode } from '@ccw/shared'

/**
 * Crockford base32: no I, L, O or U, so a code copied off a screen or read
 * aloud has no look-alike characters. 8 of them carry 40 bits.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8

export const CODE_TTL_MS = 5 * 60 * 1000

/**
 * Where devices and pending codes live. Write access to this directory is what
 * makes someone an administrator: `pnpm pair` mints a code by dropping a file
 * here, with no network round-trip and no "local requests are trusted" rule.
 */
export function configDir(): string {
  const override = process.env['CCW_CONFIG_DIR']
  if (override) return override
  return join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'claude-code-webui')
}

/**
 * One file per pending code, named by the code's hash. Separate files rather
 * than one shared list: the CLI and the server both add codes, and the server
 * consumes them, so a shared read-modify-write file could drop a code.
 */
function codesDir(dir: string): string {
  return join(dir, 'pairing')
}

export async function issueCode(dir = configDir(), now = Date.now()): Promise<PairingCode> {
  const raw = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  const expiresAt = now + CODE_TTL_MS
  await mkdir(codesDir(dir), { recursive: true, mode: 0o700 })
  await pruneExpired(dir, now)
  await writeFile(join(codesDir(dir), `${hashCode(raw)}.json`), JSON.stringify({ expiresAt }), { mode: 0o600 })
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt }
}

/**
 * Consumes a code. The unlink is the gate: of two requests racing on the same
 * code, only the one whose unlink succeeds pairs.
 */
export async function redeemCode(input: string, dir = configDir(), now = Date.now()): Promise<boolean> {
  const raw = normalizeCode(input)
  if (!raw) return false
  const path = join(codesDir(dir), `${hashCode(raw)}.json`)
  let expiresAt: number
  try {
    expiresAt = (JSON.parse(await readFile(path, 'utf8')) as { expiresAt: number }).expiresAt
    await unlink(path)
  } catch {
    return false
  }
  return now < expiresAt
}

/** Burns every pending code — the answer to repeated wrong guesses. */
export async function revokeAllCodes(dir = configDir()): Promise<void> {
  for (const name of await listCodeFiles(dir)) await unlink(join(codesDir(dir), name)).catch(() => {})
}

/**
 * Uppercases, drops the separator, and folds the look-alikes Crockford
 * decoding accepts (I and L for 1, O for 0). Null when it cannot be a code.
 */
export function normalizeCode(input: string): string | null {
  const raw = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  if (raw.length !== CODE_LENGTH) return null
  return [...raw].every((char) => ALPHABET.includes(char)) ? raw : null
}

function hashCode(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

async function pruneExpired(dir: string, now: number): Promise<void> {
  for (const name of await listCodeFiles(dir)) {
    const path = join(codesDir(dir), name)
    try {
      const { expiresAt } = JSON.parse(await readFile(path, 'utf8')) as { expiresAt: number }
      if (now >= expiresAt) await unlink(path)
    } catch {
      // Consumed or pruned by the other process meanwhile.
    }
  }
}

async function listCodeFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(codesDir(dir))).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}
