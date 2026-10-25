import type { PermissionRequest } from '@ccw/shared'
import { useState } from 'react'

import { useStore } from '../../store/session.ts'
import {
  answerOf,
  collectAnswers,
  EMPTY_DRAFT,
  toggleOption,
  typeOther,
  type Draft,
  type Question,
} from '../../utils/questions.ts'
import { CheckIcon } from '../Icons.tsx'
import styles from './QuestionCard.module.css'

/**
 * AskUserQuestion, answered in place.
 *
 * The questions arrive as a permission prompt: the CLI parks the tool call on
 * `canUseTool`, and allowing it with `answers` is how they reach the model —
 * a bare allow reads to it as the user not answering at all. As in the
 * terminal, every question also takes a typed answer instead of the options.
 */
export function QuestionCard({ request, questions }: { request: PermissionRequest; questions: Question[] }): JSX.Element {
  const respond = useStore((state) => state.respondToPermission)
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => EMPTY_DRAFT))

  const question = questions[index]!
  const draft = drafts[index]!
  const answers = collectAnswers(questions, drafts)
  const multiple = questions.length > 1
  // The option picked last, so each click in a multi-select shows what it picked.
  const preview = question.options.find((option) => option.label === draft.selected.at(-1))?.preview

  const update = (next: Draft): void => setDrafts(drafts.map((old, at) => (at === index ? next : old)))
  const submit = (): void => {
    if (answers) void respond(request.requestId, { behavior: 'allow', answers })
  }

  return (
    <div className={styles.card}>
      <div className={styles.title}>{multiple ? `Claude 有 ${questions.length} 个问题想问你` : 'Claude 有个问题想问你'}</div>

      {multiple && (
        <div className={styles.tabs} role="tablist">
          {questions.map((entry, at) => (
            <button
              key={at}
              className={`${styles.tab} ${at === index ? styles.tabActive : ''}`}
              onClick={() => setIndex(at)}
              role="tab"
              aria-selected={at === index}
              type="button"
            >
              {answerOf(entry, drafts[at]!) !== null && <CheckIcon size={12} />}
              {entry.header || `问题 ${at + 1}`}
            </button>
          ))}
        </div>
      )}

      <div className={styles.question}>{question.question}</div>
      {question.multiSelect && <div className={styles.hint}>可多选</div>}

      <div className={styles.options} role={question.multiSelect ? 'group' : 'radiogroup'}>
        {question.options.map((option) => {
          const checked = draft.selected.includes(option.label)
          return (
            <button
              key={option.label}
              className={`${styles.option} ${checked ? styles.optionChecked : ''}`}
              onClick={() => update(toggleOption(question, draft, option.label))}
              role={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={checked}
              type="button"
            >
              <Mark multiSelect={question.multiSelect} checked={checked} />
              <span className={styles.optionText}>
                <span className={styles.label}>{option.label}</span>
                {option.description && <span className={styles.description}>{option.description}</span>}
              </span>
            </button>
          )
        })}
        <label className={`${styles.option} ${draft.other.trim() ? styles.optionChecked : ''}`}>
          <Mark multiSelect={question.multiSelect} checked={draft.other.trim() !== ''} />
          <input
            className={styles.other}
            aria-label="其他"
            value={draft.other}
            placeholder="其他，自己输入…"
            onChange={(event) => update(typeOther(question, draft, event.target.value))}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (answers) submit()
              else if (index < questions.length - 1) setIndex(index + 1)
            }}
          />
        </label>
      </div>

      {preview && <pre className={styles.preview}>{preview}</pre>}

      <div className={styles.actions}>
        {multiple && (
          <>
            <button className={styles.button} disabled={index === 0} onClick={() => setIndex(index - 1)} type="button">
              上一题
            </button>
            <button
              className={styles.button}
              disabled={index === questions.length - 1}
              onClick={() => setIndex(index + 1)}
              type="button"
            >
              下一题
            </button>
          </>
        )}
        <span className={styles.spacer} />
        <button
          className={styles.button}
          onClick={() =>
            void respond(request.requestId, { behavior: 'deny', message: 'The user declined to answer the questions.' })
          }
          type="button"
        >
          跳过
        </button>
        <button
          className={`${styles.button} ${styles.primary}`}
          disabled={!answers}
          onClick={submit}
          type="button"
        >
          提交
        </button>
      </div>
    </div>
  )
}

function Mark({ multiSelect, checked }: { multiSelect: boolean; checked: boolean }): JSX.Element {
  return (
    <span className={`${styles.mark} ${multiSelect ? styles.box : styles.radio} ${checked ? styles.markChecked : ''}`}>
      {checked && multiSelect && <CheckIcon size={11} />}
    </span>
  )
}
