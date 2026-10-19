import type { ContextUsage, StreamChunk } from '../../../src/types'

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
export interface LLMMessage {
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
  onChunk: (chunk: StreamChunk) => void
}

export interface AbortHandle {
  abort: () => void
}

/** Shown when a reply stops because it hit the output token limit. */
export const TRUNCATED_REPLY_NOTICE =
  'The reply was cut off because it reached the max tokens limit. Raise or turn off Max Tokens in Settings for longer replies.'

/** A 'usage' chunk for counts the provider reported; LlmService fills in the context window. */
export function reportedUsageChunk(promptTokens: unknown, completionTokens: unknown): StreamChunk | null {
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens) || promptTokens <= 0) return null
  const usage: ContextUsage = {
    promptTokens,
    completionTokens: typeof completionTokens === 'number' && Number.isFinite(completionTokens) ? completionTokens : 0,
    contextLength: null,
    estimated: false
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
}
