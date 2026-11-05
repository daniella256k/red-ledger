import axios from 'axios'
import {
  BaseLLMProvider,
  readContextLength,
  type ProviderSendOptions,
  type AbortHandle,
  type ModelCapabilities,
  type ModelInfo
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

/** A model in LM Studio's REST listing (GET /api/v1/models, LM Studio 0.4+). */
interface RestModel {
  key?: unknown
  selected_variant?: unknown
  variants?: unknown
  loaded_instances?: unknown
  capabilities?: { vision?: unknown; trained_for_tool_use?: unknown }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The listing entry for a model id: its key, or one of its variants. */
function findRestModel(data: unknown, model: string): RestModel | undefined {
  const models = isRecord(data) && Array.isArray(data.models) ? data.models : []
  return models.find((entry): entry is RestModel => isRecord(entry) && (
    entry.key === model
    || entry.selected_variant === model
    || (Array.isArray(entry.variants) && entry.variants.includes(model))
  ))
}

function loadedInstances(entry: RestModel): unknown[] {
  return Array.isArray(entry.loaded_instances) ? entry.loaded_instances : []
}

/** The message in an LM Studio error response. */
function restErrorMessage(err: unknown): string {
  const data = axios.isAxiosError(err) ? err.response?.data as unknown : undefined
  if (isRecord(data)) {
    const error = data.error
    if (typeof error === 'string') return error
    if (isRecord(error) && typeof error.message === 'string') return error.message
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Loads waiting to finish, by server and model, so two chats starting at
 * once don't load the model twice.
 */
const loadsInFlight = new Map<string, Promise<void>>()

/** LM Studio through its OpenAI-compatible endpoints, which support tools. */
export class LMStudioProvider extends BaseLLMProvider {
  private provider: OpenAIProvider

  constructor(settings: ProviderSettings) {
    const baseUrl = normalizeBaseUrl(settings.baseUrl)
    super('', baseUrl)
    this.provider = new OpenAIProvider('', baseUrl, { streamTimeoutMs: LOCAL_SERVER_STREAM_TIMEOUT_MS })
  }

  /**
   * With a context window set, a model LM Studio hasn't loaded yet is loaded
   * with it first. A model already loaded is used as it is, whatever window
   * it was loaded with.
   */
  sendStreaming(options: ProviderSendOptions): AbortHandle {
    const { contextWindow } = options
    if (!contextWindow) return this.provider.sendStreaming(options)

    let stopped = false
    let inner: AbortHandle | null = null
    this.loadIfNotLoaded(options.model, contextWindow).then(
      () => {
        if (stopped) options.onChunk({ type: 'done' })
        else inner = this.provider.sendStreaming(options)
      },
      (err: unknown) => {
        if (stopped) options.onChunk({ type: 'done' })
        else options.onChunk({ type: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    )
    return {
      abort: () => {
        stopped = true
        inner?.abort()
      }
    }
  }

  private loadIfNotLoaded(model: string, contextWindow: number): Promise<void> {
    const key = `${this.baseUrl}|${model}`
    const running = loadsInFlight.get(key)
    if (running) return running
    const load = this.load(model, contextWindow).finally(() => loadsInFlight.delete(key))
    loadsInFlight.set(key, load)
    return load
  }

  private async load(model: string, contextWindow: number): Promise<void> {
    const root = serverRoot(this.baseUrl)
    let entry: RestModel | undefined
    try {
      const response = await axios.get(`${root}/api/v1/models`, { timeout: 10_000 })
      entry = findRestModel(response.data, model)
    } catch {
      // No REST API (LM Studio before 0.4): LM Studio loads the model on its own.
      return
    }
    // Unknown to the listing, or loaded already: the request goes out as it is.
    if (!entry || loadedInstances(entry).length > 0) return

    try {
      await axios.post(
        `${root}/api/v1/models/load`,
        { model, context_length: contextWindow },
        { timeout: LOCAL_SERVER_STREAM_TIMEOUT_MS }
      )
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return
      throw new Error(`LM Studio couldn't load ${model} with a ${contextWindow} token context window: ${restErrorMessage(err)}`, { cause: err })
    }
  }

  listModels(): Promise<string[]> {
    return this.provider.listModels()
  }

  /** LM Studio's REST API reports the loaded window; fall back to the OpenAI listing. */
  override async getContextLength(model: string): Promise<number | null> {
    return (await this.getModelInfo(model)).contextLength
  }

  /**
   * From LM Studio's REST listing (0.4+): the window of the loaded copy
   * (unknown while the model isn't loaded: LM Studio picks it at load time),
   * whether the model takes images, and whether it was trained for tools.
   * Older servers: the window from the v0 API or the OpenAI listing.
   */
  override async getModelInfo(model: string): Promise<ModelInfo> {
    const root = serverRoot(this.baseUrl)
    try {
      const response = await axios.get(`${root}/api/v1/models`, { timeout: 10_000 })
      const entry = findRestModel(response.data, model)
      if (entry) {
        const loaded = loadedInstances(entry)[0]
        const config = isRecord(loaded) ? loaded.config : undefined
        const contextLength = isRecord(config) && typeof config.context_length === 'number' && config.context_length > 0
          ? config.context_length
          : null
        const reported = isRecord(entry.capabilities) ? entry.capabilities : {}
        const capabilities: ModelCapabilities = {
          ...(typeof reported.vision === 'boolean' ? { vision: reported.vision } : {}),
          ...(typeof reported.trained_for_tool_use === 'boolean' ? { tools: reported.trained_for_tool_use } : {})
        }
        return { contextLength, capabilities }
      }
    } catch {
      // Older servers without the v1 REST API.
    }

    try {
      const response = await axios.get(
        `${root}/api/v0/models/${encodeURIComponent(model)}`,
        { timeout: 10_000 }
      )
      const data = response.data as { type?: unknown; state?: unknown } | undefined
      // The v0 API's window is the model's maximum until it is loaded.
      const fromRest = data?.state === 'loaded' ? readContextLength(data) : null
      const capabilities: ModelCapabilities = data?.type === 'vlm' ? { vision: true } : data?.type === 'llm' ? { vision: false } : {}
      if (fromRest || data?.type) return { contextLength: fromRest, capabilities }
    } catch {
      // Older or newer servers without this endpoint.
    }
    return { contextLength: await this.provider.getContextLength(model), capabilities: {} }
  }
}

registerProvider({
  name: 'lmstudio',
  displayName: 'LM Studio',
  defaultBaseUrl: 'http://localhost:1234',
  factory: (settings) => new LMStudioProvider(settings)
})
