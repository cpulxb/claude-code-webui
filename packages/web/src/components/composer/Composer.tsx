import type { FileSuggestion, ModelInfo } from '@ccw/shared'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'

import { call } from '../../api/client.ts'
import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { withUploads } from '../../utils/attachments.ts'
import { LOCAL_COMMANDS, parseLocalCommand, runLocalCommand } from '../../utils/local-commands.ts'
import { findModel, modelLabel } from '../../utils/models.ts'
import { useNarrow } from '../../utils/narrow.ts'
import { withQuotes } from '../../utils/quotes.ts'
import { ArrowUpIcon, StopIcon, XIcon } from '../Icons.tsx'
import { buildPaletteEntries, CommandPalette, type PaletteEntry } from './CommandPalette.tsx'
import styles from './Composer.module.css'
import { ContextMeter } from './ContextMeter.tsx'
import { EFFORT_LABEL, effortChoices } from './EffortSlider.tsx'
import { AttachIcon, ModeIcon, SlashIcon } from './ModeIcon.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { MODE_META, ModesPopover } from './ModesPopover.tsx'
import { QuoteChips } from './QuoteChips.tsx'
import { applyTrigger, detectTrigger, type Trigger } from './trigger.ts'
import { TriggerMenu, type MenuItem } from './TriggerMenu.tsx'
import { TurnStatus } from './TurnStatus.tsx'
import { UploadChips } from './UploadChips.tsx'
import { useUploads } from './useUploads.ts'

const FILE_SUGGEST_DEBOUNCE_MS = 90
const MODEL_REFRESH_MS = 2000
/** A touch keyboard has no Shift+Enter, so there Enter adds a line and the send button sends. */
const TOUCH = window.matchMedia('(pointer: coarse)')

/** Grows the box to its text, up to the stylesheet's max-height. */
function fitHeight(element: HTMLTextAreaElement): void {
  element.style.height = 'auto'
  element.style.height = `${element.scrollHeight}px`
}

export function Composer(): JSX.Element | null {
  const send = useStore((state) => state.send)
  const runShell = useStore((state) => state.runShell)
  const interrupt = useStore((state) => state.interrupt)
  const setPermissionMode = useStore((state) => state.setPermissionMode)
  const setEffort = useStore((state) => state.setEffort)
  const setModel = useStore((state) => state.setModel)
  const setSettingsSection = useStore((state) => state.setSettingsSection)
  const setUltracode = useStore((state) => state.setUltracode)
  const refreshModels = useStore((state) => state.refreshModels)
  const activeId = useStore((state) => state.activeId)
  const quotes = useStore((state) => state.quotes)
  const setQuotes = useStore((state) => state.setQuotes)

  // Slices rather than the session object: immer replaces that object on every
  // streamed token, which would re-render the palette, the model picker and the
  // effort slider once per token. The two per-token readings this line used to
  // hold — `turnStats` and `liveTokens` — are subscribed by TurnStatus and
  // ContextMeter themselves. Arrays go through useShallow because re-attaching
  // refetches commands and models.
  const cwd = useActiveSessionValue((session) => session.cwd)
  const running = useActiveSessionValue((session) => session.status === 'running') ?? false
  const closed = useActiveSessionValue((session) => session.closed) ?? false
  const attached = useActiveSessionValue((session) => session.attached) ?? false
  // Detached with an error: the attach failed, and the notice above says why.
  const attachFailed = useActiveSessionValue((session) => !session.attached && session.error !== null) ?? false
  const narrow = useNarrow()
  const permissionMode = useActiveSessionValue((session) => session.permissionMode) ?? 'default'
  const effort = useActiveSessionValue((session) => session.effort) ?? 'high'
  const model = useActiveSessionValue((session) => session.model) ?? null
  const ultracode = useActiveSessionValue((session) => session.ultracode) ?? false
  const ultracodeAvailable = useActiveSessionValue((session) => session.ultracodeAvailable) ?? false
  const contextUsage = useActiveSessionValue((session) => session.contextUsage) ?? null
  const allCommands = useActiveSessionValue(useShallow((session) => session.commands)) ?? []
  const models = useActiveSessionValue(useShallow((session) => session.models)) ?? []
  const terminalSlashCommands = useActiveSessionValue(
    useShallow((session) => session.init?.terminalSlashCommands ?? []),
  )

  const [text, setText] = useState('')
  // The terminal's bash mode: a leading `!` runs the rest in the session's cwd.
  const shellMode = text.trimStart().startsWith('!')
  const { uploads, blockReason, addFiles, cancelUpload, retryUpload, removeUpload, clearUploads } = useUploads(activeId, cwd)
  const [attachError, setAttachError] = useState<string | null>(null)
  useEffect(() => setAttachError(null), [activeId, cwd])
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [files, setFiles] = useState<FileSuggestion[]>([])
  const [modesOpen, setModesOpen] = useState(false)
  // The VS Code-style "Select a model" popup, opened from the `/` palette.
  const [modelsOpen, setModelsOpen] = useState(false)
  const [modelIndex, setModelIndex] = useState(0)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modesRef = useRef<HTMLDivElement>(null)
  const modeButtonRef = useRef<HTMLButtonElement>(null)
  const modelPillRef = useRef<HTMLButtonElement>(null)
  const modelsRef = useRef<HTMLDivElement>(null)
  const fileSeqRef = useRef(0)
  const quoteCountRef = useRef(quotes.length)

  // Commands bound to a terminal (statusline, vim mode…) are meaningless in a
  // browser; the CLI tags them precisely so remote UIs can hide them.
  const commands = useMemo(() => {
    const terminalOnly = new Set(terminalSlashCommands)
    return allCommands.filter((command) => !terminalOnly.has(command.name))
  }, [allCommands, terminalSlashCommands])

  // Browser-side stand-ins go last, beside the CLI's built-ins. Submitting one
  // always runs it here, so a same-named CLI entry is dropped, not listed twice.
  const paletteCommands = useMemo(() => {
    const local = new Set(LOCAL_COMMANDS.map((command) => command.name))
    return [...commands.filter((command) => !local.has(command.name)), ...LOCAL_COMMANDS]
  }, [commands])

  const entries: PaletteEntry[] = useMemo(
    () => (trigger?.kind === '/' ? buildPaletteEntries(trigger.query, paletteCommands, models, model) : []),
    [trigger?.kind, trigger?.query, paletteCommands, models, model],
  )

  const fileItems: MenuItem[] = useMemo(
    () =>
      trigger?.kind === '@'
        ? files.slice(0, 40).map((file) => ({ key: file.path, name: file.path, isDirectory: file.isDirectory }))
        : [],
    [trigger?.kind, files],
  )

  const menuLength = trigger?.kind === '/' ? entries.length : trigger?.kind === '@' ? fileItems.length : 0
  const efforts = effortChoices(models, model)
  const pillEfforts = efforts

  useEffect(() => {
    if (attached && (modelsOpen || modesOpen || trigger?.kind === '/')) void refreshModels()
  }, [activeId, attached, modelsOpen, modesOpen, trigger?.kind, refreshModels])

  useEffect(() => {
    if (!attached || closed || running) return
    let pending = false
    const refresh = (): void => {
      if (document.visibilityState !== 'visible' || pending) return
      pending = true
      void refreshModels().finally(() => { pending = false })
    }
    refresh()
    // CC Switch writes settings outside this app. Catch changes while the
    // menu stays open, and immediately on returning from the switcher.
    const timer = window.setInterval(refresh, MODEL_REFRESH_MS)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [activeId, attached, closed, running, refreshModels])

  useEffect(() => {
    if (!modelsOpen) return
    const current = findModel(models, model)
    setModelIndex(Math.max(0, current ? models.indexOf(current) : 0))
  }, [models, model, modelsOpen])

  useEffect(() => setActiveIndex(0), [trigger?.kind, trigger?.query])

  // Suggestions arrive asynchronously, so a shrinking menu can leave the
  // highlight past the end — Enter would then select nothing.
  useEffect(() => {
    setActiveIndex((index) => (index < menuLength ? index : Math.max(0, menuLength - 1)))
  }, [menuLength])

  // File suggestions come from the server's fs scan, debounced per keystroke.
  // Keyed on the directory, so a read-only session completes files too.
  useEffect(() => {
    if (trigger?.kind !== '@' || cwd === undefined) return
    const query = trigger.query
    const seq = ++fileSeqRef.current
    const timer = setTimeout(() => {
      void call('files.suggest', { cwd, query })
        // A slow earlier request must not overwrite a newer query's results.
        .then((result) => {
          if (seq === fileSeqRef.current) setFiles(result.suggestions)
        })
        .catch(() => {
          if (seq === fileSeqRef.current) setFiles([])
        })
    }, FILE_SUGGEST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [trigger?.kind, trigger?.query, cwd])

  // Clicking anywhere outside dismisses the modes popover. The trigger button
  // is excluded so its own onClick still toggles instead of being reopened.
  useEffect(() => {
    if (!modesOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (modesRef.current?.contains(target) || modeButtonRef.current?.contains(target)) return
      setModesOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [modesOpen])

  // Clicking anywhere outside dismisses the model picker. Rows select on
  // mousedown with preventDefault, so they never count as "outside".
  useEffect(() => {
    if (!modelsOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (modelsRef.current?.contains(target) || modelPillRef.current?.contains(target)) return
      setModelsOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [modelsOpen])

  useLayoutEffect(() => {
    const element = textareaRef.current
    if (element) fitHeight(element)
  }, [text])

  // A passage just quoted from the conversation is there to be answered.
  useEffect(() => {
    if (quotes.length > quoteCountRef.current) textareaRef.current?.focus()
    quoteCountRef.current = quotes.length
  }, [quotes.length])

  // The text rewraps when the box changes width too: a phone turned sideways,
  // a panel opened beside the conversation.
  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      // Fitting changes the height, which reports back here; only width counts.
      if (element.clientWidth === width) return
      width = element.clientWidth
      fitHeight(element)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const updateText = useCallback((next: string, caret: number) => {
    setText(next)
    const detected = detectTrigger(next, caret)
    setTrigger(detected)
    // Typing a fresh `/` or `@` stacks a second popover over the picker.
    if (detected) setModelsOpen(false)
  }, [])

  const chooseFile = useCallback(
    (item: MenuItem) => {
      const element = textareaRef.current
      if (!element || !trigger) return
      const replacement = `@${item.name}${item.name.endsWith('/') ? '' : ' '}`
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

  const choosePalette = useCallback(
    (entry: PaletteEntry) => {
      const element = textareaRef.current
      if (!element || !trigger) return
      if (entry.kind === 'command') {
        const applied = applyTrigger(text, element.selectionStart, trigger, `/${entry.command.name} `)
        setText(applied.text)
        setTrigger(null)
        requestAnimationFrame(() => {
          element.focus()
          element.setSelectionRange(applied.caret, applied.caret)
        })
        return
      }
      // Built-in rows act rather than insert, so the `/query` token goes away —
      // except "mention", which turns it into the `@` trigger in place.
      const applied = applyTrigger(text, element.selectionStart, trigger, entry.action === 'mention' ? '@' : '')
      setText(applied.text)
      setTrigger(entry.action === 'mention' ? detectTrigger(applied.text, applied.caret) : null)
      requestAnimationFrame(() => {
        element.focus()
        element.setSelectionRange(applied.caret, applied.caret)
      })
      if (entry.action === 'attach') fileInputRef.current?.click()
      if (entry.action === 'switch-model') {
        const current = findModel(models, model)
        setModelIndex(Math.max(0, current ? models.indexOf(current) : 0))
        setModelsOpen(true)
      }
    },
    [text, trigger, models, model],
  )

  const chooseModel = useCallback(
    (model: ModelInfo) => {
      void setModel(model.value)
      setModelsOpen(false)
      textareaRef.current?.focus()
    },
    [setModel],
  )

  const submit = useCallback(() => {
    // Never silently omit an unfinished, failed or cancelled attachment.
    if (closed || blockReason) return
    const trimmed = text.trim()
    if (!trimmed && uploads.length === 0) return
    // Attachments and quotes make it a prompt: neither a shell command nor a
    // local command has anywhere to put them.
    const plain = uploads.length === 0 && quotes.length === 0
    const command = shellMode && plain ? trimmed.slice(1).trim() : null
    if (command === '') return
    const local = plain ? parseLocalCommand(trimmed) : null
    if (command) void runShell(command)
    else if (local) void runLocalCommand(local)
    else void send(withQuotes(quotes, withUploads(uploads, trimmed)))
    setText('')
    clearUploads()
    setAttachError(null)
    setTrigger(null)
    setQuotes([])
  }, [text, uploads, blockReason, closed, quotes, shellMode, send, runShell, setQuotes, clearUploads])

  // The `/` button. A slash is only a command at the very start of the input —
  // see `detectTrigger` — so it goes there rather than at the caret.
  const openCommands = useCallback(() => {
    const element = textareaRef.current
    if (!element) return
    const next = text.startsWith('/') ? text : `/${text}`
    setText(next)
    setTrigger(detectTrigger(next, 1))
    requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(1, 1)
    })
  }, [text])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // While an IME composition is open, Enter/arrows belong to the candidate
    // window — acting on them would pick a model or menu row behind the user's back.
    if (event.nativeEvent.isComposing) return
    if (modelsOpen && models.length > 0) {
      const count = models.length
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setModelIndex((index) => (index + 1) % count)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setModelIndex((index) => (index - 1 + count) % count)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const picked = models[modelIndex]
        if (picked) chooseModel(picked)
        return
      }
      if (event.key === 'Escape') {
        setModelsOpen(false)
        return
      }
    }
    if (trigger && menuLength > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % menuLength)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => (index - 1 + menuLength) % menuLength)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        if (trigger.kind === '/') {
          const entry = entries[activeIndex]
          if (entry) choosePalette(entry)
        } else {
          const item = fileItems[activeIndex]
          if (item) chooseFile(item)
        }
        return
      }
    }
    if (event.key === 'Escape') {
      setTrigger(null)
      setModesOpen(false)
      setModelsOpen(false)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !TOUCH.matches) {
      event.preventDefault()
      submit()
    }
  }

  const pickFiles = (files: Iterable<File>): void => {
    if (!closed) setAttachError(addFiles(files))
  }

  const onPaste = (event: React.ClipboardEvent): void => {
    const pasted = [...event.clipboardData.files]
    if (pasted.length === 0) return
    event.preventDefault()
    pickFiles(pasted)
  }

  const mode = MODE_META[permissionMode]

  if (cwd === undefined) return null

  return (
    <div className={styles.wrap}>
      <div className={styles.inner}>
        {running && <TurnStatus />}
        <div
          className={`${styles.box} ${shellMode ? styles.boxShell : ''}`}
          style={{ position: 'relative' }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault()
              event.dataTransfer.dropEffect = closed ? 'none' : 'copy'
            }
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length === 0) return
            event.preventDefault()
            pickFiles(event.dataTransfer.files)
          }}
        >
          {trigger?.kind === '/' && (
            <CommandPalette
              entries={entries}
              grouped={trigger.query === ''}
              activeIndex={activeIndex}
              emptyText="没有匹配的命令"
              note={
                // Opening a session eagerly attaches, so an empty list just
                // means the CLI is still booting or the fetch is in flight.
                commands.length === 0 ? '命令加载中…' : undefined
              }
              efforts={efforts}
              effort={effort}
              onEffort={(next) => void setEffort(next)}
              onSelect={choosePalette}
              onHover={setActiveIndex}
            />
          )}
          {trigger?.kind === '@' && (
            <TriggerMenu
              items={fileItems}
              activeIndex={activeIndex}
              emptyText="没有匹配的文件"
              onSelect={chooseFile}
              onHover={setActiveIndex}
            />
          )}
          {modelsOpen && (
            <ModelPicker
              models={models}
              current={model}
              activeIndex={modelIndex}
              rootRef={modelsRef}
              onSelect={chooseModel}
              onHover={setModelIndex}
              onManage={() => {
                setModelsOpen(false)
                setSettingsSection('models')
              }}
            />
          )}
          {modesOpen && (
            <ModesPopover
              mode={permissionMode}
              effort={effort}
              model={model}
              models={models}
              ultracode={ultracode}
              ultracodeAvailable={ultracodeAvailable}
              rootRef={modesRef}
              onMode={(next) => {
                void setPermissionMode(next)
                setModesOpen(false)
              }}
              onEffort={(next) => void setEffort(next)}
              onUltracode={(next) => void setUltracode(next)}
            />
          )}

          {quotes.length > 0 && (
            <QuoteChips quotes={quotes} onRemove={(index) => setQuotes(quotes.filter((_, i) => i !== index))} />
          )}

          {attachError && (
            <div className={styles.attachError} role="alert">
              <span>{attachError}</span>
              <button className={styles.chipRemove} onClick={() => setAttachError(null)} type="button" aria-label="关闭上传错误提示">
                <XIcon size={14} />
              </button>
            </div>
          )}

          <UploadChips uploads={uploads} onCancel={cancelUpload} onRetry={retryUpload} onRemove={removeUpload} />
          {blockReason && <div className={styles.uploadHint}>{blockReason}</div>}

          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            rows={1}
            disabled={closed}
            placeholder={
              closed
                ? '会话已结束 — 从侧栏重新打开即可继续'
                : !attached
                  ? attachFailed
                    ? '没能接管会话，发送时会再试一次'
                    : '正在接管会话…'
                  : narrow
                    ? '输入消息，/ 命令，@ 文件'
                    : '输入消息，/ 唤出命令，@ 引用文件，! 执行 shell 命令'
            }
            onChange={(event) => updateText(event.target.value, event.target.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setTrigger(null)}
          />

          {running ? (
            <button
              className={`${styles.send} ${styles.stop}`}
              onClick={() => void interrupt()}
              type="button"
              title="停止"
            >
              <StopIcon size={14} />
            </button>
          ) : (
            <button
              className={styles.send}
              onClick={submit}
              disabled={closed || blockReason !== null || (!text.trim() && uploads.length === 0)}
              type="button"
              title={blockReason ?? '发送'}
            >
              <ArrowUpIcon />
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) pickFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </div>
        {/* Out of the box, in a quiet row under it: the box is for writing. */}
        <div className={styles.toolbar}>
          <button
            className={styles.iconButton}
            onClick={() => fileInputRef.current?.click()}
            type="button"
            title="上传附件到项目 upload/，发送时以 @路径 引用"
            aria-label="添加附件"
            disabled={closed}
          >
            <AttachIcon />
          </button>
          <button className={styles.iconButton} onClick={openCommands} type="button" title="斜杠命令">
            <SlashIcon />
          </button>

          {(models.length > 0 || model) && (
            <button
              ref={modelPillRef}
              className={styles.modelPill}
              type="button"
              title="切换模型"
              aria-haspopup="listbox"
              aria-expanded={modelsOpen}
              onClick={() => {
                if (modelsOpen) {
                  setModelsOpen(false)
                  return
                }
                setModesOpen(false)
                const current = findModel(models, model)
                setModelIndex(Math.max(0, current ? models.indexOf(current) : 0))
                setModelsOpen(true)
              }}
            >
              <span>{pillModelName(models, model)}</span>
              {pillEfforts.length > 0 && <span className={styles.modelPillEffort}>{EFFORT_LABEL[effort]}</span>}
              {ultracode && ultracodeAvailable && <span className={styles.modelPillUltra}>· Ultracode</span>}
            </button>
          )}

          <span className={styles.spacer} />

          <button
            className={styles.modeButton}
            ref={modeButtonRef}
            onClick={() => setModesOpen(!modesOpen)}
            type="button"
            aria-haspopup="menu"
            aria-expanded={modesOpen}
          >
            <ModeIcon
              mode={permissionMode}
              size={14}
              className={mode.danger ? styles.modeDanger : undefined}
            />
            <span className={mode.danger ? styles.modeDanger : ''}>{mode.label}</span>
          </button>

          <ContextMeter usage={contextUsage} />
        </div>
        {shellMode && <div className={styles.hint}>Shell 模式 · Enter 在会话目录执行，输出会一并发给 Claude</div>}
      </div>
    </div>
  )
}

/**
 * The pill's model name. "Default" is spelled as the model it resolves to,
 * the way VS Code's pill reads `claude-haiku-5.5[1m]` rather than "Default".
 */
function pillModelName(models: ModelInfo[], model: string | null): string {
  const selected = findModel(models, model)
  if (!selected) return model ?? '模型'
  if (selected.value === 'default' && selected.resolvedModel) return selected.resolvedModel
  return modelLabel(selected, models)
}
