import axios, { type AxiosResponse } from 'axios'
import { randomUUID } from 'crypto'
import {
  BaseLLMProvider,
  CONTEXT_FULL_NOTICE,
  TRUNCATED_REPLY_NOTICE,
  readContextLength,
  reportedUsageChunk,
  type ProviderSendOptions,
  type AbortHandle,
  type LLMMessage,
  type LLMMessageContent,
  type ModelCapabilities,
  type ModelInfo
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

/**
 * A message's content as Ollama takes it: the text, and the images as base64
 * in a separate list (their "Image N: name" labels stay in the text). LlmService
 * only sends images to models that report vision.
 */
function toOllamaContent(content: LLMMessageContent | null): { content: string; images?: string[] } {
  if (typeof content === 'string') return { content }
  if (!content) return { content: '' }

  const textParts: string[] = []
  const images: string[] = []
  let unreadable = 0

  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.trim().length > 0) {
        textParts.push(part.text)
      }
      continue
    }
    const match = /^data:[^;,]+;base64,(.+)$/s.exec(part.image_url.url)
    if (match) images.push(match[1])
    else unreadable++
  }

  if (unreadable > 0) {
    textParts.push(`[${unreadable} image attachment${unreadable === 1 ? '' : 's'} omitted for this provider]`)
  }

  return { content: textParts.join('\n\n'), ...(images.length > 0 ? { images } : {}) }
}

function toPlainTextContent(content: LLMMessageContent | null): string {
  return toOllamaContent(content).content
}

/**
 * The chat in Ollama's message format. Ollama matches tool results to calls
 * by tool name rather than id, so each result names its tool, and each
 * assistant message carries back its `thinking` (see the ReasoningEcho
 * collected below), as Ollama's tool calling docs ask.
 */
export function toOllamaMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
  const toolNames = new Map<string, string>()
  return messages.map((m) => {
    if (m.role === 'tool') {
      const toolName = m.tool_call_id ? toolNames.get(m.tool_call_id) : undefined
      return { role: 'tool', content: toPlainTextContent(m.content), ...(toolName ? { tool_name: toolName } : {}) }
    }
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) toolNames.set(tc.id, tc.function.name)
      return {
        role: m.role,
        content: toPlainTextContent(m.content),
        ...(m.thinking ? { thinking: m.thinking } : {}),
        // Ollama takes tool call arguments as an object, not a JSON string.
        ...(m.tool_calls && m.tool_calls.length > 0
          ? {
            tool_calls: m.tool_calls.map((tc) => ({
              function: { name: tc.function.name, arguments: parseToolArguments(tc.function.arguments) }
            }))
          }
          : {})
      }
    }
    return { role: m.role, ...toOllamaContent(m.content) }
  })
}

/**
 * Models this session found without tool support (by server and model), so
 * later requests leave tools out at once and the notice shows once.
 */
const modelsWithoutTools = new Set<string>()
const MAX_REMEMBERED_MODELS = 200

/** Forgets which models rejected tools; for tests. */
export function forgetModelsWithoutTools(): void {
  modelsWithoutTools.clear()
}

/** The `num_ctx` line of a model's Modelfile parameters (what Ollama loads it with), if any. */
function parseNumCtx(parameters: unknown): number | null {
  if (typeof parameters !== 'string') return null
  const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters)
  const value = match ? Number(match[1]) : NaN
  return Number.isFinite(value) && value > 0 ? value : null
}

function parseToolArguments(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** The `error` Ollama sent with a failed request, read from its streamed body. */
async function readErrorBody(err: unknown): Promise<string> {
  const data = axios.isAxiosError(err) ? err.response?.data : undefined
  let text = ''
  try {
    if (data && typeof (data as AsyncIterable<Buffer>)[Symbol.asyncIterator] === 'function') {
      for await (const chunk of data as AsyncIterable<Buffer | string>) {
        text += chunk.toString()
        if (text.length > 4_000) break
      }
    } else if (typeof data === 'string') {
      text = data
    }
    const parsed = JSON.parse(text) as { error?: unknown }
    return typeof parsed.error === 'string' ? parsed.error : text
  } catch {
    return text
  }
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
    const { messages, model, tools, temperature, maxTokens, reasoningEnabled, contextWindow, onChunk } = options
    const modelKey = `${this.baseUrl}|${model}`

    const body: Record<string, unknown> = {
      model,
      messages: toOllamaMessages(messages),
      stream: true,
      options: {
        // Left out unless set, so the model's own default applies.
        ...(temperature !== undefined ? { temperature } : {}),
        // Ollama's name for the output token limit.
        ...(maxTokens ? { num_predict: maxTokens } : {}),
        // Unset leaves the window to the server (the Modelfile, or Ollama's default).
        ...(contextWindow ? { num_ctx: contextWindow } : {})
      }
    }

    if (typeof reasoningEnabled === 'boolean') {
      body.think = reasoningEnabled
    }

    // Tools go out unless this model already turned them down this session.
    if (tools.length > 0 && !modelsWithoutTools.has(modelKey)) {
      body.tools = tools
    }

    // A 400 can mean the model has no tool support or no thinking switch:
    // drop what it rejected and ask again, telling the user about tools.
    let response: AxiosResponse
    for (;;) {
      try {
        response = await axios.post(`${this.baseUrl}/api/chat`, body, {
          headers: { 'Content-Type': 'application/json' },
          responseType: 'stream',
          timeout: 300_000,
          signal: controller.signal
        })
        break
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined
        if (status !== 400) throw err

        const reason = await readErrorBody(err)
        if (body.tools && /does not support tools/i.test(reason)) {
          delete body.tools
          if (modelsWithoutTools.size >= MAX_REMEMBERED_MODELS) modelsWithoutTools.clear()
          modelsWithoutTools.add(modelKey)
          onChunk({ type: 'notice', content: `${model} doesn't support tools, so it replies without them.` })
        } else if (Object.prototype.hasOwnProperty.call(body, 'think')) {
          delete body.think
        } else {
          throw new Error(reason ? `Ollama: ${reason}` : (err as Error).message, { cause: err })
        }
      }
    }

    const stream = response.data as AsyncIterable<Buffer | string>
    let buffer = ''
    // A character can be split across network chunks; the decoder holds its
    // first bytes until the rest arrive instead of writing a replacement character.
    const decoder = new TextDecoder('utf-8')
    // The reply's thinking, sent back on its message (see toOllamaMessages).
    let thinkingText = ''
    const echoThinking = () => {
      if (thinkingText) onChunk({ type: 'reasoning_echo', reasoning: { thinking: thinkingText } })
    }

    for await (const chunk of stream) {
      if (controller.signal.aborted) break

      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })

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
            thinkingText += thinking
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
            // Ollama says 'length' both for Max Tokens and for a full context window.
            if (data.done_reason === 'length') {
              const hitMaxTokens = !!maxTokens && typeof data.eval_count === 'number' && data.eval_count >= maxTokens
              onChunk({ type: 'notice', content: hitMaxTokens ? TRUNCATED_REPLY_NOTICE : CONTEXT_FULL_NOTICE })
            }
            echoThinking()
            onChunk({ type: 'done' })
            return
          }
        } catch {
          // Skip malformed NDJSON lines
        }
      }
    }

    // If we exited the loop without done=true, send done anyway; a stopped
    // reply's unfinished thinking isn't kept for replay.
    if (!controller.signal.aborted) echoThinking()
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
        throw new Error('Cannot reach Ollama. Is it running? (ollama serve)', { cause: err })
      }
      throw new Error(`Failed to list Ollama models: ${msg}`, { cause: err })
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

  /**
   * Capabilities from /api/show (Ollama lists `tools`, `vision`, `thinking`
   * and more). The window is the loaded one; before the model is loaded, the
   * Modelfile's num_ctx when it sets one, otherwise unknown (Ollama's default
   * applies, which no endpoint reports).
   */
  override async getModelInfo(model: string): Promise<ModelInfo> {
    const [loaded, shown] = await Promise.all([
      this.getContextLength(model),
      axios.post(`${this.baseUrl}/api/show`, { model }, { timeout: 10_000 })
        .then((response) => response.data as { capabilities?: unknown; parameters?: unknown } | undefined)
        .catch(() => undefined)
    ])
    const listed = Array.isArray(shown?.capabilities) ? shown.capabilities : null
    const capabilities: ModelCapabilities = listed
      ? { tools: listed.includes('tools'), vision: listed.includes('vision') }
      : {}
    return { contextLength: loaded ?? parseNumCtx(shown?.parameters), capabilities }
  }
}

registerProvider({
  name: 'ollama',
  displayName: 'Ollama',
  defaultBaseUrl: 'http://localhost:11434',
  factory: (settings) => new OllamaProvider(settings.apiKey, settings.baseUrl)
})
