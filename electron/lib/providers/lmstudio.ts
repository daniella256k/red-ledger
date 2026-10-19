import axios, { type AxiosResponse } from 'axios'
import {
  BaseLLMProvider,
  TRUNCATED_REPLY_NOTICE,
  readContextLength,
  reportedUsageChunk,
  type ProviderSendOptions,
  type AbortHandle,
  type LLMMessageContent
} from './base'
import { OpenAIProvider } from './openai'
import { registerProvider } from './registry'
import type { LMStudioCompatibility, ProviderSettings } from '../../../src/types'

function normalizeBaseUrl(baseUrl: string, compatibility: LMStudioCompatibility): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (compatibility === 'openai') {
    if (trimmed.endsWith('/v1')) return trimmed
    if (trimmed.endsWith('/api/v1')) return trimmed.replace(/\/api\/v1$/, '/v1')
    return `${trimmed}/v1`
  }

  if (trimmed.endsWith('/api/v1')) return trimmed
  if (trimmed.endsWith('/v1')) return trimmed.replace(/\/v1$/, '/api/v1')
  return `${trimmed}/api/v1`
}

/** Server root without the /v1 or /api/v1 suffix. */
function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/(\/api)?\/v1$/, '')
}

function parseCompatibility(settings: ProviderSettings): LMStudioCompatibility {
  return settings.compatibility === 'lmstudio' ? 'lmstudio' : 'openai'
}

function extractModelId(model: unknown): string | null {
  if (!model || typeof model !== 'object') return null

  const record = model as Record<string, unknown>
  const id = record.id ?? record.model_id ?? record.model ?? record.name
  return typeof id === 'string' && id.trim().length > 0 ? id : null
}

function toPlainTextContent(content: LLMMessageContent | null): string {
  if (typeof content === 'string') return content
  if (!content) return ''

  const textParts: string[] = []
  let imageCount = 0

  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.trim().length > 0) {
        textParts.push(part.text)
      }
      continue
    }
    imageCount++
  }

  if (imageCount > 0) {
    textParts.push(`[${imageCount} image attachment${imageCount === 1 ? '' : 's'} omitted for this provider]`)
  }

  return textParts.join('\n\n')
}

class LMStudioNativeProvider extends BaseLLMProvider {
  constructor(baseUrl: string) {
    super('', baseUrl)
  }

  sendStreaming(options: ProviderSendOptions): AbortHandle {
    const controller = new AbortController()

    this._stream(options, controller).catch((err) => {
      if (!controller.signal.aborted) {
        let message = err instanceof Error ? err.message : String(err)
        if (message.includes('ECONNREFUSED')) {
          message = 'Cannot reach LM Studio. Is its local server running?'
        }
        options.onChunk({ type: 'error', error: message })
      }
      options.onChunk({ type: 'done' })
    })

    return { abort: () => controller.abort() }
  }

  private emitParsedChunk(
    payload: Record<string, unknown>,
    onChunk: ProviderSendOptions['onChunk']
  ): boolean {
    const choice = Array.isArray(payload.choices)
      ? payload.choices[0] as Record<string, unknown> | undefined
      : undefined
    const delta = choice?.delta as Record<string, unknown> | undefined
    const message = payload.message as Record<string, unknown> | undefined

    const content =
      (typeof delta?.content === 'string' ? delta.content : undefined)
      ?? (typeof message?.content === 'string' ? message.content : undefined)
      ?? (typeof payload.content === 'string' ? payload.content : undefined)

    if (content) {
      onChunk({ type: 'text', content })
    }

    const usage = payload.usage as Record<string, unknown> | undefined
    if (usage) {
      const usageChunk = reportedUsageChunk(usage.prompt_tokens, usage.completion_tokens)
      if (usageChunk) onChunk(usageChunk)
    }

    if (choice?.finish_reason === 'length') {
      onChunk({ type: 'notice', content: TRUNCATED_REPLY_NOTICE })
    }

    const done = payload.done === true
      || choice?.finish_reason === 'stop'
      || choice?.finish_reason === 'length'
    return done
  }

  private async _stream(options: ProviderSendOptions, controller: AbortController): Promise<void> {
    const { messages, model, temperature, maxTokens, reasoningEnabled, onChunk } = options

    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: toPlainTextContent(m.content)
      })),
      stream: true,
      temperature: temperature ?? 0.7
    }

    if (maxTokens) {
      body.max_tokens = maxTokens
    }

    if (typeof reasoningEnabled === 'boolean') {
      body.reasoning = reasoningEnabled ? 'on' : 'off'
    }

    let response: AxiosResponse
    try {
      response = await axios.post(`${this.baseUrl}/chat`, body, {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 300_000,
        signal: controller.signal
      })
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined
      const canRetryWithoutReasoning = status === 400 && Object.prototype.hasOwnProperty.call(body, 'reasoning')

      if (!canRetryWithoutReasoning) {
        throw err
      }

      const fallbackBody = { ...body }
      delete fallbackBody.reasoning

      response = await axios.post(`${this.baseUrl}/chat`, fallbackBody, {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 300_000,
        signal: controller.signal
      })
    }

    const stream = response.data as AsyncIterable<Buffer>
    let buffer = ''

    for await (const chunk of stream) {
      if (controller.signal.aborted) break

      buffer += chunk.toString('utf-8')
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || line.startsWith(':')) continue

        if (line === 'data: [DONE]') {
          onChunk({ type: 'done' })
          return
        }

        const payloadText = line.startsWith('data: ')
          ? line.slice(6)
          : line

        try {
          const payload = JSON.parse(payloadText) as Record<string, unknown>
          const done = this.emitParsedChunk(payload, onChunk)
          if (done) {
            onChunk({ type: 'done' })
            return
          }
        } catch {
          // Ignore malformed stream chunks
        }
      }
    }

    onChunk({ type: 'done' })
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, { timeout: 10_000 })

      const raw = response.data as Record<string, unknown>
      const list = Array.isArray(raw.data)
        ? raw.data
        : Array.isArray(raw.models)
          ? raw.models
          : []

      return list
        .map(extractModelId)
        .filter((id): id is string => Boolean(id))
        .sort()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ECONNREFUSED')) {
        throw new Error('Cannot reach LM Studio. Is its local server running?')
      }
      throw new Error(`Failed to list LM Studio models: ${msg}`)
    }
  }

  override async getContextLength(model: string): Promise<number | null> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, { timeout: 10_000 })
      const raw = response.data as Record<string, unknown>
      const list: unknown[] = Array.isArray(raw.data)
        ? raw.data
        : Array.isArray(raw.models)
          ? raw.models
          : []
      return readContextLength(list.find((entry) => extractModelId(entry) === model))
    } catch {
      return null
    }
  }
}

export class LMStudioProvider extends BaseLLMProvider {
  private provider: BaseLLMProvider

  constructor(settings: ProviderSettings) {
    const compatibility = parseCompatibility(settings)
    const baseUrl = normalizeBaseUrl(settings.baseUrl, compatibility)
    super('', baseUrl)

    this.provider = compatibility === 'openai'
      ? new OpenAIProvider('', baseUrl)
      : new LMStudioNativeProvider(baseUrl)
  }

  sendStreaming(options: ProviderSendOptions): AbortHandle {
    return this.provider.sendStreaming(options)
  }

  listModels(): Promise<string[]> {
    return this.provider.listModels()
  }

  /** The REST API reports the loaded window in either compatibility mode; fall back to the mode's own listing. */
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
