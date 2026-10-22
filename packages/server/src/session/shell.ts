import { spawn } from 'node:child_process'

import { resolveShell } from '../terminal/pty.ts'

/** Same ceiling as the CLI's Bash tool default. */
const TIMEOUT_MS = 120_000
/** Per stream, in characters — roughly what the CLI keeps of a Bash result. */
const OUTPUT_LIMIT = 30_000
/** Bytes buffered per stream before the rest is dropped unread. */
const BYTE_LIMIT = 1024 * 1024

/**
 * Runs one `!` command the way the terminal's bash mode does: non-interactive,
 * no stdin, in the session's cwd. A failure is reported in-band on stderr
 * (`Exit code N`) rather than thrown, because the model is meant to see it.
 */
export async function runShellCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  const shell = await resolveShell()
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    // A backgrounded grandchild (`cmd &`) inherits the pipes and can hold them
    // open long after the shell itself exits, so `close` would wait on it.
    // Give buffered output a moment to drain, then stop listening.
    child.on('exit', () => {
      clearTimeout(timer)
      setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
      }, 200)
    })
    child.on('close', (code, signal) => {
      let err = stderr.text()
      const note = timedOut
        ? `Command timed out after ${TIMEOUT_MS / 1000}s`
        : signal
          ? `Killed by ${signal}`
          : code
            ? `Exit code ${code}`
            : ''
      if (note) err = err ? `${err}\n${note}` : note
      resolve({ stdout: stdout.text(), stderr: err })
    })
  })
}

function collect(stream: NodeJS.ReadableStream): { text: () => string } {
  const chunks: Buffer[] = []
  let size = 0
  let dropped = false
  stream.on('data', (chunk: Buffer) => {
    if (size >= BYTE_LIMIT) {
      dropped = true
      return
    }
    chunks.push(chunk)
    size += chunk.length
  })
  return {
    text: () => {
      // Decoded once at the end so a multi-byte character split across two
      // chunks is not mangled.
      const text = Buffer.concat(chunks).toString('utf8').replace(/\n$/, '')
      return dropped || text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (output truncated)` : text
    },
  }
}
