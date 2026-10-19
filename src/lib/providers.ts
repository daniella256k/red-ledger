import type { ProviderName } from '../types'

/** Every provider the app supports. Validation lives here, not in a DB CHECK constraint. */
export const PROVIDER_NAMES: readonly ProviderName[] = ['openai', 'openrouter', 'ollama', 'lmstudio', 'custom']

/**
 * Provider and model for new installs, and the placeholder a chat row holds
 * until its first send stamps the model actually used. DEFAULT_MODEL is an
 * OpenRouter model ID, so it only applies to DEFAULT_PROVIDER.
 */
export const DEFAULT_PROVIDER: ProviderName = 'openrouter'
export const DEFAULT_MODEL = 'moonshotai/kimi-k3'

const PROVIDER_NAME_SET: ReadonlySet<string> = new Set(PROVIDER_NAMES)

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === 'string' && PROVIDER_NAME_SET.has(value)
}
