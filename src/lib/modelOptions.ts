import type { ModelOptions } from '../types'

/** Largest context window a model setting accepts, in tokens. */
export const MAX_CONTEXT_WINDOW = 10_000_000
/** Smallest; below this not even the tool definitions fit. */
export const MIN_CONTEXT_WINDOW = 256

/** A typed context window, or null when it isn't a whole number in range. */
export function parseContextWindow(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= MIN_CONTEXT_WINDOW && value <= MAX_CONTEXT_WINDOW ? value : null
}

/**
 * A provider's model settings with one model's changed. Fields back at their
 * defaults (no window, tools on Auto) are left out, and so is a model with
 * nothing left, so the settings file only holds real choices.
 */
export function withModelOptions(
  all: Record<string, ModelOptions> | undefined,
  model: string,
  patch: Partial<ModelOptions>
): Record<string, ModelOptions> | undefined {
  const merged: ModelOptions = { ...all?.[model], ...patch }
  const next: ModelOptions = {
    ...(merged.contextWindow !== undefined ? { contextWindow: merged.contextWindow } : {}),
    ...(merged.tools && merged.tools !== 'auto' ? { tools: merged.tools } : {})
  }
  const rest = Object.fromEntries(Object.entries(all ?? {}).filter(([key]) => key !== model))
  const result = Object.keys(next).length > 0 ? { ...rest, [model]: next } : rest
  return Object.keys(result).length > 0 ? result : undefined
}
