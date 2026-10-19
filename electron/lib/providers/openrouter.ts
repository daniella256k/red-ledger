import axios from 'axios'
import { OpenAIProvider } from './openai'
import { registerProvider } from './registry'

/**
 * OpenRouter provider — extends OpenAI with a different base URL.
 * The streaming format is identical (OpenAI-compatible).
 * The only difference is the models endpoint returns all models (no gpt- filter).
 */
export class OpenRouterProvider extends OpenAIProvider {
  constructor(apiKey: string, baseUrl: string = 'https://openrouter.ai/api/v1') {
    super(apiKey, baseUrl)
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
