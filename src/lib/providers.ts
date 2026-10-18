import type { ProviderName } from '../types'

/** Every provider the app supports. Validation lives here, not in a DB CHECK constraint. */
export const PROVIDER_NAMES: readonly ProviderName[] = ['openai', 'openrouter', 'ollama', 'lmstudio', 'custom']

const PROVIDER_NAME_SET: ReadonlySet<string> = new Set(PROVIDER_NAMES)

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === 'string' && PROVIDER_NAME_SET.has(value)
}
