import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import type { TlsOptions } from './rpc/server.ts'

export const DEFAULT_HOST = '127.0.0.1'

/**
 * Certificate and key for serving HTTPS directly, from `CCW_TLS_CERT` and
 * `CCW_TLS_KEY` (PEM paths) — a `tailscale cert` pair, a Let's Encrypt pair,
 * or a self-signed one. Undefined when neither is set. Read once at startup, so
 * a renewed certificate takes a restart.
 */
export function resolveTls(): TlsOptions | undefined {
  const cert = process.env['CCW_TLS_CERT']
  const key = process.env['CCW_TLS_KEY']
  if (!cert && !key) return undefined
  if (!cert || !key) throw new Error('CCW_TLS_CERT and CCW_TLS_KEY must be set together')
  return { cert: readFileSync(cert), key: readFileSync(key) }
}

/**
 * A non-loopback bind serves the network directly, and without TLS everything
 * would cross it in the clear — prompts, code, terminal keystrokes and the
 * device cookie, which is Secure and would not even be kept. So startup fails
 * instead. Behind a TLS-terminating proxy, keep the bind on loopback.
 */
export function assertSafeBind(host: string, tls: TlsOptions | undefined): void {
  if (isLoopbackAddress(host) || tls) return
  throw new Error(
    `CCW_HOST=${host} is not loopback, so TLS is required: set CCW_TLS_CERT and CCW_TLS_KEY to a PEM ` +
      `certificate and key, or keep CCW_HOST on loopback and put a TLS-terminating proxy (Caddy, ` +
      `tailscale serve) in front. See docs/remote-deployment.md.`,
  )
}

/** Whether `CCW_REQUIRE_PAIRING=1` turned the loopback exemption off. */
export function requirePairing(): boolean {
  return process.env['CCW_REQUIRE_PAIRING'] === '1'
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
