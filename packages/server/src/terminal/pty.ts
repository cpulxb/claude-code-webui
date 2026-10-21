import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename } from 'node:path'

import type { TerminalClientMessage, TerminalServerMessage } from '@ccw/shared'
import { spawn } from 'node-pty'
import type { WebSocket } from 'ws'

/**
 * Flow control, after VS Code's terminal: the PTY is paused once this many
 * characters have been sent but not yet rendered by the browser, and resumed
 * when the backlog drains below LOW. Without it `yes` or a large `cat`
 * streams faster than xterm.js can parse, and the tab's memory grows until
 * it stalls.
 */
const HIGH_WATERMARK = 100_000
const LOW_WATERMARK = 5_000

const DEFAULT_SIZE = { cols: 80, rows: 24 }

/** The passwd entry, or null for a uid without one (common in containers, where `userInfo` throws). */
function account(): { shell: string | null; homedir: string } | null {
  try {
    return userInfo()
  } catch {
    return null
  }
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  )
}

/**
 * The shell a terminal tab runs: the account's own login shell, wherever this
 * is deployed. `$SHELL` first, so a unit file can override it; then the passwd
 * entry, because a service is not a login session — systemd without `User=`,
 * cron and containers usually set no `$SHELL` at all; `/bin/sh` as the floor.
 */
export async function resolveShell(): Promise<string> {
  for (const candidate of [process.env.SHELL, account()?.shell]) {
    if (candidate && (await isExecutable(candidate))) return candidate
  }
  return '/bin/sh'
}

/** A terminal dimension from the wire, or null when it is not a sane one. */
export function terminalSize(value: unknown): number | null {
  const size = Number(value)
  return Number.isInteger(size) && size > 0 && size <= 1000 ? size : null
}

/**
 * Runs one shell for the lifetime of one socket. Closing the tab closes the
 * socket and that kills the shell; so does a dropped connection (page reload,
 * server restart) — there is no reattach.
 *
 * Synchronous on purpose: the listeners must be on the socket before the
 * event loop turns, or the browser's first frames would arrive to nobody.
 */
export function attachTerminal(
  ws: WebSocket,
  options: { shell: string; cwd: string; cols: number | null; rows: number | null },
): void {
  const { shell } = options
  // A service often has no HOME either, and without it the shell skips the
  // user's rc files — no prompt, no aliases.
  const home = process.env.HOME ?? account()?.homedir
  const pty = spawn(shell, [], {
    name: 'xterm-256color',
    cols: options.cols ?? DEFAULT_SIZE.cols,
    rows: options.rows ?? DEFAULT_SIZE.rows,
    cwd: options.cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      SHELL: shell,
      ...(home ? { HOME: home } : {}),
    },
  })

  let exited = false
  let unacked = 0
  let paused = false

  const send = (message: TerminalServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
  }

  send({ type: 'ready', shell: basename(shell) })

  pty.onData((data) => {
    send({ type: 'output', data })
    unacked += data.length
    if (!paused && unacked > HIGH_WATERMARK) {
      paused = true
      pty.pause()
    }
  })

  pty.onExit(({ exitCode }) => {
    exited = true
    send({ type: 'exit', code: exitCode })
    ws.close(1000)
  })

  ws.on('message', (raw) => {
    let message: TerminalClientMessage
    try {
      message = JSON.parse(String(raw)) as TerminalClientMessage
    } catch {
      return
    }
    // node-pty throws on writes and resizes once the process is gone.
    if (exited) return
    if (message.type === 'input' && typeof message.data === 'string') {
      pty.write(message.data)
    } else if (message.type === 'resize') {
      const cols = terminalSize(message.cols)
      const rows = terminalSize(message.rows)
      if (cols !== null && rows !== null) pty.resize(cols, rows)
    } else if (message.type === 'ack') {
      unacked = Math.max(0, unacked - (Number(message.chars) || 0))
      if (paused && unacked < LOW_WATERMARK) {
        paused = false
        pty.resume()
      }
    }
  })

  ws.on('close', () => {
    if (!exited) pty.kill()
  })
}
