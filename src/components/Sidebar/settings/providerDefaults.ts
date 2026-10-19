import type { ProviderName } from '@/types'
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '@/lib/providers'

export const PROVIDERS: { id: ProviderName; label: string }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'lmstudio', label: 'LM Studio' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)' }
]

export const PROVIDERS_ALLOW_BLANK_MODEL = new Set<ProviderName>([
  'openai',
  'openrouter',
  'ollama',
  'lmstudio',
  'custom'
])

/**
 * Model picked when a provider's list doesn't include the saved selection.
 * Model IDs are provider-specific, so only the default provider has one;
 * the others fall back to the first model their server lists.
 */
export const PROVIDER_PREFERRED_MODELS: Partial<Record<ProviderName, string>> = {
  [DEFAULT_PROVIDER]: DEFAULT_MODEL
}

export const PROVIDER_DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  custom: 'http://localhost:8080/v1'
}

/** Providers that run locally and take no API key. */
export const PROVIDERS_WITHOUT_API_KEY = new Set<ProviderName>(['ollama', 'lmstudio'])

export function resolveProviderModel(
  provider: ProviderName,
  currentModel: string | undefined,
  availableModels: string[]
): string | undefined {
  if (availableModels.length === 0) return currentModel

  if (currentModel && availableModels.includes(currentModel)) {
    return currentModel
  }

  const preferred = PROVIDER_PREFERRED_MODELS[provider]
  if (preferred && availableModels.includes(preferred)) {
    return preferred
  }

  return availableModels[0]
}
