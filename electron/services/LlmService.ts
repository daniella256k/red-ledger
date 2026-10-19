import type { LLMMessage, AbortHandle, LLMMessageContent, ToolDefinition } from '../lib/providers/base'
import { createProvider } from '../lib/providers/registry'
import { getToolDefinitions } from '../lib/tools/registry'
import { sanitizeGeneratedChatTitle } from '../../src/lib/chatTitle'
import { mcpServerPrefix, parseMcpToolName } from '../../src/lib/mcpConfig'
import { detectFileType } from '../lib/fileType'
import type {
  LLMRequest,
  StreamChunk,
  ToolCall,
  ProviderName,
  Settings,
  Attachment,
  ImageAttachment,
  TitleGenerationRequest,
  ToolCallRecord,
  ContextUsage
} from '../../src/types'

// Side-effect imports: each provider self-registers when loaded
import '../lib/providers/openai'
import '../lib/providers/openrouter'
import '../lib/providers/ollama'
import '../lib/providers/lmstudio'
import '../lib/providers/custom'

/** Hard ceiling on tool calls the assistant may run in a single turn. */
export const MAX_TOOL_CALLS = 75
/** Whether a tool reaches the network: built-in web tools and tools from HTTP MCP servers. */
function isNetworkTool(name: string, settings: Settings): boolean {
  if (NETWORK_TOOLS.has(name)) return true
  const parsed = parseMcpToolName(name)
  if (!parsed) return false
  return settings.mcpServers.some(
    (server) => server.transport !== 'stdio' && mcpServerPrefix(server.name) === parsed.server
  )
}

/** Running totals at which the assistant is nudged to check whether it still needs tools. */
export const TOOL_CALL_WARNING_THRESHOLDS = [25, 40, 50]
/** Rounds the assistant gets to answer after hitting the limit before the turn is stopped. */
const MAX_ROUNDS_AFTER_TOOL_LIMIT = 2
const DEFAULT_TITLE_MAX_TOKENS = 24
const TITLE_TEMPERATURE = 0.2
const SEARCH_TOOLS_REQUIRING_API_KEYS = new Set(['web_search', 'org_search'])
const ORG_SEARCH_TOOL_NAME = 'org_search'
/** Built-in tools that reach the network; hidden in offline mode. */
const NETWORK_TOOLS = new Set(['web_search', 'org_search', 'wiki_search', 'fetch_url'])
const TITLE_GENERATION_SYSTEM_PROMPT =
  'Generate a concise chat title for the provided user prompt. Return only the title text in 2 to 6 words. No reasoning, no prefix, no quotes, no markdown, and no trailing punctuation.'

function buildTitleGenerationExtraBody(provider: ProviderName): Record<string, unknown> | undefined {
  if (provider !== 'openrouter') return undefined

  // OpenRouter reasoning models may consume small token budgets with hidden reasoning.
  // Force reasoning off so a 24-token response still returns visible title text.
  return {
    include_reasoning: false,
    reasoning: {
      effort: 'none',
      exclude: true
    }
  }
}

/**
 * Returns a budget notice for the assistant when the running tool call total
 * crosses one of the warning thresholds, otherwise null.
 */
export function buildToolCallBudgetNotice(previousTotal: number, nextTotal: number): string | null {
  if (previousTotal < MAX_TOOL_CALLS && nextTotal >= MAX_TOOL_CALLS) {
    return `[system: tool_call_budget used=${nextTotal} limit=${MAX_TOOL_CALLS}] `
      + 'You have reached the tool call limit for this turn. Tools will no longer run. '
      + 'Answer the user now using the information you already have, and mention anything you could not finish.'
  }

  const crossed = TOOL_CALL_WARNING_THRESHOLDS.filter(
    (threshold) => previousTotal < threshold && nextTotal >= threshold
  )
  if (crossed.length === 0) return null

  return `[system: tool_call_budget used=${nextTotal} limit=${MAX_TOOL_CALLS}] `
    + `You have made ${nextTotal} tool calls this turn. Before calling more tools, check whether you already have enough to answer. `
    + `Only continue if more tool calls are clearly needed. At ${MAX_TOOL_CALLS} tool calls, tools stop running and you must answer with what you have.`
}

const MAX_LOGGED_TOOL_CALLS = 40
const MAX_LOGGED_ARGS_CHARS = 200
const MAX_LOGGED_ERROR_CHARS = 120

function clip(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 1)}…` : singleLine
}

/**
 * Compact log of the tool calls behind an earlier assistant reply. Without it
 * the model only sees its old reply text in later turns and has no idea it
 * searched, fetched or read anything. Results are left out to save tokens.
 */
export function buildToolCallLogTag(records: ToolCallRecord[] | undefined): string | null {
  if (!records || records.length === 0) return null

  const lines = records.slice(0, MAX_LOGGED_TOOL_CALLS).map((record, index) => {
    const outcome = record.status === 'error'
      ? `error: ${clip(record.error || 'unknown error', MAX_LOGGED_ERROR_CHARS)}`
      : record.status
    return `${index + 1}. ${record.name} ${clip(JSON.stringify(record.arguments ?? {}), MAX_LOGGED_ARGS_CHARS)} -> ${outcome}`
  })
  const hidden = records.length - lines.length
  if (hidden > 0) lines.push(`(+${hidden} more)`)

  return `[system: previous_reply_tool_calls count=${records.length} `
    + `(your previous reply made these tool calls; results are omitted here, call a tool again if you need the details)\n`
    + `${lines.join('\n')}\n]`
}

/** Rough tokens-per-character ratio for text when the provider reports no usage. */
const ESTIMATED_CHARS_PER_TOKEN = 4
/** Rough flat cost per image part; real costs vary by provider and image size. */
const ESTIMATED_TOKENS_PER_IMAGE = 1000
const CONTEXT_LENGTH_CACHE_MS = 10 * 60_000
/**
 * Longest a turn's end waits on the context window lookup (timed from the turn's
 * start). A slower lookup still fills the cache for the next turn.
 */
const CONTEXT_LENGTH_TIMEOUT_MS = 3_000

/**
 * Token estimate for a request the provider gave no usage for: the text of
 * every message, tool call and tool definition, at ~4 characters per token.
 */
export function estimateUsage(messages: LLMMessage[], tools: ToolDefinition[], replyText: string): ContextUsage {
  let chars = JSON.stringify(tools).length
  let images = 0

  for (const message of messages) {
    if (typeof message.content === 'string') {
      chars += message.content.length
    } else if (message.content) {
      for (const part of message.content) {
        if (part.type === 'text') chars += part.text.length
        else images += 1
      }
    }
    for (const toolCall of message.tool_calls ?? []) {
      chars += toolCall.function.name.length + toolCall.function.arguments.length
    }
  }

  return {
    promptTokens: Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN) + images * ESTIMATED_TOKENS_PER_IMAGE,
    completionTokens: Math.ceil(replyText.length / ESTIMATED_CHARS_PER_TOKEN),
    contextLength: null,
    estimated: true
  }
}

const TOOL_LIMIT_REACHED_ERROR =
  `Tool call limit reached (${MAX_TOOL_CALLS} this turn). This tool was not run. `
  + 'Answer the user now using the information you already have, and mention anything you could not finish.'

/**
 * Interface for sending stream chunks to the renderer.
 * In production: wraps win.webContents.send(channel, chunk).
 * In tests: a mock.
 */
export interface StreamSink {
  send(chunk: StreamChunk): void
}

/**
 * Domain service for LLM streaming orchestration.
 * Owns provider factory, multi-round tool use loop, and system prompt assembly.
 * No Electron imports — dialogs and window access are injected.
 */
export class LlmService {
  private getSettings: () => Settings
  private getSystemPrompt: (conversationId: string) => string
  /**
   * In-flight turns by channel. `handle` is the provider request of the
   * current round (null while tools run); `cancelled` stops the tool loop
   * between rounds, where there is no request to abort.
   */
  private activeStreams = new Map<string, { handle: AbortHandle | null; cancelled: boolean }>()
  /** Context windows by provider + base URL + model, so each turn doesn't refetch model listings. */
  private contextLengthCache = new Map<string, { value: number | null; expiresAt: number }>()

  constructor(deps: {
    getSettings: () => Settings
    /** Builds the system prompt from the conversation's own context profile. */
    getSystemPrompt: (conversationId: string) => string
  }) {
    this.getSettings = deps.getSettings
    this.getSystemPrompt = deps.getSystemPrompt
  }

  private supportsVisionParts(provider: ProviderName): boolean {
    return provider === 'openai' || provider === 'openrouter' || provider === 'custom'
  }

  private isImageAttachment(attachment: Attachment): attachment is ImageAttachment {
    if (attachment.kind !== 'image') return false
    if (typeof attachment.mimeType !== 'string' || attachment.mimeType.length === 0) return false
    if (typeof attachment.dataUrl !== 'string' || attachment.dataUrl.length === 0) return false
    return true
  }

  private countLines(content: string): number {
    if (content.length === 0) return 0
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const splitLines = normalized.split('\n')
    return normalized.endsWith('\n')
      ? Math.max(1, splitLines.length - 1)
      : splitLines.length
  }

  private escapeTagAttribute(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/'/g, '&#39;')
  }

  private buildTextAttachmentBlocks(attachments: Attachment[]): string {
    const textAttachments = attachments.filter((attachment) => !this.isImageAttachment(attachment))
    if (textAttachments.length === 0) return ''

    return textAttachments
      .map((attachment) => {
        const name = this.escapeTagAttribute(attachment.name)
        const type = this.escapeTagAttribute(detectFileType(attachment.name))
        const bytes = Buffer.byteLength(attachment.content, 'utf8')
        const lines = this.countLines(attachment.content)
        const content = attachment.content
        const contentWithClosingNewline = content.length > 0 && !content.endsWith('\n') && !content.endsWith('\r')
          ? `${content}\n`
          : content

        return `\n\n<attached_file name="${name}" type="${type}" lines="${lines}" bytes="${bytes}">\n${contentWithClosingNewline}</attached_file>`
      })
      .join('')
  }

  private buildImageFallbackBlocks(images: ImageAttachment[]): string {
    if (images.length === 0) return ''

    return images
      .map((image) => `\n\n---\n**Attached image: ${image.name}**\n[Image omitted for this provider]`)
      .join('')
  }

  private buildImageMetadataBlocks(images: ImageAttachment[]): string {
    if (images.length === 0) return ''

    return images
      .map((image) => `\n\n---\n**Attached image: ${image.name}**`)
      .join('')
  }

  private withSystemTags(content: LLMMessageContent, tags: string[]): LLMMessageContent {
    if (tags.length === 0) return content
    const prefix = tags.map((tag) => `${tag}\n\n`).join('')

    if (typeof content === 'string') {
      return prefix + content
    }

    const parts = [...content]
    if (parts.length > 0 && parts[0].type === 'text') {
      parts[0] = {
        type: 'text',
        text: prefix + parts[0].text
      }
      return parts
    }

    return [{ type: 'text', text: prefix }, ...parts]
  }

  private withDynamicToolDescriptions(tools: ToolDefinition[], settings: Settings): ToolDefinition[] {
    return tools.map((tool) => {
      if (tool.function.name !== ORG_SEARCH_TOOL_NAME) return tool

      return {
        ...tool,
        function: {
          ...tool.function,
          description: this.buildOrgSearchToolDescription(settings.orgSite)
        }
      }
    })
  }

  private buildOrgSearchToolDescription(orgSite: string | undefined): string {
    const rawSite = typeof orgSite === 'string'
      ? orgSite.trim().replace(/\s+/g, ' ')
      : ''
    const normalizedSite = this.normalizeOrgSite(orgSite)

    if (!rawSite) {
      return 'Search the web with a user-configured organization site filter. Current org_search site setting: not set. Use this when the user asks for source-scoped web results. Returns titles, URLs, and snippets.'
    }

    if (!normalizedSite) {
      return `Search the web with a user-configured organization site filter. Current org_search site setting: "${rawSite}" (currently not normalized to a valid hostname). Use this when the user asks for this configured source. Returns titles, URLs, and snippets.`
    }

    return `Search the web with a user-configured organization site filter. Current org_search site setting: "${rawSite}" (effective filter: site:${normalizedSite}). Use this when the user asks to search ${normalizedSite} or this configured source. Returns titles, URLs, and snippets.`
  }

  private normalizeOrgSite(orgSite: string | undefined): string | null {
    if (!orgSite) return null

    const trimmed = orgSite.trim()
    if (!trimmed) return null

    const withoutPrefix = trimmed.replace(/^site:/i, '').trim()
    if (!withoutPrefix) return null

    const [firstToken] = withoutPrefix.split(/\s+/)
    if (!firstToken) return null

    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(firstToken)
      ? firstToken
      : `https://${firstToken}`

    try {
      const parsed = new URL(candidate)
      return parsed.hostname.trim().toLowerCase() || null
    } catch {
      const fallbackHost = firstToken.split('/')[0]?.trim().toLowerCase()
      return fallbackHost || null
    }
  }

  private buildUserMessageContent(
    content: string,
    attachments: Attachment[] | undefined,
    provider: ProviderName
  ): LLMMessageContent {
    if (!attachments || attachments.length === 0) {
      return content
    }

    const promptText = content.trim().length > 0 ? content : '(see attached files)'
    const textWithFileBlocks = promptText + this.buildTextAttachmentBlocks(attachments)
    const images = attachments.filter((attachment): attachment is ImageAttachment =>
      this.isImageAttachment(attachment)
    )

    if (images.length === 0) {
      return textWithFileBlocks
    }

    if (!this.supportsVisionParts(provider)) {
      return textWithFileBlocks + this.buildImageFallbackBlocks(images)
    }

    return [
      { type: 'text', text: textWithFileBlocks + this.buildImageMetadataBlocks(images) },
      ...images.map((image) => ({
        type: 'image_url' as const,
        image_url: {
          url: image.dataUrl
        }
      }))
    ]
  }

  /**
   * Main streaming orchestration loop.
   * Handles multi-round tool use: when the LLM makes tool calls, we execute
   * them, append the results to the conversation, and re-stream so the LLM
   * can respond to the tool output.
   */
  async orchestrateStream(
    request: LLMRequest,
    channel: string,
    sink: StreamSink,
    toolExecutor: (tc: ToolCall) => Promise<ToolCall>
  ): Promise<void> {
    const provider = this.createProvider(request.provider)
    const systemPrompt = this.getSystemPrompt(request.conversationId)
    const settings = this.getSettings()

    // Build the conversation history in LLMMessage format
    const messages: LLMMessage[] = []

    // System message first
    messages.push({ role: 'system', content: systemPrompt })

    // Append conversation messages from the request, injecting system timestamps
    // into user messages so the LLM always has accurate real-time context.
    // Tool calls behind an assistant reply ride on the next user message (not
    // the reply itself, so the model doesn't learn to write such tags itself).
    let pendingToolCallLog: string | null = null
    for (const msg of request.messages) {
      if (msg.role === 'user') {
        const content = this.buildUserMessageContent(msg.content, msg.attachments, request.provider)
        const tags = [
          ...(msg.timestamp ? [`[system: msg_timestamp=${msg.timestamp}]`] : []),
          ...(pendingToolCallLog ? [pendingToolCallLog] : [])
        ]
        pendingToolCallLog = null
        messages.push({ role: msg.role, content: this.withSystemTags(content, tags) })
        continue
      }

      if (msg.role === 'assistant') {
        pendingToolCallLog = buildToolCallLogTag(msg.toolCalls)
      }
      messages.push({ role: msg.role, content: msg.content })
    }

    const tools = this.withDynamicToolDescriptions(getToolDefinitions(), settings).filter((tool) =>
      (settings.searchToolsEnabled || !SEARCH_TOOLS_REQUIRING_API_KEYS.has(tool.function.name))
      && !(settings.offlineMode && isNetworkTool(tool.function.name, settings))
    )
    const availableToolNames = new Set(tools.map((tool) => tool.function.name))
    let totalToolCalls = 0
    let roundsAfterToolLimit = 0
    // Looked up alongside the reply so the context meter rarely waits for it.
    const contextLengthLookup = this.lookupContextLength(request.provider, request.model)

    // Tracked so Stop also ends the turn between rounds, while tools run.
    const stream: { handle: AbortHandle | null; cancelled: boolean } = { handle: null, cancelled: false }
    this.activeStreams.set(channel, stream)

    try {
      while (true) {
        const collectedToolCalls: ToolCall[] = []
        let textAccumulated = ''
        let reportedUsage: ContextUsage | null = null

        const streamDone = await new Promise<'done' | 'tool_calls' | 'error'>((resolve) => {
          stream.handle = provider.sendStreaming({
            messages,
            model: request.model,
            tools,
            temperature: request.temperature,
            maxTokens: request.maxTokens ?? (settings.maxTokensEnabled ? settings.maxTokens : undefined),
            reasoningEnabled: settings.reasoningEnabled,
            onChunk: (chunk: StreamChunk) => {
              switch (chunk.type) {
                case 'thinking':
                case 'notice':
                  sink.send(chunk)
                  break

                case 'usage':
                  // Held back: the renderer gets one figure for the whole turn.
                  if (chunk.usage) reportedUsage = chunk.usage
                  break

                case 'text':
                  textAccumulated += chunk.content || ''
                  sink.send(chunk)
                  break

                case 'tool_call':
                  if (chunk.toolCall) {
                    collectedToolCalls.push(chunk.toolCall)
                  }
                  sink.send(chunk)
                  break

                case 'error':
                  sink.send(chunk)
                  resolve('error')
                  break

                case 'done':
                  if (collectedToolCalls.length > 0) {
                    resolve('tool_calls')
                  } else {
                    resolve('done')
                  }
                  break
              }
            }
          })
        })

        stream.handle = null

        if (streamDone === 'done' && !stream.cancelled) {
          // The final round's request holds the whole turn, so it is the turn's peak context use.
          const usage = reportedUsage ?? estimateUsage(messages, tools, textAccumulated)
          sink.send({ type: 'usage', usage: { ...usage, contextLength: await contextLengthLookup } })
        }

        if (streamDone === 'error' || streamDone === 'done' || stream.cancelled) {
          sink.send({ type: 'done' })
          return
        }

        // streamDone === 'tool_calls' — execute each tool (within budget) and loop.
        // Once the hard limit is hit, further calls get an error result asking the
        // assistant to wrap up; if it keeps calling tools anyway, stop the turn.
        const previousToolCalls = totalToolCalls
        const remainingBudget = Math.max(0, MAX_TOOL_CALLS - totalToolCalls)
        if (remainingBudget === 0) {
          roundsAfterToolLimit += 1
          if (roundsAfterToolLimit > MAX_ROUNDS_AFTER_TOOL_LIMIT) {
            sink.send({
              type: 'error',
              error: `Tool call limit (${MAX_TOOL_CALLS}) reached and the assistant kept calling tools. Stopped this turn.`
            })
            sink.send({ type: 'done' })
            return
          }
        }
        totalToolCalls += Math.min(collectedToolCalls.length, remainingBudget)
        if (previousToolCalls < MAX_TOOL_CALLS && totalToolCalls >= MAX_TOOL_CALLS) {
          sink.send({
            type: 'notice',
            content: `Tool call limit (${MAX_TOOL_CALLS}) reached. The assistant was asked to wrap up with what it has.`
          })
        }

        // Append the assistant's response (with tool_calls) to the conversation
        const assistantMessage: LLMMessage = {
          role: 'assistant',
          content: textAccumulated || null,
          tool_calls: collectedToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments)
            }
          }))
        }
        messages.push(assistantMessage)

        // Execute each tool call and collect results
        const budgetNotice = buildToolCallBudgetNotice(previousToolCalls, totalToolCalls)
        for (const [index, tc] of collectedToolCalls.entries()) {
          // Stopped while an earlier tool ran: run nothing else.
          if (stream.cancelled) {
            sink.send({ type: 'done' })
            return
          }

          const withinBudget = index < remainingBudget
          const executed = !withinBudget
            ? { ...tc, result: { error: TOOL_LIMIT_REACHED_ERROR, code: 'LIMIT_REACHED' } }
            : availableToolNames.has(tc.name)
              ? await toolExecutor(tc)
              : {
                ...tc,
                result: {
                  error: settings.offlineMode && isNetworkTool(tc.name, settings)
                    ? `Tool "${tc.name}" is unavailable: offline mode is on.`
                    : !settings.searchToolsEnabled && SEARCH_TOOLS_REQUIRING_API_KEYS.has(tc.name)
                    ? `Tool "${tc.name}" is disabled in Settings.`
                    : `Tool "${tc.name}" is not available for this request.`,
                  code: 'PERMISSION_DENIED'
                }
              }

          // Send tool result chunk to renderer
          sink.send({ type: 'tool_result', toolCall: executed })

          // Append tool result to conversation for the next round. The budget
          // notice rides along on the last result so every provider sees it.
          const isLastInRound = index === collectedToolCalls.length - 1
          const resultContent = JSON.stringify(executed.result)
          const toolMessage: LLMMessage = {
            role: 'tool',
            content: isLastInRound && budgetNotice
              ? `${resultContent}\n\n${budgetNotice}`
              : resultContent,
            tool_call_id: tc.id
          }
          messages.push(toolMessage)
        }

        // Stopped while the last tool ran: don't start another round.
        if (stream.cancelled) {
          sink.send({ type: 'done' })
          return
        }
      }
    } finally {
      if (this.activeStreams.get(channel) === stream) {
        this.activeStreams.delete(channel)
      }
    }
  }

  cancelStream(channel: string): void {
    const stream = this.activeStreams.get(channel)
    if (!stream) return
    stream.cancelled = true
    stream.handle?.abort()
  }

  /** The model's context window for the meter; null when unknown, slow or failing. */
  private lookupContextLength(providerName: ProviderName, model: string): Promise<number | null> {
    const config = this.getSettings().providers?.[providerName]
    const key = `${providerName}|${config?.baseUrl ?? ''}|${config?.compatibility ?? ''}|${model}`
    const cached = this.contextLengthCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CONTEXT_LENGTH_TIMEOUT_MS)
    })
    const lookup = Promise.resolve()
      .then(() => this.createProvider(providerName).getContextLength(model))
      .then((value) => {
        this.contextLengthCache.set(key, { value, expiresAt: Date.now() + CONTEXT_LENGTH_CACHE_MS })
        return value
      })
      .catch(() => null)

    return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer))
  }

  async listModels(providerName: ProviderName): Promise<string[]> {
    const provider = this.createProvider(providerName)
    return provider.listModels()
  }

  async generateTitle(request: TitleGenerationRequest): Promise<string | null> {
    const prompt = request.prompt.trim()
    if (!prompt) return null

    const provider = this.createProvider(request.provider)
    const maxTokens = request.maxTokens && Number.isFinite(request.maxTokens)
      ? Math.max(1, Math.min(Math.floor(request.maxTokens), DEFAULT_TITLE_MAX_TOKENS))
      : DEFAULT_TITLE_MAX_TOKENS
    const extraBody = buildTitleGenerationExtraBody(request.provider)

    const titleText = await new Promise<string>((resolve, reject) => {
      let settled = false
      let titleBuffer = ''

      provider.sendStreaming({
        model: request.model,
        messages: [
          { role: 'system', content: TITLE_GENERATION_SYSTEM_PROMPT },
          { role: 'user', content: `User prompt:\n${prompt}\n\nTitle:` }
        ],
        tools: [],
        temperature: TITLE_TEMPERATURE,
        maxTokens,
        ...(extraBody ? { extraBody } : {}),
        onChunk: (chunk) => {
          if (settled) return

          if (chunk.type === 'text' && chunk.content) {
            titleBuffer += chunk.content
            return
          }

          if (chunk.type === 'error') {
            settled = true
            reject(new Error(chunk.error || 'Title generation failed'))
            return
          }

          if (chunk.type === 'done') {
            settled = true
            resolve(titleBuffer)
          }
        }
      })
    })

    const sanitized = sanitizeGeneratedChatTitle(titleText)
    return sanitized
  }

  // ─── Provider Factory ─────────────────────────────────────────────────────

  private createProvider(providerName: ProviderName) {
    const settings = this.getSettings()
    const config = settings.providers[providerName]
    return createProvider(providerName, config)
  }
}
