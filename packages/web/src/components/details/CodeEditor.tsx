import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

import styles from './CodeEditor.module.css'

/**
 * CodeMirror 6 wrapper behind the FileView: one instance serves both the
 * read-only render and the editing state, toggled through a compartment so
 * the DOM (and scroll position) survives the switch.
 *
 * The language ships as a lazy chunk per grammar via `@codemirror/language-data`
 * — the whole registry costs one filename match up front, and only the matched
 * grammar is ever downloaded. Highlighting uses `classHighlighter`, so colours
 * live in CSS where the `[data-theme]` switch already works.
 */
export function CodeEditor({
  path,
  value,
  readOnly,
  onChange,
}: {
  path: string
  /** Authoritative content while read-only; the starting doc when editing begins. */
  value: string
  readOnly: boolean
  onChange: (text: string) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const compartments = useRef({ language: new Compartment(), editing: new Compartment() }).current

  useEffect(() => {
    const view = new EditorView({
      parent: containerRef.current!,
      state: EditorState.create({
        // Mount-time props seed the state; later changes go through the
        // targeted effects below instead of a rebuild.
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(classHighlighter),
          compartments.editing.of(editingConfig(readOnly)),
          compartments.language.of([]),
          EditorView.updateListener.of((update) => {
            // The read-only sync below also flags docChanged; user edits can
            // only happen while editable, and reporting a programmatic
            // rollback as an edit would re-open the editing state it just left.
            if (update.docChanged && !update.state.readOnly) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view

    const language = LanguageDescription.matchFilename(languages, basename(path))
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
    if (!readOnly) view.focus()
  }, [readOnly, compartments])

  // While read-only the prop is authoritative: a refresh re-read or a
  // cancelled edit lands here and rolls the doc back. Never fires mid-edit,
  // so it cannot clobber what the user is typing.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !readOnly) return
    if (view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  }, [value, readOnly])

  return <div className={readOnly ? styles.host : `${styles.host} ${styles.hostEditing}`} ref={containerRef} />
}

/** Everything that differs between rendering a file and editing it. */
function editingConfig(readOnly: boolean) {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [EditorState.readOnly.of(false), EditorView.editable.of(true), highlightActiveLine(), highlightActiveLineGutter()]
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}
