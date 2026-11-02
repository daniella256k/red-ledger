import axios from 'axios'
import {
  BaseLLMProvider,
  readContextLength,
  type ProviderSendOptions,
  type AbortHandle
} from './base'
import { LOCAL_SERVER_STREAM_TIMEOUT_MS, OpenAIProvider } from './openai'
import { registerProvider } from './registry'
import type { ProviderSettings } from '../../../src/types'

/**
 * The OpenAI-compatible endpoint root. A URL saved for LM Studio's native API
 * (`/api/v1`, used by the removed "LM Studio Endpoints" mode) is pointed at it too.
 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/api/v1')) return trimmed.replace(/\/api\/v1$/, '/v1')
  if (trimmed.endsWith('/v1')) return trimmed
  return `${trimmed}/v1`
}

/** Server root without the /v1 suffix. */
function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** LM Studio through its OpenAI-compatible endpoints, which support tools. */
export class LMStudioProvider extends BaseLLMProvider {
  private provider: OpenAIProvider

  constructor(settings: ProviderSettings) {
    const baseUrl = normalizeBaseUrl(settings.baseUrl)
    super('', baseUrl)
    this.provider = new OpenAIProvider('', baseUrl, { streamTimeoutMs: LOCAL_SERVER_STREAM_TIMEOUT_MS })
  }

  sendStreaming(options: ProviderSendOptions): AbortHandle {
    return this.provider.sendStreaming(options)
  }

  listModels(): Promise<string[]> {
    return this.provider.listModels()
  }

  /** LM Studio's REST API reports the loaded window; fall back to the OpenAI listing. */
  override async getContextLength(model: string): Promise<number | null> {
    try {
      const response = await axios.get(
        `${serverRoot(this.baseUrl)}/api/v0/models/${encodeURIComponent(model)}`,
        { timeout: 10_000 }
      )
      const fromRest = readContextLength(response.data)
      if (fromRest) return fromRest
    } catch {
      // Older or newer servers without this endpoint.
    }
    return this.provider.getContextLength(model)
  }
}

registerProvider({
  name: 'lmstudio',
  displayName: 'LM Studio',
  defaultBaseUrl: 'http://localhost:1234',
  factory: (settings) => new LMStudioProvider(settings)
})
