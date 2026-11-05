import axios, { AxiosResponse } from 'axios'
import { randomUUID } from 'crypto'
import {
  BaseLLMProvider,
  TRUNCATED_REPLY_NOTICE,
  readContextLength,
  reportedUsageChunk,
  type ProviderSendOptions,
  type AbortHandle,
  type ModelInfo,
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

/**
 * Optional request fields some servers or models reject with a 400, in the
 * groups they are left out in. A rejected request is retried without one
 * group at a time: first a group the error message names, otherwise in this
 * order, so the prompt caching hints (which save the most) go last. One
 * rejected setting never takes the others with it: a model that can't switch
 * reasoning off (Claude Sonnet 5.5) still gets its caching hints.
 */
interface OptionalFieldGroup {
  name: 'reasoning' | 'usage' | 'cache'
  fields: string[]
  /** Words in an error message that point at this group. */
  hints: RegExp
  /**
   * What was rejected, for remembering it: the reasoning setting by value
   * (a model may reject "off" but take "on"), the others by which fields
   * were sent (the cache key changes with every chat).
   */
  byValue: boolean
}

const OPTIONAL_FIELD_GROUPS: OptionalFieldGroup[] = [
  { name: 'reasoning', fields: ['reasoning_effort', 'reasoning'], hints: /reasoning|thinking|effort/i, byValue: true },
  { name: 'usage', fields: ['stream_options'], hints: /stream_options|include_usage/i, byValue: false },
  // Prompt caching hints (see buildCacheControls).
  { name: 'cache', fields: ['prompt_cache_key', 'session_id', 'cache_control'], hints: /cache|session_id/i, byValue: false }
]

function hasGroup(body: Record<string, unknown>, group: OptionalFieldGroup): boolean {
  return group.fields.some((field) => field in body)
}

function groupSignature(body: Record<string, unknown>, group: OptionalFieldGroup): string {
  const sent = group.fields.filter((field) => field in body)
  return `${group.name}:${JSON.stringify(group.byValue ? sent.map((field) => [field, body[field]]) : sent)}`
}

function withoutGroup(body: Record<string, unknown>, group: OptionalFieldGroup): Record<string, unknown> {
  const next = { ...body }
  for (const field of group.fields) delete next[field]
  return next
}

/** The next group to leave out after a 400: one the message names first, then in order. */
function nextGroupToDrop(body: Record<string, unknown>, errorMessage: string | null): OptionalFieldGroup | null {
  const present = OPTIONAL_FIELD_GROUPS.filter((group) => hasGroup(body, group))
  return present.find((group) => errorMessage !== null && group.hints.test(errorMessage)) ?? present[0] ?? null
}

/**
 * What each server and model rejected this session (by groupSignature), so
 * later requests leave it out at once instead of failing first every round.
 */
const rejectedFields = new Map<string, Set<string>>()
/** Models already told the user they can't switch reasoning off. */
const reasoningOffNoticeShown = new Set<string>()
const MAX_REMEMBERED_MODELS = 200

function rememberRejection(key: string, signature: string): void {
  if (!rejectedFields.has(key) && rejectedFields.size >= MAX_REMEMBERED_MODELS) rejectedFields.clear()
  const signatures = rejectedFields.get(key) ?? new Set<string>()
  signatures.add(signature)
  rejectedFields.set(key, signatures)
}

/** The body without what this server and model are known to reject, and which groups that left out. */
function withoutKnownRejections(key: string, body: Record<string, unknown>): { body: Record<string, unknown>; dropped: OptionalFieldGroup[] } {
  const known = rejectedFields.get(key)
  if (!known) return { body, dropped: [] }
  let next = body
  const dropped: OptionalFieldGroup[] = []
  for (const group of OPTIONAL_FIELD_GROUPS) {
    if (hasGroup(next, group) && known.has(groupSignature(next, group))) {
      next = withoutGroup(next, group)
      dropped.push(group)
    }
  }
  return { body: next, dropped }
}

/** Forgets what servers rejected; for tests. */
export function forgetRejectedFields(): void {
  rejectedFields.clear()
  reasoningOffNoticeShown.clear()
}

/** The message in an error response's body (read once; the body is a stream). */
const errorMessages = new WeakMap<object, Promise<string | null>>()

function apiErrorMessage(err: unknown): Promise<string | null> {
  if (!axios.isAxiosError(err) || !err.response?.data) return Promise.resolve(null)
  const cached = errorMessages.get(err)
  if (cached) return cached
  const data = err.response.data as unknown
  const read = (async () => {
    try {
      let text: string
      if (typeof data === 'string') text = data
      else if (data && typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
        const chunks: Buffer[] = []
        for await (const chunk of data as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(chunk))
        text = Buffer.concat(chunks).toString('utf-8')
      } else text = JSON.stringify(data)
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } }
        return typeof parsed?.error?.message === 'string' ? parsed.error.message : text
      } catch {
        return text
      }
    } catch {
      return null
    }
  })()
  errorMessages.set(err, read)
  return read
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
  /**
   * How long a streaming request may wait with no data (default 120s). Local
   * servers get longer, since a large prompt can take minutes to process on CPU.
   */
  streamTimeoutMs?: number
  /**
   * Send the chat's id as `prompt_cache_key`, which OpenAI uses to route a
   * chat's requests to the machine that has its prompt cached. Only for
   * OpenAI itself: other servers don't know the field.
   */
  promptCacheKey?: boolean
}

/** Matches Ollama and LM Studio's native mode. */
export const LOCAL_SERVER_STREAM_TIMEOUT_MS = 300_000

export class OpenAIProvider extends BaseLLMProvider {
  private readonly maxTokensField: NonNullable<OpenAIProviderOptions['maxTokensField']>
  private readonly streamTimeoutMs: number
  private readonly promptCacheKey: boolean

  constructor(apiKey: string, baseUrl: string = 'https://api.openai.com/v1', options: OpenAIProviderOptions = {}) {
    super(apiKey, baseUrl)
    this.maxTokensField = options.maxTokensField ?? 'max_tokens'
    this.streamTimeoutMs = options.streamTimeoutMs ?? 120_000
    this.promptCacheKey = options.promptCacheKey === true
  }

  /**
   * Request fields that help the server reuse its prompt cache for a chat.
   * Requests without a cache key (chat titles) get none. A server that
   * rejects them is retried without them.
   */
  protected buildCacheControls(_model: string, cacheKey: string | undefined): Record<string, unknown> | undefined {
    if (!cacheKey || !this.promptCacheKey) return undefined
    return { prompt_cache_key: cacheKey }
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
    const { messages, model, tools, temperature, maxTokens, reasoningEnabled, extraBody, cacheKey, onChunk } = options

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

    const cacheControls = this.buildCacheControls(model, cacheKey)
    if (cacheControls) {
      Object.assign(body, cacheControls)
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
        // The API's own message from the response body, when it sent one.
        const apiMessage = await apiErrorMessage(err)
        if (apiMessage && err.response) throw new Error(`API error (${err.response.status}): ${apiMessage}`)
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
            timeout: this.streamTimeoutMs,
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

    // Leave out what this server and model already rejected this session; on
    // a 400, leave out one more optional group and try again (see
    // OPTIONAL_FIELD_GROUPS). The group whose removal got the request
    // through is remembered.
    const rejectionKey = `${this.baseUrl}|${model}`
    const known = withoutKnownRejections(rejectionKey, body)
    let requestBody = known.body
    const dropped = [...known.dropped]
    let response: AxiosResponse | null = null
    let lastDropped: string | null = null

    while (!response) {
      try {
        response = await requestStream(requestBody)
        if (lastDropped) rememberRejection(rejectionKey, lastDropped)
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined
        const group = status === 400 && !controller.signal.aborted
          ? nextGroupToDrop(requestBody, await apiErrorMessage(err))
          : null
        // Nothing optional left to leave out: the 400 is about something else.
        if (!group) return throwAxiosError(err)
        lastDropped = groupSignature(requestBody, group)
        requestBody = withoutGroup(requestBody, group)
        dropped.push(group)
      }
    }

    // Asked for no reasoning, but the model can't switch it off: say so once.
    if (reasoningEnabled === false && dropped.some((group) => group.name === 'reasoning')
      && !reasoningOffNoticeShown.has(rejectionKey)) {
      reasoningOffNoticeShown.add(rejectionKey)
      onChunk({ type: 'notice', content: `${model} can't switch reasoning off, so it reasons anyway.` })
    }

    if (!response) {
      throw new Error('API request failed without a response')
    }

    const stream = response.data as AsyncIterable<Buffer | string>

    // State for accumulating tool call deltas
    // OpenAI sends tool_calls in incremental delta chunks where the arguments
    // arrive as partial JSON strings across multiple SSE data lines.
    const pendingToolCalls: Map<number, {
      id: string
      name: string
      arguments: string
    }> = new Map()

    let buffer = ''
    // A character can be split across network chunks; the decoder holds its
    // first bytes until the rest arrive instead of writing a replacement character.
    const decoder = new TextDecoder('utf-8')
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

      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })

      // Process complete SSE lines
      const lines = buffer.split('\n')
      // Keep the last potentially incomplete line
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()

        if (!trimmed || trimmed.startsWith(':')) continue // SSE comment or empty
        // SSE allows "data:" with or without a space after the colon.
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trimStart()
        if (payload === '[DONE]') {
          finish()
          return
        }

        try {
          const data = JSON.parse(payload)

          // With include_usage the last chunk carries usage and an empty choices array.
          if (data.usage) {
            // Prompt cache counts: OpenAI and OpenRouter use prompt_tokens_details;
            // DeepSeek's own API reports prompt_cache_hit_tokens.
            const details = data.usage.prompt_tokens_details
            const usageChunk = reportedUsageChunk(data.usage.prompt_tokens, data.usage.completion_tokens, {
              cachedTokens: details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens,
              cacheWriteTokens: details?.cache_write_tokens
            })
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
                // First delta for this tool call — has the id and function name.
                // Servers that send no id get a random one: an index would repeat
                // every round, and calls are matched to their results by id.
                pendingToolCalls.set(idx, {
                  id: tc.id || `call_${randomUUID()}`,
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

  /** The model's entry in the /models listing, or undefined. */
  private async findModelEntry(model: string): Promise<unknown> {
    const response = await axios.get(`${this.baseUrl}/models`, {
      headers: this.getAuthHeaders(),
      timeout: 15_000
    })
    const entries: unknown[] = Array.isArray(response.data?.data) ? response.data.data : []
    return entries.find((item) =>
      Boolean(item) && typeof item === 'object' && (item as { id?: unknown }).id === model
    )
  }

  /** Read from the /models listing; OpenAI itself doesn't report it, OpenRouter and vLLM do. */
  override async getContextLength(model: string): Promise<number | null> {
    try {
      return readContextLength(await this.findModelEntry(model))
    } catch {
      return null
    }
  }

  /**
   * One listing read for both. OpenRouter lists each model's request fields
   * (`supported_parameters`), which say whether it takes tools.
   */
  override async getModelInfo(model: string): Promise<ModelInfo> {
    try {
      const entry = await this.findModelEntry(model)
      const supported = entry && typeof entry === 'object'
        ? (entry as { supported_parameters?: unknown }).supported_parameters
        : undefined
      return {
        contextLength: readContextLength(entry),
        capabilities: Array.isArray(supported) ? { tools: supported.includes('tools') } : {}
      }
    } catch {
      return { contextLength: null, capabilities: {} }
    }
  }
}

registerProvider({
  name: 'openai',
  displayName: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  factory: (settings) => new OpenAIProvider(settings.apiKey, settings.baseUrl, { maxTokensField: 'max_completion_tokens', promptCacheKey: true })
})
