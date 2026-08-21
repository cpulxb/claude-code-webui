import { fuzzyFilter, type Attachment, type FileSuggestion, type SlashCommand } from '@ccw/shared'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { call } from '../../api/client.ts'
import type { SessionState } from '../../store/session.ts'
import { useStore } from '../../store/session.ts'
import { fileToAttachment } from '../../utils/attachments.ts'
import styles from './Composer.module.css'
import { MODE_META, ModesPopover } from './ModesPopover.tsx'
import { applyTrigger, detectTrigger, type Trigger } from './trigger.ts'
import { TriggerMenu, type MenuItem } from './TriggerMenu.tsx'

const FILE_SUGGEST_DEBOUNCE_MS = 90

export function Composer({ session }: { session: SessionState }): JSX.Element {
  const send = useStore((state) => state.send)
  const interrupt = useStore((state) => state.interrupt)
  const setPermissionMode = useStore((state) => state.setPermissionMode)
  const setEffort = useStore((state) => state.setEffort)
  const setModel = useStore((state) => state.setModel)

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [files, setFiles] = useState<FileSuggestion[]>([])
  const [modesOpen, setModesOpen] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const running = session.status === 'running'

  // Commands bound to a terminal (statusline, vim mode…) are meaningless in a
  // browser; the CLI tags them precisely so remote UIs can hide them.
  const commands = useMemo(() => {
    const terminalOnly = new Set(session.init?.terminalSlashCommands ?? [])
    return session.commands.filter((command) => !terminalOnly.has(command.name))
  }, [session.commands, session.init?.terminalSlashCommands])

  const items: MenuItem[] = useMemo(() => {
    if (!trigger) return []
    if (trigger.kind === '/') {
      return fuzzyFilter(trigger.query, commands, (command) => command.name)
        .slice(0, 40)
        .map(toCommandItem)
    }
    return files.slice(0, 40).map((file) => ({ key: file.path, name: file.path }))
  }, [trigger, commands, files])

  useEffect(() => setActiveIndex(0), [trigger?.kind, trigger?.query])

  // File suggestions come from the server's fs scan, debounced per keystroke.
  useEffect(() => {
    if (trigger?.kind !== '@') return
    const query = trigger.query
    const timer = setTimeout(() => {
      void call('files.suggest', { sessionId: session.sessionId, query })
        .then((result) => setFiles(result.suggestions))
        .catch(() => setFiles([]))
    }, FILE_SUGGEST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [trigger?.kind, trigger?.query, session.sessionId])

  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [text])

  const updateText = useCallback((next: string, caret: number) => {
    setText(next)
    setTrigger(detectTrigger(next, caret))
  }, [])

  const choose = useCallback(
    (item: MenuItem) => {
      const element = textareaRef.current
      if (!element || !trigger) return
      const replacement = trigger.kind === '/' ? `/${item.name} ` : `@${item.name}${item.name.endsWith('/') ? '' : ' '}`
      const applied = applyTrigger(text, element.selectionStart, trigger, replacement)
      setText(applied.text)
      setTrigger(null)
      requestAnimationFrame(() => {
        element.focus()
        element.setSelectionRange(applied.caret, applied.caret)
      })
    },
    [text, trigger],
  )

  const submit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    void send(trimmed, attachments)
    setText('')
    setAttachments([])
    setTrigger(null)
  }, [text, attachments, send])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (trigger && items.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % items.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => (index - 1 + items.length) % items.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const item = items[activeIndex]
        if (item) choose(item)
        return
      }
    }
    if (event.key === 'Escape') {
      setTrigger(null)
      setModesOpen(false)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const addFiles = async (list: FileList | File[]): Promise<void> => {
    const added = await Promise.all([...list].map(fileToAttachment))
    setAttachments((current) => [...current, ...added])
  }

  const onPaste = (event: React.ClipboardEvent): void => {
    const pasted = [...event.clipboardData.files]
    if (pasted.length === 0) return
    event.preventDefault()
    void addFiles(pasted)
  }

  const mode = MODE_META[session.permissionMode]

  return (
    <div className={styles.wrap}>
      <div className={styles.inner}>
        <div className={styles.box} style={{ position: 'relative' }}>
          {trigger && (
            <TriggerMenu
              items={items}
              activeIndex={activeIndex}
              emptyText={trigger.kind === '/' ? '没有匹配的命令' : '没有匹配的文件'}
              onSelect={choose}
              onHover={setActiveIndex}
            />
          )}
          {modesOpen && (
            <ModesPopover
              mode={session.permissionMode}
              effort={session.effort}
              model={session.model}
              models={session.models}
              onMode={(next) => {
                void setPermissionMode(next)
                setModesOpen(false)
              }}
              onEffort={(next) => void setEffort(next)}
              onModel={(next) => void setModel(next)}
            />
          )}

          {attachments.length > 0 && (
            <div className={styles.attachments}>
              {attachments.map((attachment, index) => (
                <span key={index} className={styles.chip}>
                  {attachment.filename ?? attachment.mediaType}
                  <button
                    className={styles.chipRemove}
                    onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                    type="button"
                    aria-label="移除附件"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            rows={1}
            disabled={session.closed}
            placeholder={
              session.closed
                ? '会话已结束 — 从侧栏重新打开即可继续'
                : session.attached
                  ? '输入消息，/ 唤出命令，@ 引用文件'
                  : '只读回放 — 发送消息后由 WebUI 接管这个会话'
            }
            onChange={(event) => updateText(event.target.value, event.target.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setTrigger(null)}
          />

          <div className={styles.toolbar}>
            <button
              className={styles.iconButton}
              onClick={() => fileInputRef.current?.click()}
              type="button"
              title="添加附件"
            >
              +
            </button>
            <button
              className={styles.modeButton}
              onClick={() => setModesOpen(!modesOpen)}
              type="button"
              aria-haspopup="menu"
              aria-expanded={modesOpen}
            >
              <span>{mode.icon}</span>
              <span className={mode.danger ? styles.modeDanger : ''}>{mode.label}</span>
            </button>

            <span className={styles.spacer} />

            {running ? (
              <button
                className={`${styles.send} ${styles.stop}`}
                onClick={() => void interrupt()}
                type="button"
                title="停止"
              >
                ■
              </button>
            ) : (
              <button
                className={styles.send}
                onClick={submit}
                disabled={!text.trim() && attachments.length === 0}
                type="button"
                title="发送"
              >
                ↑
              </button>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </div>
        <div className={styles.hint}>Enter 发送 · Shift+Enter 换行</div>
      </div>
    </div>
  )
}

function toCommandItem(command: SlashCommand): MenuItem {
  return {
    key: command.name,
    name: command.name,
    ...(command.argumentHint ? { hint: command.argumentHint } : {}),
    ...(command.description ? { description: command.description } : {}),
  }
}
