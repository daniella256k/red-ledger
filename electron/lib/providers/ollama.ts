import axios, { type AxiosResponse } from 'axios'
import { randomUUID } from 'crypto'
import {
  BaseLLMProvider,
  TRUNCATED_REPLY_NOTICE,
  readContextLength,
  reportedUsageChunk,
  type ProviderSendOptions,
  type AbortHandle,
  type LLMMessageContent
} from './base'
import { registerProvider } from './registry'

function extractThinking(value: unknown): string {
  if (typeof value === 'string') return value

  if (Array.isArray(value)) {
    return value
      .map((item) => extractThinking(item))
      .join('')
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return extractThinking(record.text || record.content)
  }

  return ''
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

/**
 * Ollama provider - local LLM server.
 * Uses NDJSON streaming (one JSON object per line) instead of SSE.
 * No API key required. Longer timeout (300s) because first model load can be slow.
 * Tool use support depends on the specific Ollama model; we include tools when
 * definitions are provided but gracefully handle models that ignore them.
 */
export class OllamaProvider extends BaseLLMProvider {
  constructor(apiKey: string = '', baseUrl: string = 'http://localhost:11434') {
    super(apiKey, baseUrl)
  }

  sendStreaming(options: ProviderSendOptions): AbortHandle {
    const controller = new AbortController()

    this._stream(options, controller).catch((err) => {
      if (!controller.signal.aborted) {
        let message = err instanceof Error ? err.message : String(err)

        // User-friendly message for connection refused
        if (message.includes('ECONNREFUSED')) {
          message = 'Cannot reach Ollama. Is it running? (ollama serve)'
        }

        options.onChunk({ type: 'error', error: message })
      } else {
        // Ensure orchestrators waiting on chunks always receive a terminal signal.
        options.onChunk({ type: 'done' })
      }
    })

    return { abort: () => controller.abort() }
  }

  private async _stream(options: ProviderSendOptions, controller: AbortController): Promise<void> {
    const { messages, model, tools, temperature, maxTokens, reasoningEnabled, onChunk } = options

    // Convert messages to Ollama format
    // Ollama uses the same role/content structure but uses 'tool' role differently
    const ollamaMessages = messages.map((m) => {
      if (m.role === 'tool') {
        // Ollama wants tool responses as role: 'tool' with content
        return { role: 'tool' as const, content: toPlainTextContent(m.content) }
      }
      return { role: m.role, content: toPlainTextContent(m.content) }
    })

    const body: Record<string, unknown> = {
      model,
      messages: ollamaMessages,
      stream: true,
      options: {
        temperature: temperature ?? 0.7,
        // Ollama's name for the output token limit.
        ...(maxTokens ? { num_predict: maxTokens } : {})
      }
    }

    if (typeof reasoningEnabled === 'boolean') {
      body.think = reasoningEnabled
    }

    // Include tools if any are defined — newer Ollama versions support this
    if (tools.length > 0) {
      body.tools = tools
    }

    let response: AxiosResponse
    try {
      response = await axios.post(`${this.baseUrl}/api/chat`, body, {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 300_000,
        signal: controller.signal
      })
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined
      const canRetryWithoutThink = status === 400 && Object.prototype.hasOwnProperty.call(body, 'think')

      if (!canRetryWithoutThink) {
        throw err
      }

      const fallbackBody = { ...body }
      delete fallbackBody.think

      response = await axios.post(`${this.baseUrl}/api/chat`, fallbackBody, {
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

      // Ollama sends NDJSON — one JSON object per line
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // keep last incomplete line

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const data = JSON.parse(trimmed)

          const thinking = extractThinking(data.message?.thinking)
          if (thinking) {
            onChunk({ type: 'thinking', content: thinking })
          }

          // Text content
          if (data.message?.content) {
            onChunk({ type: 'text', content: data.message.content })
          }

          // Tool calls (if supported by the model)
          if (data.message?.tool_calls) {
            for (const tc of data.message.tool_calls) {
              onChunk({
                type: 'tool_call',
                toolCall: {
                  // Ollama sends no call IDs. Each needs its own, or results of two
                  // calls to the same tool land on both calls in the chat.
                  id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${randomUUID()}`,
                  name: tc.function?.name || 'unknown',
                  arguments: tc.function?.arguments || {}
                }
              })
            }
          }

          // Stream complete
          if (data.done === true) {
            const usageChunk = reportedUsageChunk(data.prompt_eval_count, data.eval_count)
            if (usageChunk) onChunk(usageChunk)
            if (data.done_reason === 'length') {
              onChunk({ type: 'notice', content: TRUNCATED_REPLY_NOTICE })
            }
            onChunk({ type: 'done' })
            return
          }
        } catch {
          // Skip malformed NDJSON lines
        }
      }
    }

    // If we exited the loop without done=true, send done anyway.
    onChunk({ type: 'done' })
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 10_000
      })

      const models: string[] = (response.data?.models || [])
        .map((m: { name: string }) => m.name)
        .sort()

      return models
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ECONNREFUSED')) {
        throw new Error('Cannot reach Ollama. Is it running? (ollama serve)')
      }
      throw new Error(`Failed to list Ollama models: ${msg}`)
    }
  }

  /**
   * The window the model is loaded with (num_ctx), from /api/ps. That is what
   * Ollama actually truncates at, unlike the model's trained maximum.
   */
  override async getContextLength(model: string): Promise<number | null> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/ps`, { timeout: 10_000 })
      const loaded: unknown[] = Array.isArray(response.data?.models) ? response.data.models : []
      const entry = loaded.find((item) => {
        if (!item || typeof item !== 'object') return false
        const record = item as { name?: unknown; model?: unknown }
        return record.name === model || record.model === model
      })
      return readContextLength(entry)
    } catch {
      return null
    }
  }
}

registerProvider({
  name: 'ollama',
  displayName: 'Ollama',
  defaultBaseUrl: 'http://localhost:11434',
  factory: (settings) => new OllamaProvider(settings.apiKey, settings.baseUrl)
})
