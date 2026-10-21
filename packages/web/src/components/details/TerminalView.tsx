import '@xterm/xterm/css/xterm.css'

import type { TerminalClientMessage, TerminalServerMessage } from '@ccw/shared'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useEffect, useRef } from 'react'

import { terminalUrl } from '../../api/client.ts'
import styles from './TerminalView.module.css'

/** Rendered characters are acknowledged in batches of this size (the server's flow control). */
const ACK_CHUNK = 5_000

/** The @font-face in TerminalView.module.css. */
const ICON_FONT = 'Symbols Nerd Font Mono'

/**
 * xterm's stock ANSI colours are tuned for a dark background, where yellow and
 * white read fine; on a light one they vanish. This is VS Code's light set.
 */
const LIGHT_ANSI: ITheme = {
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Colours come from the live tokens, so the terminal sits on the panel like the editor does. */
function currentTheme(): ITheme {
  const background = cssVar('--ccw-bg-sidebar')
  const foreground = cssVar('--ccw-text-primary')
  const dark = document.documentElement.dataset['theme'] === 'dark'
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.12)',
    ...(dark ? {} : LIGHT_ANSI),
  }
}

/**
 * One terminal tab: an xterm.js screen wired to a shell on the server over its
 * own socket. The shell lives exactly as long as this component — unmounting
 * closes the socket, which kills it — so the panel keeps terminal tabs mounted
 * (hidden) while another tab or another workspace is in front.
 */
export function TerminalView({
  cwd,
  active,
  onReady,
}: {
  cwd: string
  /** In front: take focus. Background terminals keep running regardless. */
  active: boolean
  /** The server named the shell it started — the tab's title. */
  onReady: (shell: string) => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal({
      // First, yet only ever used for icons: its unicode-range admits nothing else.
      fontFamily: `'${ICON_FONT}', ${cssVar('--ccw-font-mono')}`,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: currentTheme(),
      // term.unicode, which the Unicode 11 addon drives, is still a proposed API.
      allowProposedApi: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    // xterm's default Unicode 6 tables count most emoji as one cell, while the
    // TUIs drawing them (Claude Code's status line among them) count two, so
    // each emoji ate the space after it.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(host)
    // Only the WebGL renderer draws block and box-drawing characters itself
    // (customGlyphs); the DOM one leaves the font's line-height gaps between
    // rows, which slices pixel art such as Claude Code's mascot. Browsers cap
    // WebGL contexts per page, so on a lost one the DOM renderer takes over.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // No WebGL2: the DOM renderer stays.
    }
    termRef.current = term

    // A hidden tab (or a collapsed panel) measures 0×0, and fitting to that
    // would shrink the shell to nothing; its first real size comes from the
    // observer once it is shown.
    const fit = (): void => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fitAddon.fit()
    }
    fit()

    const socket = new WebSocket(terminalUrl({ cwd, cols: term.cols, rows: term.rows }))
    const send = (message: TerminalClientMessage): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    }
    let disposed = false
    let exited = false
    let rendered = 0

    // The WebGL renderer rasterises each glyph once into an atlas, so an icon
    // drawn before the font arrived would stay a box; redraw once it is in.
    // The sample is a folder icon: a face loads only for text in its range.
    void document.fonts.load(`1em '${ICON_FONT}'`, '\uf07b').then(() => {
      if (!disposed) term.clearTextureAtlas()
    })

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as TerminalServerMessage
      if (message.type === 'ready') {
        onReadyRef.current(message.shell)
      } else if (message.type === 'output') {
        // Credit is returned only once xterm has actually parsed the chunk,
        // which is what lets the server pause a runaway producer.
        term.write(message.data, () => {
          rendered += message.data.length
          if (rendered >= ACK_CHUNK) {
            send({ type: 'ack', chars: rendered })
            rendered = 0
          }
        })
      } else if (message.type === 'exit') {
        exited = true
        term.write(`\r\n\x1b[2m[进程已退出，退出码 ${message.code}]\x1b[0m\r\n`)
      }
    })
    socket.addEventListener('close', () => {
      if (!disposed && !exited) term.write('\r\n\x1b[2m[连接已断开]\x1b[0m\r\n')
    })

    term.onData((data) => send({ type: 'input', data }))
    term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
    // Ctrl+` belongs to the panel (a new terminal), not to the shell, where it
    // would type a NUL. Returning false also lets the event bubble up to the
    // panel's listener; every other key, Ctrl+P included, stays the shell's.
    term.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.code === 'Backquote'))

    // Debounced: the panel's open/close animation resizes every frame, and
    // each refit is a SIGWINCH that makes the shell redraw its prompt.
    let refit: ReturnType<typeof setTimeout> | undefined
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(refit)
      refit = setTimeout(fit, 50)
    })
    resizeObserver.observe(host)

    const themeObserver = new MutationObserver(() => {
      term.options.theme = currentTheme()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      disposed = true
      clearTimeout(refit)
      resizeObserver.disconnect()
      themeObserver.disconnect()
      socket.close()
      term.dispose()
      termRef.current = null
    }
    // Mount-only: a tab's shell is started once, in the cwd it was opened for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return (
    <div className={styles.frame}>
      <div className={styles.host} ref={hostRef} />
    </div>
  )
}
