import type {
  LLMMessage,
  AbortHandle,
  LLMMessageContent,
  LLMImageUrlContentPart,
  LLMTextContentPart,
  ProviderChunk,
  ReasoningEcho,
  ToolDefinition
} from '../lib/providers/base'
import { createProvider } from '../lib/providers/registry'
import { formatToolResultForModel, getToolDefinitions } from '../lib/tools/registry'
import { sanitizeGeneratedChatTitle } from '../../src/lib/chatTitle'
import { splitThinkingBlocks } from '../../src/lib/thinking'
import { findMcpServerByPrefix, parseMcpToolName } from '../../src/lib/mcpConfig'
import { detectFileType } from '../lib/fileType'
import type { AttachmentBlob } from './ConversationService'
import type {
  LLMRequest,
  StreamChunk,
  ToolCall,
  ProviderName,
  Settings,
  Attachment,
  ImageAttachment,
  TitleGenerationRequest,
  ContextUsage,
  CacheUsage
} from '../../src/types'

// Side-effect imports: each provider self-registers when loaded
import '../lib/providers/openai'
import '../lib/providers/openrouter'
import '../lib/providers/ollama'
import '../lib/providers/lmstudio'
import '../lib/providers/custom'

/** Hard ceiling on tool calls the assistant may run in a single turn. */
export const MAX_TOOL_CALLS = 75

/** Saved as a reply's text, before 1.8, when the model wrote no text; it is UI text, never sent. */
const LEGACY_NO_TEXT_PLACEHOLDER = '_(No text response)_'

/**
 * When a message was sent, in the user's local time with its UTC offset and
 * weekday, e.g. "Wednesday, 2026-10-22 09:41 (UTC-05:00)". Null for a
 * timestamp that doesn't parse.
 */
export function formatMessageTime(isoTimestamp: string | undefined, timeZone: string): string | null {
  const date = new Date(isoTimestamp ?? '')
  if (Number.isNaN(date.getTime())) return null

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset'
    }).formatToParts(date).map((part) => [part.type, part.value])
  )
  // "GMT-05:00", or plain "GMT" at offset zero.
  const offset = parts.timeZoneName === 'GMT' ? 'UTC+00:00' : parts.timeZoneName.replace('GMT', 'UTC')
  return `${parts.weekday}, ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${offset})`
}

/** System prompt note that explains the <sent_at> tag on user messages. */
function sentAtNote(timeZone: string): string {
  return `Each user message begins with a <sent_at> tag: the user's local date and time when they sent it (time zone ${timeZone}). `
    + 'Use it for anything that depends on the current date or time. Don\'t repeat the tag in your replies.'
}
/** Whether a tool reaches the network: built-in web tools and tools from HTTP MCP servers. */
function isNetworkTool(name: string, settings: Settings): boolean {
  if (NETWORK_TOOLS.has(name)) return true
  const parsed = parseMcpToolName(name)
  if (!parsed) return false
  const server = findMcpServerByPrefix(settings.mcpServers, parsed.server)
  return !!server && server.transport !== 'stdio'
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

/** web_search and org_search need Search switched on and a Tavily or SerpAPI key to work. */
function hasSearchApiKey(settings: Settings): boolean {
  return !!settings.tavilyApiKey?.trim() || !!settings.serpApiKey?.trim()
}
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

/** What a past tool call that never returned is replayed with. */
const UNFINISHED_TOOL_RESULT = { error: 'This tool call did not finish: the reply was stopped while it ran.' }
/**
 * A tool still running when the reply was stopped. The turn ends at once
 * rather than waiting on it; whether it got as far as changing anything is
 * unknown (file changes it made can still be undone from the reply).
 */
const STOPPED_TOOL_RESULT = {
  error: 'The reply was stopped while this tool was running, so its result is unknown.',
  code: 'CANCELLED'
}

interface ActiveStream {
  /** The current round's provider request; null while tools run. */
  handle: AbortHandle | null
  /** Stops the tool loop between rounds, where there is no request to abort. */
  cancelled: boolean
  /** Aborted on Stop; tools get its signal so dialogs close and calls end. */
  controller: AbortController
  conversationId: string
}

function newActiveStream(conversationId: string): ActiveStream {
  return { handle: null, cancelled: false, controller: new AbortController(), conversationId }
}

/**
 * Runs one tool call, unless the reply is stopped first: then the call is
 * left to finish on its own (its tool was told through `signal`) and the
 * turn gets STOPPED_TOOL_RESULT right away.
 */
export async function runToolUntilStopped(
  toolExecutor: (tc: ToolCall, signal: AbortSignal) => Promise<ToolCall>,
  tc: ToolCall,
  signal: AbortSignal
): Promise<{ toolCall: ToolCall; stopped: boolean }> {
  if (signal.aborted) return { toolCall: { ...tc, result: STOPPED_TOOL_RESULT }, stopped: true }
  const running = toolExecutor(tc, signal)
  // A tool that fails after Stop has nobody waiting on it.
  running.catch(() => {})
  let onAbort: (() => void) | undefined
  const stopped = new Promise<null>((resolve) => {
    onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const finished = await Promise.race([running, stopped])
    return finished
      ? { toolCall: finished, stopped: false }
      : { toolCall: { ...tc, result: STOPPED_TOOL_RESULT }, stopped: true }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
/** Share of a known context window a request may fill before the oldest tool results are shortened. */
const CONTEXT_FILL_LIMIT = 0.85
/** How much of a shortened tool result is kept. */
const SHORTENED_RESULT_PREVIEW_CHARS = 2_000
const SHORTENED_RESULT_NOTE =
  'This earlier tool result was shortened to fit the context window. Call the tool again if you need all of it.'

/** A tool call id unique within the request: stored ids can be missing, or repeat across turns. */
function uniqueToolCallId(id: string, usedIds: Set<string>): string {
  let candidate = id
  for (let n = 1; !candidate || usedIds.has(candidate); n++) {
    candidate = `call_replay_${usedIds.size + n}`
  }
  usedIds.add(candidate)
  return candidate
}

/**
 * An earlier assistant reply as the exchange the model actually had: each
 * round's text with its tool calls, the full tool results, then the closing
 * text. Rounds are recovered from where each call happened in the reply text
 * (contentOffset); calls stored without one ran before any text.
 *
 * With `reasoningBlocks` (the reply's stretches of thinking, in order), each
 * assistant message carries its round's as `reasoning_content`, for servers
 * that reject earlier tool rounds without it.
 */
export function buildPastReplyMessages(
  content: string,
  toolCalls: ToolCall[] | undefined,
  usedIds: Set<string> = new Set(),
  reasoningBlocks?: string[]
): LLMMessage[] {
  let assistantCount = 0
  const reasoning = (): Pick<LLMMessage, 'reasoning_content'> =>
    reasoningBlocks ? { reasoning_content: reasoningBlocks[assistantCount++] ?? '' } : {}

  if (!toolCalls || toolCalls.length === 0) return [{ role: 'assistant', content, ...reasoning() }]

  const offsetOf = (tc: ToolCall) => Math.min(Math.max(tc.contentOffset ?? 0, 0), content.length)
  // Array sort is stable, so the calls of one round keep their order.
  const ordered = [...toolCalls].sort((a, b) => offsetOf(a) - offsetOf(b))
  const messages: LLMMessage[] = []
  let cursor = 0

  for (let i = 0; i < ordered.length;) {
    const offset = offsetOf(ordered[i])
    const round: ToolCall[] = []
    while (i < ordered.length && offsetOf(ordered[i]) === offset) round.push(ordered[i++])

    const ids = round.map((tc) => uniqueToolCallId(tc.id, usedIds))
    messages.push({
      role: 'assistant',
      content: content.slice(cursor, offset) || null,
      tool_calls: round.map((tc, k) => ({
        id: ids[k],
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) }
      })),
      ...reasoning()
    })
    round.forEach((tc, k) => {
      messages.push({
        role: 'tool',
        content: formatToolResultForModel(tc.name, tc.result === undefined ? UNFINISHED_TOOL_RESULT : tc.result),
        tool_call_id: ids[k]
      })
    })
    cursor = offset
  }

  const closingText = content.slice(cursor)
  if (closingText.trim().length > 0) messages.push({ role: 'assistant', content: closingText, ...reasoning() })
  return messages
}

/**
 * Servers whose thinking models need earlier turns' reasoning sent back
 * whenever a request carries tools (DeepSeek answers 400 without it).
 */
const REASONING_REPLAY_HOSTS = ['deepseek.com']

export function needsReasoningReplay(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return REASONING_REPLAY_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}

/**
 * Safety net for very long chats: shortens the oldest tool results, in place,
 * until the request is estimated to fit the model's context window. Only runs
 * when the window is known; otherwise every result is sent in full.
 * Returns how many results were shortened.
 */
export function fitToolResultsToContext(
  messages: LLMMessage[],
  tools: ToolDefinition[],
  contextLength: number | null
): number {
  if (!contextLength) return 0

  const limit = contextLength * CONTEXT_FILL_LIMIT
  let estimate = estimateUsage(messages, tools, '').promptTokens
  let shortened = 0

  for (const message of messages) {
    if (estimate <= limit) break
    if (message.role !== 'tool' || typeof message.content !== 'string') continue
    if (message.content.length <= SHORTENED_RESULT_PREVIEW_CHARS * 2) continue

    const replacement = JSON.stringify({
      shortened: true,
      note: SHORTENED_RESULT_NOTE,
      preview: message.content.slice(0, SHORTENED_RESULT_PREVIEW_CHARS)
    })
    estimate -= Math.ceil((message.content.length - replacement.length) / ESTIMATED_CHARS_PER_TOKEN)
    message.content = replacement
    shortened += 1
  }

  return shortened
}

/**
 * Leaves out the oldest messages (after the system message) until the request
 * fits the context window, keeping each tool result with the call it answers.
 * Returns how many messages were left out.
 */
export function dropOldestToFit(messages: LLMMessage[], extra: LLMMessage[], contextLength: number | null): number {
  if (!contextLength) return 0
  const limit = contextLength * CONTEXT_FILL_LIMIT
  let dropped = 0
  while (messages.length > 2 && estimateUsage([...messages, ...extra], [], '').promptTokens > limit) {
    messages.splice(1, 1)
    dropped += 1
    // A tool result can't start the history without the call it answers.
    while (messages.length > 2 && messages[1].role === 'tool') {
      messages.splice(1, 1)
      dropped += 1
    }
  }
  return dropped
}

/** How a compaction summary is put in front of the model, inside the system prompt. */
export function summaryNote(summary: string): string {
  return [
    'This chat was compacted: earlier messages were replaced by the summary below, which the assistant wrote. Treat it as what was said and done before the messages that follow.',
    '<conversation_summary>',
    summary,
    '</conversation_summary>'
  ].join('\n')
}

/** The request for a summary, sent after the chat itself. */
export function compactionPrompt(): string {
  const lines = [
    'Write a summary of this conversation so far. It will replace the earlier messages, so the conversation can continue from it without them. Do not reply to the conversation and do not call tools; write only the summary.',
    '',
    'Keep everything needed to carry on the work:',
    '- What the user wants: goals, requirements, constraints and preferences, in their own terms.',
    '- Decisions made and why, and anything ruled out.',
    '- Key facts, figures, quotes and findings, with their sources (URLs, file paths, document names).',
    '- Workspace files read, created or changed, and what changed in them.',
    '- Where the work stands: what is done, what is in progress, open questions and next steps.',
    '',
    'Be specific and complete rather than short: names, numbers and paths matter more than prose. Use headings and bullet points.'
  ]
  return lines.join('\n')
}

/**
 * Adds one request's prompt cache counts to the turn's. Requests whose
 * provider said nothing about its cache leave the total as it was, so a
 * provider without caching reports no cache use at all (null).
 */
export function addCacheUsage(total: CacheUsage | null, usage: ContextUsage): CacheUsage | null {
  if (usage.cachedTokens === undefined && usage.cacheWriteTokens === undefined) return total
  const base = total ?? { requests: 0, promptTokens: 0, readTokens: 0, writeTokens: 0 }
  return {
    requests: base.requests + 1,
    promptTokens: base.promptTokens + usage.promptTokens,
    readTokens: base.readTokens + (usage.cachedTokens ?? 0),
    writeTokens: base.writeTokens + (usage.cacheWriteTokens ?? 0)
  }
}

/** Rough tokens-per-character ratio for text when the provider reports no usage. */
const ESTIMATED_CHARS_PER_TOKEN = 4
/** Rough flat cost per image part; real costs vary by provider and image size. */
const ESTIMATED_TOKENS_PER_IMAGE = 1000
const CONTEXT_LENGTH_CACHE_MS = 10 * 60_000
/**
 * Longest a turn's first request waits on the context window lookup. A slower
 * lookup still fills the cache for the next turn.
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
  private getAttachmentBlob: (blobId: string) => AttachmentBlob | null
  private timeZone: string
  /**
   * In-flight turns by channel (see ActiveStream).
   */
  private activeStreams = new Map<string, ActiveStream>()
  /** Context windows by provider + base URL + model, so each turn doesn't refetch model listings. */
  private contextLengthCache = new Map<string, { value: number | null; expiresAt: number }>()

  constructor(deps: {
    getSettings: () => Settings
    /** Builds the system prompt from the conversation's own context profile. */
    getSystemPrompt: (conversationId: string) => string
    /** Bytes of a saved image, which messages refer to by id. */
    getAttachmentBlob?: (blobId: string) => AttachmentBlob | null
    /** IANA time zone for message times; defaults to this computer's. */
    timeZone?: string
  }) {
    this.getSettings = deps.getSettings
    this.getSystemPrompt = deps.getSystemPrompt
    this.getAttachmentBlob = deps.getAttachmentBlob ?? (() => null)
    this.timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  }

  private supportsVisionParts(provider: ProviderName): boolean {
    return provider === 'openai' || provider === 'openrouter' || provider === 'custom'
  }

  private isImageAttachment(attachment: Attachment): attachment is ImageAttachment {
    return attachment.kind === 'image'
  }

  /** The image as a data: URL for the provider, or null if it was removed or is missing. */
  private imageDataUrl(image: ImageAttachment): string | null {
    if (image.removed) return null
    if (typeof image.dataUrl === 'string' && image.dataUrl.length > 0) return image.dataUrl
    if (!image.blobId) return null
    const blob = this.getAttachmentBlob(image.blobId)
    return blob ? `data:${blob.mimeType};base64,${blob.data.toString('base64')}` : null
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

  /** Each attached text file as a tagged block: name, detected type and size, then the content. */
  private buildTextAttachmentBlocks(attachments: Attachment[]): string[] {
    return attachments
      .filter((attachment) => !this.isImageAttachment(attachment))
      .map((attachment) => {
        const name = this.escapeTagAttribute(attachment.name)
        const type = this.escapeTagAttribute(detectFileType(attachment.name))
        const bytes = Buffer.byteLength(attachment.content, 'utf8')
        const lines = this.countLines(attachment.content)
        const content = attachment.content
        const contentWithClosingNewline = content.length > 0 && !content.endsWith('\n') && !content.endsWith('\r')
          ? `${content}\n`
          : content

        return `<attached_file name="${name}" type="${type}" lines="${lines}" bytes="${bytes}">\n${contentWithClosingNewline}</attached_file>`
      })
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
      return 'Search the web with a user-configured organization site filter. Current org_search site setting: not set. Use this when the user asks for source-scoped web results. Returns titles, URLs and snippets; read the most relevant with fetch_url.'
    }

    if (!normalizedSite) {
      return `Search the web with a user-configured organization site filter. Current org_search site setting: "${rawSite}" (currently not normalized to a valid hostname). Use this when the user asks for this configured source. Returns titles, URLs and snippets; read the most relevant with fetch_url.`
    }

    return `Search the web with a user-configured organization site filter. Current org_search site setting: "${rawSite}" (effective filter: site:${normalizedSite}). Use this when the user asks to search ${normalizedSite} or this configured source. Returns titles, URLs and snippets; read the most relevant with fetch_url.`
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

  /**
   * A user turn in the order models are trained to read: when it was sent,
   * then the attachments (each image after a "Image N: name" label, then the
   * text files), and the user's own words last. Plain text unless it carries
   * images the model can see.
   */
  private buildUserMessageContent(
    content: string,
    attachments: Attachment[] | undefined,
    provider: ProviderName,
    sentAt: string | null
  ): LLMMessageContent {
    const parts: Array<LLMTextContentPart | LLMImageUrlContentPart> = []
    let text: string[] = sentAt ? [`<sent_at>${sentAt}</sent_at>`] : []
    const flushText = () => {
      if (text.length > 0) parts.push({ type: 'text', text: text.join('\n\n') })
      text = []
    }

    const images = (attachments ?? []).filter((attachment) => this.isImageAttachment(attachment))
    images.forEach((image, index) => {
      const label = `Image ${index + 1}: ${image.name}`
      const url = this.imageDataUrl(image)
      if (!url) {
        text.push(`${label} [removed by the user to free space]`)
      } else if (!this.supportsVisionParts(provider)) {
        text.push(`${label} [not shown: this provider doesn't accept images]`)
      } else {
        text.push(label)
        flushText()
        parts.push({ type: 'image_url', image_url: { url } })
      }
    })

    text.push(...this.buildTextAttachmentBlocks(attachments ?? []))
    if (content.trim().length > 0) text.push(content)
    flushText()

    if (parts.length === 0) return content
    return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts
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
    toolExecutor: (tc: ToolCall, signal: AbortSignal) => Promise<ToolCall>
  ): Promise<void> {
    const provider = this.createProvider(request.provider)
    const settings = this.getSettings()
    const messages = this.buildHistory(request, settings)
    const tools = this.availableTools(settings)
    const availableToolNames = new Set(tools.map((tool) => tool.function.name))
    let totalToolCalls = 0
    let roundsAfterToolLimit = 0
    // Prompt cache use over the turn's requests, when the provider reports it.
    let cache: CacheUsage | null = null

    // Tracked from the start so Stop ends the turn at any point: during the
    // context window lookup below, between rounds, and while tools run.
    const stream = newActiveStream(request.conversationId)
    this.activeStreams.set(channel, stream)

    try {
      // Known before the first request so a long chat is shortened even on its
      // first turn after launch; cached, and capped at a few seconds when not.
      const contextLength = await this.lookupContextLength(request.provider, request.model)
      if (stream.cancelled) {
        sink.send({ type: 'done' })
        return
      }

      for (let round = 1; ; round++) {
        // Every round: one turn's own tool results can outgrow the window.
        const shortenedResults = fitToolResultsToContext(messages, tools, contextLength)
        if (shortenedResults > 0) {
          sink.send({
            type: 'notice',
            content: `Shortened ${shortenedResults} older tool result${shortenedResults === 1 ? '' : 's'} so this chat fits the model's context window.`
          })
        }

        const collectedToolCalls: ToolCall[] = []
        let textAccumulated = ''
        let reportedUsage: ContextUsage | null = null
        let reasoningEcho: ReasoningEcho | null = null

        const streamDone = await new Promise<'done' | 'tool_calls' | 'error'>((resolve) => {
          stream.handle = provider.sendStreaming({
            messages,
            model: request.model,
            tools,
            temperature: request.temperature,
            maxTokens: request.maxTokens ?? (settings.maxTokensEnabled ? settings.maxTokens : undefined),
            reasoningEnabled: settings.reasoningEnabled,
            // Every round resends the chat so far; the provider can serve that prefix from its cache.
            cacheKey: request.conversationId,
            onChunk: (chunk: ProviderChunk) => {
              switch (chunk.type) {
                case 'thinking':
                case 'notice':
                  sink.send(chunk)
                  break

                case 'reasoning_echo':
                  // Kept for the tool-call message below; never shown.
                  reasoningEcho = chunk.reasoning
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
        const roundUsage = reportedUsage as ContextUsage | null
        if (roundUsage) cache = addCacheUsage(cache, roundUsage)

        if (streamDone === 'done' && !stream.cancelled) {
          // The final round's request holds the whole turn, so it is the turn's peak context use.
          const usage = roundUsage ?? estimateUsage(messages, tools, textAccumulated)
          sink.send({ type: 'usage', usage: { ...usage, contextLength, ...(cache ? { cache } : {}) } })
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

        // Append the assistant's response (with tool_calls) to the conversation,
        // with its reasoning, so the model picks up where it left off.
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
          })),
          ...(reasoningEcho ?? {})
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
          const startedAt = Date.now()
          const ran = withinBudget && availableToolNames.has(tc.name)
            ? await runToolUntilStopped(toolExecutor, tc, stream.controller.signal)
            : null
          const executed: ToolCall = !withinBudget
            ? { ...tc, round, result: { error: TOOL_LIMIT_REACHED_ERROR, code: 'LIMIT_REACHED' } }
            : ran
              ? { ...ran.toolCall, round, durationMs: Date.now() - startedAt }
              : {
                round,
                ...tc,
                result: {
                  error: settings.offlineMode && isNetworkTool(tc.name, settings)
                    ? `Tool "${tc.name}" is unavailable: offline mode is on.`
                    : !settings.searchToolsEnabled && SEARCH_TOOLS_REQUIRING_API_KEYS.has(tc.name)
                    ? `Tool "${tc.name}" is disabled in Settings.`
                    : !hasSearchApiKey(settings) && SEARCH_TOOLS_REQUIRING_API_KEYS.has(tc.name)
                    ? `Tool "${tc.name}" needs a Tavily or SerpAPI key in Settings.`
                    : `Tool "${tc.name}" is not available for this request.`,
                  code: 'PERMISSION_DENIED'
                }
              }

          // Send tool result chunk to renderer
          sink.send({ type: 'tool_result', toolCall: executed })

          // Append tool result to conversation for the next round. The budget
          // notice rides along on the last result so every provider sees it.
          const isLastInRound = index === collectedToolCalls.length - 1
          const resultContent = formatToolResultForModel(executed.name, executed.result)
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

  /**
   * The conversation as the model sees it: the system prompt, then each
   * message. A compaction summary (a 'system' message in the chat) stands in
   * for everything before it: it joins the system prompt, and earlier
   * messages are left out.
   */
  private buildHistory(request: LLMRequest, settings: Settings): LLMMessage[] {
    const summaryIndex = request.messages.map((msg) => msg.role).lastIndexOf('system')
    const summary = summaryIndex >= 0 ? request.messages[summaryIndex].content : null

    // System message first. The note explaining <sent_at> names no date, so
    // the system prompt stays identical turn to turn (providers cache it).
    const systemParts = [this.getSystemPrompt(request.conversationId), sentAtNote(this.timeZone)]
    if (summary) systemParts.push(summaryNote(summary))
    const messages: LLMMessage[] = [{ role: 'system', content: systemParts.join('\n\n') }]

    // Each user message carries the local time it was sent. Earlier replies
    // are replayed with their tool calls and full results, in the same shape
    // as the live tool loop.
    const replayedToolCallIds = new Set<string>()
    const replayReasoning = needsReasoningReplay(settings.providers?.[request.provider]?.baseUrl)
    for (const msg of request.messages.slice(summaryIndex + 1)) {
      if (msg.role === 'user') {
        const sentAt = formatMessageTime(msg.timestamp, this.timeZone)
        messages.push({ role: msg.role, content: this.buildUserMessageContent(msg.content, msg.attachments, request.provider, sentAt) })
        continue
      }

      if (msg.role === 'assistant') {
        // Replies saved before 1.8 hold this UI text when the model wrote none.
        const content = msg.content === LEGACY_NO_TEXT_PLACEHOLDER ? '' : msg.content
        // Nothing to replay: no text and no tool calls (e.g. only reasoning).
        if (!content.trim() && !msg.toolCalls?.length) continue
        messages.push(...buildPastReplyMessages(
          content,
          msg.toolCalls,
          replayedToolCallIds,
          replayReasoning ? splitThinkingBlocks(msg.thinking) : undefined
        ))
      }
    }
    return messages
  }

  private availableTools(settings: Settings): ToolDefinition[] {
    return this.withDynamicToolDescriptions(getToolDefinitions(), settings).filter((tool) =>
      (!SEARCH_TOOLS_REQUIRING_API_KEYS.has(tool.function.name) || (settings.searchToolsEnabled && hasSearchApiKey(settings)))
      && !(settings.offlineMode && isNetworkTool(tool.function.name, settings))
    )
  }

  /**
   * Compaction: asks the model for a summary of the chat so far, to stand in
   * for it from the next message on. Runs without tools. Returns null when
   * stopped (cancelStream on `channel`). The usage is an estimate of the
   * context the next request starts from.
   */
  async compactConversation(
    request: LLMRequest,
    channel: string
  ): Promise<{ summary: string; usage: ContextUsage } | null> {
    const provider = this.createProvider(request.provider)
    const settings = this.getSettings()

    // Tracked from the start so Stop also works during the lookup below.
    const stream = newActiveStream(request.conversationId)
    this.activeStreams.set(channel, stream)
    try {
      const contextLength = await this.lookupContextLength(request.provider, request.model)
      if (stream.cancelled) return null

      const messages = this.buildHistory(request, settings)
      const instruction: LLMMessage = { role: 'user', content: compactionPrompt() }

      // The chat may already be past the window: shorten old tool results, then
      // leave out the oldest messages until the request fits.
      fitToolResultsToContext(messages, [], contextLength)
      const omitted = dropOldestToFit(messages, [instruction], contextLength)
      if (omitted > 0) {
        instruction.content = `${instruction.content as string}\n\n(The ${omitted} oldest messages were left out to fit the context window; the summary at the top covers what came before them, if there is one.)`
      }
      messages.push(instruction)

      let text = ''
      const outcome = await new Promise<{ error: string } | null>((resolve) => {
        stream.handle = provider.sendStreaming({
          messages,
          model: request.model,
          tools: [],
          temperature: request.temperature,
          maxTokens: request.maxTokens ?? (settings.maxTokensEnabled ? settings.maxTokens : undefined),
          reasoningEnabled: settings.reasoningEnabled,
          // The same history the chat's replies sent, so it can be read from the cache.
          cacheKey: request.conversationId,
          onChunk: (chunk: ProviderChunk) => {
            if (chunk.type === 'text') text += chunk.content || ''
            else if (chunk.type === 'error') resolve({ error: chunk.error || 'The summary request failed.' })
            else if (chunk.type === 'done') resolve(null)
          }
        })
      })
      if (stream.cancelled) return null
      if (outcome) throw new Error(outcome.error)

      const summary = text.trim()
      if (!summary) throw new Error('The model returned an empty summary, so nothing was compacted.')

      const tools = this.availableTools(settings)
      const after = this.buildHistory({ ...request, messages: [{ role: 'system', content: summary, timestamp: '' }] }, settings)
      return { summary, usage: { ...estimateUsage(after, tools, ''), contextLength } }
    } finally {
      if (this.activeStreams.get(channel) === stream) this.activeStreams.delete(channel)
    }
  }

  cancelStream(channel: string): void {
    const stream = this.activeStreams.get(channel)
    if (!stream) return
    stream.cancelled = true
    stream.controller.abort()
    stream.handle?.abort()
  }

  private contextLengthKey(providerName: ProviderName, model: string): string {
    const config = this.getSettings().providers?.[providerName]
    return `${providerName}|${config?.baseUrl ?? ''}|${model}`
  }

  /**
   * The model's context window, for fitting requests and the meter; null when
   * unknown, slow or failing. An expired value is still used while a fresh
   * lookup runs in the background, so a chat left idle doesn't wait on it.
   */
  private lookupContextLength(providerName: ProviderName, model: string): Promise<number | null> {
    const key = this.contextLengthKey(providerName, model)
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

    if (cached) {
      clearTimeout(timer)
      return Promise.resolve(cached.value)
    }
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
