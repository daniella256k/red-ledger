import type { ContextUsage, ReasoningEcho, StreamChunk } from '../../../src/types'

export type { ReasoningEcho }

/**
 * JSON Schema for a tool's arguments. Built-in tools use the simple
 * properties/required shape; MCP tools pass the server's schema through
 * unchanged, so any other JSON Schema keywords are allowed too.
 */
export interface ToolParametersSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [keyword: string]: unknown
}

/**
 * Tool definition in OpenAI function-calling format.
 * All providers receive tools in this shape; non-supporting providers
 * (e.g. Ollama without tool support) simply ignore them.
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolParametersSchema
  }
}

/**
 * A single message in the LLM conversation history.
 * Extends beyond the renderer's simple {role, content} to include
 * the tool_calls / tool_call_id fields needed for multi-round tool use.
 */
export interface LLMMessage extends ReasoningEcho {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: LLMMessageContent | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string // JSON string
    }
  }>
  tool_call_id?: string
}

/**
 * What a provider streams: the chunks the renderer sees, plus the reasoning
 * echo, which stays in the main process.
 */
export type ProviderChunk = StreamChunk | { type: 'reasoning_echo'; reasoning: ReasoningEcho }

export interface LLMTextContentPart {
  type: 'text'
  text: string
}

export interface LLMImageUrlContentPart {
  type: 'image_url'
  image_url: {
    url: string
  }
}

export type LLMMessageContent =
  | string
  | Array<LLMTextContentPart | LLMImageUrlContentPart>

export interface ProviderSendOptions {
  messages: LLMMessage[]
  model: string
  tools: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  reasoningEnabled?: boolean
  extraBody?: Record<string, unknown>
  /**
   * Stable id for the chat. Servers that route by it send the chat's requests
   * to a machine whose prompt cache already holds the chat so far, and it
   * marks requests worth caching at all (a title request has none).
   */
  cacheKey?: string
  /**
   * The context window set for this model (local servers). Unset leaves the
   * server's own setting in place.
   */
  contextWindow?: number
  onChunk: (chunk: ProviderChunk) => void
}

/**
 * What a model can do, as its server reports it. Undefined means the server
 * didn't say (older servers, or providers that don't report it).
 */
export interface ModelCapabilities {
  tools?: boolean
  vision?: boolean
}

/** A model's context window (null when unknown) and capabilities, from one lookup. */
export interface ModelInfo {
  contextLength: number | null
  capabilities: ModelCapabilities
}

export interface AbortHandle {
  abort: () => void
}

/** Shown when a reply stops because it hit the output token limit. */
export const TRUNCATED_REPLY_NOTICE =
  'The reply was cut off because it reached the max tokens limit. Raise or turn off Max Tokens in Settings for longer replies.'

/** Shown when a local server stopped a reply because the model's context window was full. */
export const CONTEXT_FULL_NOTICE =
  "The reply was cut off because the model's context window is full. Set a bigger context window for this model in Settings, or compact the chat."

function countOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * A 'usage' chunk for counts the provider reported; LlmService fills in the
 * context window. Prompt cache counts are kept only when the provider sent them.
 */
export function reportedUsageChunk(
  promptTokens: unknown,
  completionTokens: unknown,
  cache: { cachedTokens?: unknown; cacheWriteTokens?: unknown } = {}
): StreamChunk | null {
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens <= 0) return null
  const cachedTokens = countOrUndefined(cache.cachedTokens)
  const cacheWriteTokens = countOrUndefined(cache.cacheWriteTokens)
  const usage: ContextUsage = {
    promptTokens,
    completionTokens: typeof completionTokens === 'number' && Number.isFinite(completionTokens) ? completionTokens : 0,
    contextLength: null,
    estimated: false,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {})
  }
  return { type: 'usage', usage }
}

const CONTEXT_LENGTH_FIELDS = [
  'loaded_context_length',
  'context_length',
  'max_model_len',
  'context_window',
  'max_context_length'
]

/**
 * Context window from a model listing entry. Servers name it differently
 * (OpenRouter: context_length, vLLM: max_model_len, LM Studio:
 * loaded_context_length / max_context_length); the loaded window wins over
 * the model's maximum.
 */
export function readContextLength(entry: unknown): number | null {
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>

  const loaded = Array.isArray(record.loaded_instances) ? record.loaded_instances[0] : undefined
  const loadedConfig = loaded && typeof loaded === 'object'
    ? (loaded as Record<string, unknown>).config
    : undefined
  const candidates = [
    loadedConfig && typeof loadedConfig === 'object'
      ? (loadedConfig as Record<string, unknown>).context_length
      : undefined,
    ...CONTEXT_LENGTH_FIELDS.map((field) => record[field])
  ]

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return null
}

/**
 * Abstract base class for all LLM providers.
 * Subclasses implement streaming and model listing
 * for their specific API format.
 */
export abstract class BaseLLMProvider {
  protected apiKey: string
  protected baseUrl: string

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/+$/, '') // trim trailing slashes
  }

  /**
   * Start a streaming completion request.
   * Returns an AbortHandle that can cancel the in-flight request.
   * Chunks are delivered via the onChunk callback.
   * The implementation MUST send a final { type: 'done' } chunk
   * when the stream completes normally.
   */
  abstract sendStreaming(options: ProviderSendOptions): AbortHandle

  /**
   * Fetch the list of available models from this provider.
   */
  abstract listModels(): Promise<string[]>

  /**
   * The model's context window in tokens, or null when the server doesn't say.
   * Only used for the chat's context meter, so failures resolve to null.
   */
  async getContextLength(_model: string): Promise<number | null> {
    return null
  }

  /**
   * The context window plus what the model can do. Failures resolve to
   * unknowns: the request then goes out as it would without the lookup.
   */
  async getModelInfo(model: string): Promise<ModelInfo> {
    return { contextLength: await this.getContextLength(model).catch(() => null), capabilities: {} }
  }
}
