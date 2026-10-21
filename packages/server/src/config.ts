import { execFileSync } from 'node:child_process'

export const DEFAULT_HOST = '127.0.0.1'

/**
 * Shared secret required on every request, or undefined when none is needed.
 *
 * On the loopback default the Host-header check is guard enough. A non-loopback
 * bind exposes the RPC surface to the network, where a proxy can forge that
 * header, so a token becomes mandatory rather than optional: startup fails
 * instead of quietly serving an open port.
 */
export function resolveAccessToken(host: string): string | undefined {
  if (isLoopbackAddress(host)) return undefined
  const token = process.env.CCW_TOKEN
  if (!token) {
    throw new Error(
      `CCW_HOST=${host} is not loopback, so CCW_TOKEN is required. Set CCW_TOKEN to a non-empty secret ` +
        `(e.g. CCW_TOKEN=$(openssl rand -hex 32)) and append ?token=<secret> to the URL you load the UI ` +
        `from — the UI reads the token off its own page URL and forwards it only while it is served from ` +
        `the same origin as /api. That URL is not this port: this port answers /api/rpc, /api/events and ` +
        `/api/term only, everything else 404s. The UI's own dev server binds loopback, so exposing it to the ` +
        `network is a separate step. Or drop CCW_HOST to bind loopback only.`,
    )
  }
  return token
}

function isLoopbackAddress(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

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
