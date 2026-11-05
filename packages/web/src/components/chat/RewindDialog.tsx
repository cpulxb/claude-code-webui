import type { RewindFilesResult } from '@ccw/shared'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useActiveSessionValue, useStore } from '../../store/session.ts'
import { describeRestore, describeTurn, restoresFiles, turnEdits } from '../../utils/rewind.ts'
import dialog from '../auth/Auth.module.css'
import styles from './RewindDialog.module.css'
import { usePrompts } from './TurnNav.tsx'

type Choice = 'both' | 'conversation' | 'code'

const CHOICE_LABEL: Record<Choice, string> = {
  both: '恢复代码和对话',
  conversation: '恢复对话',
  code: '恢复代码',
}

type Preview = { result: RewindFilesResult | null; error: string | null }

/**
 * The terminal's rewind: a list of the conversation's prompts (Esc Esc), then
 * what restoring to just before the picked one would do, and how — code and
 * conversation, either alone. `target` skips the list for a prompt picked on
 * its bubble.
 */
export function RewindDialog({ target, onClose }: { target: string | null; onClose: () => void }): JSX.Element {
  const prompts = usePrompts()
  const nodes = useActiveSessionValue((session) => session.transcript.nodes)
  const cwd = useActiveSessionValue((session) => session.cwd)
  const running = useActiveSessionValue((session) => session.status === 'running') ?? false
  const rewindFiles = useStore((state) => state.rewindFiles)
  const rewindConversation = useStore((state) => state.rewindConversation)
  const edits = useMemo(() => turnEdits(nodes ?? []), [nodes])

  const [picked, setPicked] = useState<string | null>(target)
  // The list opens on its last row, "(当前)", as the terminal's does: null,
  // so it stays there when the prompts not read in arrive above it.
  const [hovered, setRow] = useState<number | null>(null)
  const row = hovered ?? prompts.length
  const [option, setOption] = useState(0)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const prompt = picked === null ? undefined : prompts.find((entry) => entry.id === picked)
  const code = restoresFiles(preview?.result ?? null)
  const choices: Choice[] = preview
    ? [...(code && !running ? (['both'] as const) : []), ...(running ? [] : (['conversation'] as const)), ...(code ? (['code'] as const) : [])]
    : []

  // Keys go to the dialog, wherever focus was; it goes back there on close.
  useEffect(() => {
    const previous = document.activeElement
    rootRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  // The dry run behind the "代码会恢复" line and the code choices.
  useEffect(() => {
    setPreview(null)
    setOption(0)
    setError(null)
    if (picked === null) return
    let current = true
    rewindFiles(picked, true).then(
      (result) => {
        if (current) setPreview({ result, error: result.canRewind ? null : (result.error ?? '这条消息没有代码检查点') })
      },
      (cause: unknown) => {
        if (current) setPreview({ result: null, error: cause instanceof Error ? cause.message : String(cause) })
      },
    )
    return () => {
      current = false
    }
  }, [picked, rewindFiles])

  useEffect(() => {
    if (picked === null) listRef.current?.querySelector(`.${styles.active}`)?.scrollIntoView({ block: 'nearest' })
  }, [picked, row])

  const choose = async (choice: Choice): Promise<void> => {
    if (!picked || busy) return
    setBusy(true)
    setError(null)
    try {
      if (choice === 'code') {
        const result = await rewindFiles(picked, false)
        if (!result.canRewind) throw new Error(result.error ?? '代码回退失败')
      } else {
        await rewindConversation(picked, choice === 'both', prompt?.body ?? '')
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const pick = (index: number): void => {
    const entry = prompts[index]
    if (entry) setPicked(entry.id)
    else onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      // Back to the list it came from; a bubble's own confirmation just closes.
      if (picked !== null && target === null && !busy) setPicked(null)
      else if (!busy) onClose()
      return
    }
    const count = picked === null ? prompts.length + 1 : choices.length
    if (count === 0 || busy) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : count - 1
      if (picked === null) setRow((row + step) % count)
      else setOption((index) => (index + step) % count)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (picked === null) pick(row)
      else void choose(choices[option]!)
    } else if (picked !== null && /^[1-9]$/.test(event.key) && Number(event.key) <= count) {
      void choose(choices[Number(event.key) - 1]!)
    }
  }

  return (
    <div className={dialog.backdrop} onMouseDown={() => !busy && onClose()}>
      <div
        ref={rootRef}
        className={`${dialog.dialog} ${styles.dialog}`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="回退"
        tabIndex={-1}
      >
        <div className={dialog.dialogTitle}>回退</div>
        {picked === null ? (
          <>
            <div className={dialog.muted}>把代码和/或对话恢复到这条消息之前…</div>
            <div className={styles.list} ref={listRef} role="listbox" aria-label="消息">
              {prompts.map((entry, index) => {
                const note = describeTurn(edits.get(entry.id), cwd)
                return (
                  <button
                    key={entry.id}
                    className={`${styles.item} ${index === row ? styles.active : ''}`}
                    onClick={() => pick(index)}
                    onMouseEnter={() => setRow(index)}
                    role="option"
                    aria-selected={index === row}
                    type="button"
                  >
                    <span className={styles.itemText}>{entry.text}</span>
                    {note && <span className={styles.itemNote}>{note}</span>}
                  </button>
                )
              })}
              <button
                className={`${styles.item} ${styles.current} ${row === prompts.length ? styles.active : ''}`}
                onClick={onClose}
                onMouseEnter={() => setRow(prompts.length)}
                role="option"
                aria-selected={row === prompts.length}
                type="button"
              >
                （当前）
              </button>
            </div>
            <div className={styles.hint}>↑↓ 选择 · Enter 继续 · Esc 取消</div>
          </>
        ) : (
          <>
            <div className={dialog.muted}>确认要恢复到发送这条消息之前的状态：</div>
            <blockquote className={styles.quote}>{prompt?.body || prompt?.text || '（这条消息）'}</blockquote>
            <div className={styles.effects}>
              {running ? (
                <span>这一轮还在进行，停止之后才能回退对话。</span>
              ) : (
                <span>这条消息和它之后的所有内容都会从对话中移除。</span>
              )}
              {preview === null ? (
                <span>检查代码改动…</span>
              ) : preview.error ? (
                <span>代码无法回退：{preview.error}</span>
              ) : (
                <span>{describeRestore(preview.result!, cwd)}</span>
              )}
            </div>
            {preview && (
              <div className={styles.options} role="listbox" aria-label="回退方式">
                {choices.map((choice, index) => (
                  <button
                    key={choice}
                    className={`${styles.option} ${index === option ? styles.active : ''}`}
                    onClick={() => void choose(choice)}
                    onMouseEnter={() => setOption(index)}
                    disabled={busy}
                    role="option"
                    aria-selected={index === option}
                    type="button"
                  >
                    <span className={styles.optionNumber}>{index + 1}.</span>
                    {CHOICE_LABEL[choice]}
                  </button>
                ))}
              </div>
            )}
            {error && <div className={dialog.error}>{error}</div>}
            {code && <div className={styles.warning}>⚠ 文件会整份恢复，之后任何人对它们的改动都会丢失；Bash 命令改动的其他文件不会撤销。</div>}
            <div className={styles.footer}>
              <span className={styles.hint}>{busy ? '回退中…' : 'Enter 确认 · Esc 取消'}</span>
              <button className={dialog.button} onClick={onClose} disabled={busy} type="button">
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
