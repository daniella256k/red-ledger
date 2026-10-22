import axios, { AxiosResponse } from 'axios'
import {
  BaseLLMProvider,
  TRUNCATED_REPLY_NOTICE,
  readContextLength,
  reportedUsageChunk,
  type ProviderSendOptions,
  type AbortHandle,
  type ReasoningEcho
} from './base'
import { registerProvider } from './registry'
import type { StreamChunk, ToolCall } from '../../../src/types'

const MAX_429_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 30_000

function extractThinkingText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractThinkingText(item)).join('')
  }

  if (!value || typeof value !== 'object') {
    return ''
  }

  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.content === 'string') return record.content
  if (typeof record.reasoning === 'string') return record.reasoning
  if (typeof record.reasoning_content === 'string') return record.reasoning_content
  if (typeof record.thinking === 'string') return record.thinking

  return ''
}

function extractThinkingDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return ''

  const record = delta as Record<string, unknown>
  const candidates = [
    extractThinkingText(record.reasoning_content),
    extractThinkingText(record.reasoning),
    extractThinkingText(record.thinking),
    extractThinkingText(record.reasoning_details)
  ]

  for (const candidate of candidates) {
    if (candidate) return candidate
  }
  return ''
}

/**
 * Collects a reply's reasoning as it streams, in the server's own fields, so
 * it can go back with the reply's tool calls (see ReasoningEcho).
 */
export class ReasoningCollector {
  private details: Array<Record<string, unknown>> = []
  private content = ''
  private text = ''

  add(delta: unknown): void {
    if (!delta || typeof delta !== 'object') return
    const record = delta as Record<string, unknown>
    if (Array.isArray(record.reasoning_details)) {
      for (const item of record.reasoning_details) this.addDetail(item)
    }
    if (typeof record.reasoning_content === 'string') this.content += record.reasoning_content
    if (typeof record.reasoning === 'string') this.text += record.reasoning
  }

  /**
   * OpenRouter's structured blocks when it sent them (it also sends a plain
   * `reasoning` copy, which isn't needed then), otherwise the plain field the
   * server used. Null when the reply had no reasoning.
   */
  echo(): ReasoningEcho | null {
    if (this.details.length > 0) return { reasoning_details: this.details }
    if (this.content) return { reasoning_content: this.content }
    if (this.text) return { reasoning: this.text }
    return null
  }

  /** A streamed block arrives in pieces that share its index; their text is joined. */
  private addDetail(item: unknown): void {
    if (!item || typeof item !== 'object') return
    const piece = item as Record<string, unknown>
    const block = typeof piece.index === 'number'
      ? this.details.find((detail) => detail.index === piece.index && detail.type === piece.type)
      : undefined
    if (!block) {
      this.details.push({ ...piece })
      return
    }
    for (const [key, value] of Object.entries(piece)) {
      if (value === null || value === undefined) continue
      const joinsText = TEXT_DETAIL_FIELDS.has(key) && typeof block[key] === 'string' && typeof value === 'string'
      block[key] = joinsText ? `${block[key] as string}${value}` : value
    }
  }
}

/** Fields of a streamed reasoning block that arrive as text fragments. */
const TEXT_DETAIL_FIELDS = new Set(['text', 'summary', 'data'])

function getHeaderValue(headers: unknown, headerName: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined

  const candidate = headers as {
    get?: (name: string) => string | undefined
    [key: string]: unknown
  }

  if (typeof candidate.get === 'function') {
    const viaGetter = candidate.get(headerName)
    if (typeof viaGetter === 'string' && viaGetter.trim()) return viaGetter.trim()
  }

  for (const [key, value] of Object.entries(candidate)) {
    if (key.toLowerCase() !== headerName.toLowerCase()) continue
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }

  return undefined
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined

  const asSeconds = Number(value)
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.ceil(asSeconds * 1000)
  }

  const asDate = Date.parse(value)
  if (!Number.isNaN(asDate)) {
    const deltaMs = asDate - Date.now()
    if (deltaMs > 0) return deltaMs
  }

  return undefined
}

function computeBackoffMs(attempt: number): number {
  const exponential = BASE_RETRY_DELAY_MS * (2 ** attempt)
  return Math.min(exponential, MAX_RETRY_DELAY_MS)
}

/** Optional request fields some OpenAI-compatible servers reject with a 400. */
const OPTIONAL_BODY_FIELDS = ['reasoning_effort', 'reasoning', 'stream_options']

function removeOptionalControls(body: Record<string, unknown>): Record<string, unknown> | null {
  let changed = false
  const nextBody: Record<string, unknown> = { ...body }

  for (const field of OPTIONAL_BODY_FIELDS) {
    if (field in nextBody) {
      delete nextBody[field]
      changed = true
    }
  }

  return changed ? nextBody : null
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new Error('Request aborted'))
    }

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }

    if (signal.aborted) {
      onAbort()
      return
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * OpenAI-compatible streaming provider.
 * Handles SSE (Server-Sent Events) format from /chat/completions with stream: true.
 * Also handles incremental tool_call deltas where arguments arrive as partial
 * JSON strings across multiple chunks.
 */
export interface OpenAIProviderOptions {
  /**
   * Request field for the output token limit. OpenAI's own API uses
   * max_completion_tokens (its reasoning models reject max_tokens); most
   * OpenAI-compatible servers, OpenRouter included, read max_tokens.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
}

export class OpenAIProvider extends BaseLLMProvider {
  private readonly maxTokensField: NonNullable<OpenAIProviderOptions['maxTokensField']>

  constructor(apiKey: string, baseUrl: string = 'https://api.openai.com/v1', options: OpenAIProviderOptions = {}) {
    super(apiKey, baseUrl)
    this.maxTokensField = options.maxTokensField ?? 'max_tokens'
  }

  protected getAuthHeaders(): Record<string, string> {
    const apiKey = this.apiKey.trim()
    return apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
  }

  protected buildReasoningControls(reasoningEnabled: boolean | undefined): Record<string, unknown> | undefined {
    if (reasoningEnabled !== false) return undefined

    // OpenAI-compatible endpoints that support this field can lower/disable
    // explicit reasoning traces; endpoints that reject it are retried without it.
    return { reasoning_effort: 'none' }
  }

  sendStreaming(options: ProviderSendOptions): AbortHandle {
    const controller = new AbortController()

    this._stream(options, controller).catch((err) => {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        options.onChunk({ type: 'error', error: message })
      } else {
        // Ensure orchestrators waiting on chunks always receive a terminal signal.
        options.onChunk({ type: 'done' })
      }
    })

    return { abort: () => controller.abort() }
  }

  private async _stream(options: ProviderSendOptions, controller: AbortController): Promise<void> {
    const { messages, model, tools, temperature, maxTokens, reasoningEnabled, extraBody, onChunk } = options

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      // Final chunk reports token counts for the context meter.
      stream_options: { include_usage: true },
      // Left out unless set, so the model's own default applies.
      ...(temperature !== undefined ? { temperature } : {})
    }

    const reasoningControls = this.buildReasoningControls(reasoningEnabled)
    if (reasoningControls) {
      Object.assign(body, reasoningControls)
    }

    if (extraBody && typeof extraBody === 'object') {
      Object.assign(body, extraBody)
    }

    if (maxTokens) {
      body[this.maxTokensField] = maxTokens
    }

    // Only include tools if there are any defined
    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    const throwAxiosError = async (err: unknown): Promise<never> => {
      if (axios.isAxiosError(err)) {
        // Try to extract API error message from the response body
        if (err.response?.data) {
          try {
            const chunks: Buffer[] = []
            for await (const chunk of err.response.data) {
              chunks.push(Buffer.from(chunk))
            }
            const errorBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
            const apiMessage = errorBody?.error?.message || JSON.stringify(errorBody)
            throw new Error(`API error (${err.response.status}): ${apiMessage}`)
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message.startsWith('API error')) {
              throw parseErr
            }
          }
        }
        throw new Error(`API error: ${err.message}`)
      }
      throw err
    }

    const requestStream = async (requestBody: Record<string, unknown>): Promise<AxiosResponse> => {
      for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
        try {
          return await axios.post(`${this.baseUrl}/chat/completions`, requestBody, {
            headers: {
              'Content-Type': 'application/json',
              ...this.getAuthHeaders()
            },
            responseType: 'stream',
            timeout: 120_000,
            signal: controller.signal
          })
        } catch (err) {
          const status = axios.isAxiosError(err) ? err.response?.status : undefined
          const canRetry = status === 429 && attempt < MAX_429_RETRIES && !controller.signal.aborted

          if (canRetry) {
            const retryAfterHeader = getHeaderValue(
              (err as { response?: { headers?: unknown } }).response?.headers,
              'retry-after'
            )
            const retryDelayMs = parseRetryAfterMs(retryAfterHeader) ?? computeBackoffMs(attempt)
            await sleep(retryDelayMs, controller.signal)
            continue
          }

          throw err
        }
      }

      throw new Error('API request failed without a response')
    }

    let response: AxiosResponse | null = null

    try {
      response = await requestStream(body)
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined
      const fallbackBody = status === 400 ? removeOptionalControls(body) : null

      if (fallbackBody) {
        try {
          response = await requestStream(fallbackBody)
        } catch (retryErr) {
          await throwAxiosError(retryErr)
        }
      } else {
        await throwAxiosError(err)
      }
    }

    if (!response) {
      throw new Error('API request failed without a response')
    }

    const stream = response.data as AsyncIterable<Buffer>

    // State for accumulating tool call deltas
    // OpenAI sends tool_calls in incremental delta chunks where the arguments
    // arrive as partial JSON strings across multiple SSE data lines.
    const pendingToolCalls: Map<number, {
      id: string
      name: string
      arguments: string
    }> = new Map()

    let buffer = ''
    let truncated = false
    const reasoning = new ReasoningCollector()

    const finish = () => {
      this._flushToolCalls(pendingToolCalls, onChunk)
      if (truncated) onChunk({ type: 'notice', content: TRUNCATED_REPLY_NOTICE })
      const echo = reasoning.echo()
      if (echo) onChunk({ type: 'reasoning_echo', reasoning: echo })
      onChunk({ type: 'done' })
    }

    for await (const chunk of stream) {
      if (controller.signal.aborted) break

      buffer += chunk.toString('utf-8')

      // Process complete SSE lines
      const lines = buffer.split('\n')
      // Keep the last potentially incomplete line
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()

        if (!trimmed || trimmed.startsWith(':')) continue // SSE comment or empty
        if (trimmed === 'data: [DONE]') {
          finish()
          return
        }

        if (!trimmed.startsWith('data: ')) continue

        try {
          const data = JSON.parse(trimmed.slice(6))

          // With include_usage the last chunk carries usage and an empty choices array.
          if (data.usage) {
            const usageChunk = reportedUsageChunk(data.usage.prompt_tokens, data.usage.completion_tokens)
            if (usageChunk) onChunk(usageChunk)
          }

          const choice = data.choices?.[0]
          if (!choice) continue

          const delta = choice.delta
          reasoning.add(delta)

          const thinking = extractThinkingDelta(delta)
          if (thinking) {
            onChunk({ type: 'thinking', content: thinking })
          }

          // Text content
          if (delta?.content) {
            onChunk({ type: 'text', content: delta.content })
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0

              if (!pendingToolCalls.has(idx)) {
                // First delta for this tool call — has the id and function name
                pendingToolCalls.set(idx, {
                  id: tc.id || `tool_${idx}`,
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || ''
                })
              } else {
                // Subsequent delta — accumulate arguments
                const existing = pendingToolCalls.get(idx)!
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments
                }
                if (tc.function?.name) {
                  existing.name = tc.function.name
                }
              }
            }
          }

          // Check finish reason
          if (choice.finish_reason === 'tool_calls' && pendingToolCalls.size > 0) {
            this._flushToolCalls(pendingToolCalls, onChunk)
          }
          if (choice.finish_reason === 'length') {
            truncated = true
          }

        } catch {
          // Skip malformed SSE lines — this is common during streaming
        }
      }
    }

    // If we exited the loop without a [DONE], finish cleanly.
    if (controller.signal.aborted) {
      onChunk({ type: 'done' })
      return
    }

    finish()
  }

  /**
   * Flush accumulated tool call deltas, emitting them as tool_call chunks.
   * Each pending tool call has its arguments parsed from the accumulated JSON string.
   */
  private _flushToolCalls(
    pending: Map<number, { id: string; name: string; arguments: string }>,
    onChunk: (chunk: StreamChunk) => void
  ): void {
    for (const [, tc] of pending) {
      let parsedArgs: Record<string, unknown>
      try {
        parsedArgs = JSON.parse(tc.arguments)
      } catch {
        // If arguments don't parse, pass them as-is in a wrapper
        parsedArgs = { _raw: tc.arguments }
      }

      const toolCall: ToolCall = {
        id: tc.id,
        name: tc.name,
        arguments: parsedArgs
      }

      onChunk({ type: 'tool_call', toolCall })
    }
    pending.clear()
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: this.getAuthHeaders(),
        timeout: 15_000
      })

      const models: string[] = (response.data?.data || [])
        .map((m: { id: string }) => m.id)
        .sort()

      return models
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to list models: ${msg}`, { cause: err })
    }
  }

  /** Read from the /models listing; OpenAI itself doesn't report it, OpenRouter and vLLM do. */
  override async getContextLength(model: string): Promise<number | null> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: this.getAuthHeaders(),
        timeout: 15_000
      })
      const entries: unknown[] = Array.isArray(response.data?.data) ? response.data.data : []
      const entry = entries.find((item) =>
        Boolean(item) && typeof item === 'object' && (item as { id?: unknown }).id === model
      )
      return readContextLength(entry)
    } catch {
      return null
    }
  }
}

registerProvider({
  name: 'openai',
  displayName: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  factory: (settings) => new OpenAIProvider(settings.apiKey, settings.baseUrl, { maxTokensField: 'max_completion_tokens' })
})
