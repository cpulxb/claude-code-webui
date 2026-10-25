/** One entry of AskUserQuestion's `questions`. */
export type Question = {
  question: string
  header: string
  options: { label: string; description: string; preview?: string }[]
  multiSelect: boolean
}

/** What the user has picked for one question so far. */
export type Draft = {
  selected: string[]
  /** The free-text answer offered after the options; it counts once it is not blank. */
  other: string
}

export const EMPTY_DRAFT: Draft = { selected: [], other: '' }

/** The tool input comes from the model, so anything off-schema falls back to the plain permission card. */
export function parseQuestions(input: Record<string, unknown>): Question[] | null {
  const questions = input.questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  const valid = questions.every(
    (entry) =>
      typeof entry?.question === 'string' &&
      Array.isArray(entry.options) &&
      entry.options.every((option: { label?: unknown }) => typeof option?.label === 'string'),
  )
  if (!valid) return null
  return questions.map((entry) => ({
    question: entry.question,
    header: typeof entry.header === 'string' ? entry.header : '',
    options: entry.options,
    multiSelect: entry.multiSelect === true,
  }))
}

/** Clicking an option: a single choice replaces everything, including typed text. */
export function toggleOption(question: Question, draft: Draft, label: string): Draft {
  if (!question.multiSelect) return { selected: [label], other: '' }
  const selected = draft.selected.includes(label)
    ? draft.selected.filter((picked) => picked !== label)
    : [...draft.selected, label]
  return { ...draft, selected }
}

/** Typing into the free-text row chooses it; for a single choice that drops the picked option. */
export function typeOther(question: Question, draft: Draft, text: string): Draft {
  return { selected: question.multiSelect ? draft.selected : [], other: text }
}

/**
 * The answer as the tool expects it: the chosen label, or for multi-select
 * every chosen label joined with ", ", typed text last. Null while unanswered.
 */
export function answerOf(question: Question, draft: Draft): string | null {
  const labels = question.options.map((option) => option.label).filter((label) => draft.selected.includes(label))
  const other = draft.other.trim()
  const parts = other ? [...labels, other] : labels
  return parts.length > 0 ? parts.join(', ') : null
}

/** Every answer keyed by question text, or null while any question is still open. */
export function collectAnswers(questions: Question[], drafts: Draft[]): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (const [index, question] of questions.entries()) {
    const answer = answerOf(question, drafts[index] ?? EMPTY_DRAFT)
    if (answer === null) return null
    answers[question.question] = answer
  }
  return answers
}
