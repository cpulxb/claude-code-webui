import type { ModelInfo } from '@ccw/shared'

const normalize = (value: string): string => value.replace(/\[1m\]$/i, '[1m]')

/** Explicit selections win over aliases that happen to resolve to the same id. */
export function findModel(models: ModelInfo[], model: string | null): ModelInfo | undefined {
  if (model === null) return models.find((row) => row.value === 'default')
  const value = normalize(model)
  return models.find((row) => normalize(row.value) === value)
    ?? models.find((row) => row.value === value.replace(/\[1m\]$/, '') && row.resolvedModel && row.value !== row.resolvedModel)
    ?? models.find((row) => row.value !== 'default' && row.resolvedModel && normalize(row.resolvedModel) === value)
    ?? models.find((row) => row.resolvedModel && normalize(row.resolvedModel) === value)
}

/** Distinguish aliases when a provider gives them the same display name. */
export function modelLabel(model: ModelInfo, all: ModelInfo[]): string {
  const ambiguous = all.filter((other) => other.displayName === model.displayName).length > 1
  return ambiguous ? `${model.displayName}（${model.value}）` : model.displayName
}
