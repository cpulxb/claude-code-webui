import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Annotation, Compartment, EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import { useEffect, useMemo, useRef, useState } from 'react'

import { CheckIcon, CopyIcon, XIcon } from '../Icons.tsx'
import styles from './CodeEditor.module.css'

/**
 * The CodeMirror 6 instance behind a FileView tab. Editable files open live,
 * dsh-style — there is no view/edit toggle, only a dirty flag upstream.
 *
 * The language ships as a lazy chunk per grammar via `@codemirror/language-data`
 * — the whole registry costs one filename match up front, and only the matched
 * grammar is ever downloaded. Highlighting uses `classHighlighter`, so colours
 * live in CSS where the `[data-theme]` switch already works.
 *
 * Long lines wrap, as in dsh: nothing ever scrolls sideways, so the sticky
 * line-number gutter can never end up drawn over the code.
 */

/**
 * Marks programmatic dispatches (the value-sync below). The update listener
 * must not report those as edits: a discard-rollback re-flagged as typing
 * would mark the file dirty again the instant it was cleaned.
 */
const External = Annotation.define<boolean>()

export function CodeEditor({
  path,
  value,
  readOnly,
  dirty,
  onChange,
}: {
  path: string
  /** Authoritative content while clean; the starting doc on mount. */
  value: string
  /** Hard lock for files that must never be written back (truncated previews). */
  readOnly: boolean
  /** Unsaved edits exist — external `value` changes must not clobber the doc. */
  dirty: boolean
  onChange: (text: string) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const compartments = useRef({ language: new Compartment(), editing: new Compartment() }).current
  const language = useMemo(() => LanguageDescription.matchFilename(languages, basename(path)), [path])
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  // Copies the buffer as typed, unsaved edits included — what is on screen.
  const copy = (): void => {
    const text = viewRef.current?.state.doc.toString() ?? value
    const flash = (next: 'copied' | 'failed'): void => {
      setCopyState(next)
      setTimeout(() => setCopyState('idle'), 1400)
    }
    void navigator.clipboard.writeText(text).then(
      () => flash('copied'),
      () => flash('failed'),
    )
  }

  useEffect(() => {
    const view = new EditorView({
      parent: containerRef.current!,
      state: EditorState.create({
        // Mount-time props seed the state; later changes go through the
        // targeted effects below instead of a rebuild.
        doc: value,
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          history(),
          bracketMatching(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(classHighlighter),
          compartments.editing.of(editingConfig(readOnly)),
          compartments.language.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(External))) {
              onChangeRef.current(update.state.doc.toString())
            }
          }),
        ],
      }),
    })
    viewRef.current = view

    if (language) {
      void language.load().then((support) => {
        // The tab may have been closed while the grammar chunk was in flight.
        if (viewRef.current === view) view.dispatch({ effects: compartments.language.reconfigure(support) })
      })
    }

    return () => {
      viewRef.current = null
      view.destroy()
    }
    // Mount-only: `path` is fixed per tab, and doc/readOnly updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: compartments.editing.reconfigure(editingConfig(readOnly)) })
  }, [readOnly, compartments])

  // While clean the prop is authoritative: a refresh re-read, a save
  // round-trip or an Esc discard all land here. Never fires with unsaved
  // edits, so it cannot clobber what the user is typing.
  useEffect(() => {
    const view = viewRef.current
    if (!view || dirty) return
    if (view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: External.of(true),
      })
    }
  }, [value, dirty])

  return (
    <div className={styles.frame}>
      <div className={styles.toolbar}>
        <span>{language?.name.toLowerCase() ?? 'text'}</span>
        <button
          className={copyState === 'failed' ? `${styles.copy} ${styles.copyFailed}` : styles.copy}
          onClick={copy}
          type="button"
          title={copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
        >
          {copyState === 'copied' ? (
            <CheckIcon size={13} />
          ) : copyState === 'failed' ? (
            <XIcon size={13} />
          ) : (
            <CopyIcon size={13} />
          )}
        </button>
      </div>
      <div className={styles.host} ref={containerRef} />
    </div>
  )
}

/** Everything that differs between a locked preview and a live editor. */
function editingConfig(readOnly: boolean) {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [EditorState.readOnly.of(false), EditorView.editable.of(true), highlightActiveLine(), highlightActiveLineGutter()]
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}
