import axios from 'axios'
import { OpenAIProvider } from './openai'
import { registerProvider } from './registry'

/**
 * OpenRouter provider — extends OpenAI with a different base URL.
 * The streaming format is identical (OpenAI-compatible).
 * The only difference is the models endpoint returns all models (no gpt- filter).
 */
/** Anthropic's models, which cache a prompt only when asked (OpenRouter ids like anthropic/claude-...). */
export function isAnthropicModel(model: string): boolean {
  return model.trim().toLowerCase().replace(/^~/, '').startsWith('anthropic/')
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor(apiKey: string, baseUrl: string = 'https://openrouter.ai/api/v1') {
    super(apiKey, baseUrl)
  }

  /**
   * Prompt caching through OpenRouter. Every chat request carries the chat's
   * id as `session_id`, so OpenRouter keeps sending it to the same provider
   * and its cache stays warm (OpenAI, DeepSeek, Grok, Moonshot and Gemini
   * cache on their own). Anthropic models cache only when asked: the
   * request-level `cache_control` caches everything up to the newest message,
   * and each later request (the next tool round, the next turn) reads that
   * back and caches its own end, for 5 minutes.
   */
  protected override buildCacheControls(model: string, cacheKey: string | undefined): Record<string, unknown> | undefined {
    if (!cacheKey) return undefined
    return {
      session_id: cacheKey,
      ...(isAnthropicModel(model) ? { cache_control: { type: 'ephemeral' } } : {})
    }
  }

  protected override buildReasoningControls(reasoningEnabled: boolean | undefined): Record<string, unknown> | undefined {
    if (typeof reasoningEnabled !== 'boolean') return undefined

    return {
      reasoning: {
        enabled: reasoningEnabled
      }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 15_000
      })

      // OpenRouter returns all available models — no prefix filter
      const models: string[] = (response.data?.data || [])
        .map((m: { id: string }) => m.id)
        .sort()

      return models
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to list OpenRouter models: ${msg}`, { cause: err })
    }
  }
}

registerProvider({
  name: 'openrouter',
  displayName: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  factory: (settings) => new OpenRouterProvider(settings.apiKey, settings.baseUrl)
})
