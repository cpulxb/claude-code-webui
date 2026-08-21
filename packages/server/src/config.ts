import { execFileSync } from 'node:child_process'

export const DEFAULT_HOST = '127.0.0.1'

let cached: string | null | undefined

/**
 * Path to the Claude Code binary the SDK should spawn.
 *
 * The SDK ships its own copy (see its `optionalDependencies` and the
 * `claudeCodeVersion` field in its package.json), which can drift from the
 * `claude` on PATH. Pinning to the PATH binary keeps the WebUI and the
 * terminal on exactly the same build. Returns undefined when `claude` is not
 * installed, letting the SDK fall back to its bundled copy.
 */
export function resolveClaudeExecutable(): string | undefined {
  if (cached !== undefined) return cached ?? undefined

  const override = process.env.CCW_CLAUDE_PATH
  if (override) {
    cached = override
    return override
  }
  try {
    const found = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()
    cached = found || null
  } catch {
    cached = null
  }
  return cached ?? undefined
}
