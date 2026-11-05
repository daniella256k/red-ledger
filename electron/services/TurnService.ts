import { randomUUID } from 'crypto'
import type { StreamSink } from './LlmService'
import type { ConversationService } from './ConversationService'
import type { LlmService } from './LlmService'
import { parseStoredToolCalls } from '../../src/lib/storedToolCalls'
import { THINKING_BLOCK_SEPARATOR } from '../../src/lib/thinking'
import { DEFAULT_CHAT_TITLE, sanitizeGeneratedChatTitle } from '../../src/lib/chatTitle'
import { contextRatio, shouldAutoCompact } from '../../src/lib/contextUsage'
import type {
  CompactStartResult,
  ContextUsage,
  ConversationRequestInfo,
  LiveTurn,
  LLMRequest,
  Message,
  ProviderName,
  Settings,
  StreamChunk,
  ToolCall,
  TurnEvent,
  TurnKind,
  TurnPhase,
  TurnStartRequest
} from '../../src/types'

/** How often a running turn's progress is sent to the page. */
const UPDATE_INTERVAL_MS = 50
/**
 * How often the reply so far is saved. Each save rewrites the whole message,
 * and the end of the turn always saves; this only bounds what a crash loses.
 */
const PERSIST_INTERVAL_MS = 1000
/** Wait before naming a new chat, so the reply's first request goes out first. */
const TITLE_DELAY_MS = 500
const TITLE_MAX_TOKENS = 24
/** Tools that change workspace files; their results tell the page to reload the file tree. */
const WORKSPACE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'write_pdf', 'move_file'])

export interface TurnServiceDeps {
  conversations: Pick<ConversationService,
    'getConversation' | 'updateConversation' | 'listMessages' | 'createMessage'
    | 'updateMessage' | 'deleteMessageBranch' | 'selectBranch'>
  llm: Pick<LlmService, 'orchestrateStream' | 'compactConversation' | 'cancelStream' | 'generateTitle'>
  getSettings: () => Settings
  /** The folder the app has open now; a chat without a folder of its own takes it. */
  getOpenWorkspace: () => string | null
  /**
   * Runs a reply's tool calls in the chat's folder, recording the files they
   * change under the reply so they can be undone.
   */
  createToolRunner: (replyMessageId: string, workspaceRoot: string | null) => (toolCall: ToolCall, signal: AbortSignal) => Promise<ToolCall>
  /** Name of the context profile a chat's system prompt is built from. */
  getProfileName: (profileId: string | null | undefined) => string | null
  /** Sends an event to the page. */
  emit: (event: TurnEvent) => void
  /** Shorter intervals for tests. */
  timing?: { updateMs?: number; persistMs?: number; titleDelayMs?: number }
}

interface RunningTurn {
  live: LiveTurn
  /** Type of the last chunk that carried output, to tell where thinking resumes. */
  lastChunk: StreamChunk['type'] | null
  /** Tool calls changed since the last update sent. */
  toolCallsChanged: boolean
  /**
   * The context the reply's final request used. LlmService sends it only for
   * a reply that finished normally (not stopped, not failed).
   */
  usage: ContextUsage | null
  updateTimer: ReturnType<typeof setTimeout> | null
  persistTimer: ReturnType<typeof setTimeout> | null
  /** Settles once the turn is over and saved. */
  done: Promise<void>
}

/** A chat's messages in the shape an LLM request carries them. */
export function toRequestMessages(messages: Message[]): LLMRequest['messages'] {
  return messages.map((m) => {
    const toolCalls = m.role === 'assistant' ? parseStoredToolCalls(m.toolCalls) : undefined
    return {
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      ...(m.role === 'user' && m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(m.role === 'assistant' && m.thinking ? { thinking: m.thinking } : {})
    }
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Ends with a period, so another sentence can follow it. */
function asSentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * Runs chat turns in the main process, one at a time per chat and any number
 * of chats at once: saves the prompt, writes the reply as it streams (to the
 * database, and to the page as turn events), and finishes it even when the
 * page reloads or another chat is on screen. Compactions are turns too. No
 * Electron imports.
 */
export class TurnService {
  private deps: TurnServiceDeps
  private turns = new Map<string, RunningTurn>()
  private titlesInFlight = new Set<string>()
  /** Set on shutdown: the database is closing, so nothing more is written. */
  private closed = false
  private updateMs: number
  private persistMs: number
  private titleDelayMs: number

  constructor(deps: TurnServiceDeps) {
    this.deps = deps
    this.updateMs = deps.timing?.updateMs ?? UPDATE_INTERVAL_MS
    this.persistMs = deps.timing?.persistMs ?? PERSIST_INTERVAL_MS
    this.titleDelayMs = deps.timing?.titleDelayMs ?? TITLE_DELAY_MS
  }

  /** Every running turn, as far as it has got. */
  listActive(): LiveTurn[] {
    return [...this.turns.values()].map((turn) => this.snapshot(turn))
  }

  isRunning(conversationId: string): boolean {
    return this.turns.has(conversationId)
  }

  /** Settles when the chat's running turn is over (at once if there is none). */
  whenIdle(conversationId: string): Promise<void> {
    return this.turns.get(conversationId)?.done ?? Promise.resolve()
  }

  /**
   * Starts a reply and returns the branch now on screen, with the prompt and
   * the empty reply. Everything up to the first request runs synchronously,
   * so two starts for one chat can't both get through.
   */
  start(request: TurnStartRequest): Message[] {
    const { conversationId } = request
    this.assertCanStart(conversationId)
    const { conversations, getSettings } = this.deps

    const conversation = conversations.getConversation(conversationId)
    if (!conversation) throw new Error('This chat no longer exists.')
    const settings = getSettings()
    const existing = conversations.listMessages(conversationId)

    const promptedMessage = request.kind === 'send'
      ? null
      : existing.find((m) => m.id === request.userMessageId && m.role === 'user')
    if (request.kind !== 'send' && !promptedMessage) throw new Error('That message is no longer in this chat.')

    if (request.kind === 'send' && !request.content.trim() && !request.attachments?.length) {
      throw new Error('There is nothing to send.')
    }
    if (request.kind === 'edit' && !request.content.trim() && !promptedMessage!.attachments?.length) {
      throw new Error('There is nothing to send.')
    }

    // A chat's first message settles its provider, model and folder.
    const isFirstMessage = existing.length === 0
    const configuredProvider = settings.activeProvider
    const configuredModel = settings.providers[configuredProvider]?.selectedModel ?? settings.defaultModel
    const provider: ProviderName = isFirstMessage ? configuredProvider : (conversation.provider || configuredProvider)
    const model = isFirstMessage ? configuredModel : (conversation.model || configuredModel)
    const workspaceRoot = conversation.workspacePath ?? this.deps.getOpenWorkspace()
    if (isFirstMessage) {
      conversations.updateConversation(conversationId, { provider, model, workspacePath: workspaceRoot })
    }

    // The prompt: a new message, an edited copy beside the original, or (a
    // retry) the original itself, with the branch on screen ending at it.
    if (request.kind === 'send') {
      conversations.createMessage({ conversationId, role: 'user', content: request.content, attachments: request.attachments })
    } else if (request.kind === 'edit') {
      conversations.createMessage({
        conversationId,
        role: 'user',
        content: request.content.trim(),
        attachments: promptedMessage!.attachments,
        parentId: promptedMessage!.parentId
      })
    } else {
      conversations.selectBranch(conversationId, request.userMessageId, { exact: true })
    }

    const llmRequest: LLMRequest = {
      conversationId,
      messages: toRequestMessages(conversations.listMessages(conversationId)),
      model,
      provider,
      ...(settings.temperatureEnabled ? { temperature: settings.temperature } : {}),
      ...(settings.maxTokensEnabled ? { maxTokens: settings.maxTokens } : {})
    }

    const lastRequest: ConversationRequestInfo = {
      sentAt: new Date().toISOString(),
      provider,
      model,
      temperature: llmRequest.temperature ?? null,
      maxTokens: llmRequest.maxTokens ?? null,
      reasoningEnabled: settings.reasoningEnabled,
      searchToolsEnabled: settings.searchToolsEnabled,
      contextProfile: this.deps.getProfileName(conversation.profileId),
      // The meter keeps showing the previous reply's use until this one reports its own.
      usage: conversation.lastRequest?.usage ?? null
    }
    conversations.updateConversation(conversationId, { lastRequest })

    const reply = conversations.createMessage({ conversationId, role: 'assistant', content: '' })
    const turn = this.register(conversationId, 'reply', reply.id)
    const runTool = this.deps.createToolRunner(reply.id, workspaceRoot)

    turn.done = this.runReply(turn, llmRequest, runTool)
    this.emitConversation(conversationId)
    this.maybeNameChat(conversationId, provider, model)

    return conversations.listMessages(conversationId)
  }

  /**
   * Starts a compaction: the model summarizes the chat so far, and the
   * summary is added as a 'system' message that stands in for everything
   * before it (see LlmService.buildHistory).
   */
  compact(conversationId: string, options: { auto?: { usedShare: number } } = {}): CompactStartResult {
    this.assertCanStart(conversationId)
    const { conversations, getSettings } = this.deps

    const conversation = conversations.getConversation(conversationId)
    if (!conversation) throw new Error('This chat no longer exists.')
    const settings = getSettings()
    const messages = conversations.listMessages(conversationId)
    const sinceSummary = messages.slice(messages.map((m) => m.role).lastIndexOf('system') + 1)
    if (!sinceSummary.some((m) => m.role === 'assistant')) return 'nothing_to_compact'

    const provider = conversation.provider || settings.activeProvider
    const request: LLMRequest = {
      conversationId,
      messages: toRequestMessages(messages),
      model: conversation.model || settings.providers[provider]?.selectedModel || settings.defaultModel,
      provider,
      ...(settings.temperatureEnabled ? { temperature: settings.temperature } : {}),
      ...(settings.maxTokensEnabled ? { maxTokens: settings.maxTokens } : {})
    }

    const turn = this.register(conversationId, 'compact', null)
    if (options.auto) {
      this.notice(turn, 'info', `This chat used ${Math.round(options.auto.usedShare * 100)}% of the model's context window, so it is being compacted: the model is summarizing it to continue from.`)
    }
    turn.done = this.runCompaction(turn, request, options.auto !== undefined)
    return 'started'
  }

  /** Stops a chat's running turn. What it wrote so far is kept. */
  cancel(conversationId: string): void {
    const turn = this.turns.get(conversationId)
    if (turn) this.deps.llm.cancelStream(turn.live.turnId)
  }

  /** Stops every running turn. What each wrote so far is kept. */
  cancelAll(): void {
    for (const conversationId of this.turns.keys()) this.cancel(conversationId)
  }

  /**
   * Before the app quits: stops every turn and saves what each has written,
   * right now, while the database is still open. Nothing is written after.
   */
  shutdown(): void {
    for (const turn of this.turns.values()) {
      this.deps.llm.cancelStream(turn.live.turnId)
      this.clearTimers(turn)
      this.persist(turn)
    }
    this.closed = true
  }

  // ─── Running a turn ───────────────────────────────────────────────────────

  private assertCanStart(conversationId: string): void {
    if (this.closed) throw new Error('The app is closing.')
    if (this.turns.has(conversationId)) {
      throw new Error('This chat is still working on its last turn. Stop it or wait for it to finish.')
    }
  }

  private register(conversationId: string, kind: TurnKind, messageId: string | null): RunningTurn {
    const turn: RunningTurn = {
      live: {
        turnId: randomUUID(),
        conversationId,
        kind,
        messageId,
        seq: 0,
        content: '',
        thinking: '',
        toolCalls: [],
        phase: 'waiting'
      },
      lastChunk: null,
      toolCallsChanged: false,
      usage: null,
      updateTimer: null,
      persistTimer: null,
      done: Promise.resolve()
    }
    this.turns.set(conversationId, turn)
    this.deps.emit({ type: 'started', turn: this.snapshot(turn) })
    return turn
  }

  private async runReply(
    turn: RunningTurn,
    request: LLMRequest,
    runTool: (toolCall: ToolCall, signal: AbortSignal) => Promise<ToolCall>
  ): Promise<void> {
    const sink: StreamSink = { send: (chunk) => this.onChunk(turn, chunk) }
    try {
      await this.deps.llm.orchestrateStream(request, turn.live.turnId, sink, runTool)
    } catch (err) {
      this.notice(turn, 'error', errorMessage(err))
    } finally {
      this.finishReply(turn)
    }
  }

  private async runCompaction(turn: RunningTurn, request: LLMRequest, auto = false): Promise<void> {
    const { conversationId } = turn.live
    try {
      const result = await this.deps.llm.compactConversation(request, turn.live.turnId)
      if (result && !this.closed && this.deps.conversations.getConversation(conversationId)) {
        this.deps.conversations.createMessage({ conversationId, role: 'system', content: result.summary })
        this.recordUsage(conversationId, result.usage)
        this.notice(turn, 'success', auto
          ? 'Chat compacted automatically. Replies from now on see the summary in place of the earlier messages.'
          : 'Chat compacted. It continues from the summary of the earlier messages.')
      }
    } catch (err) {
      this.notice(turn, 'error', auto
        ? `Could not compact the chat automatically: ${asSentence(errorMessage(err))} Compact under the message box tries again.`
        : `Could not compact the chat: ${errorMessage(err)}`)
    } finally {
      this.turns.delete(conversationId)
      this.emitConversation(conversationId)
      this.deps.emit({ type: 'finished', turnId: turn.live.turnId, conversationId, kind: 'compact' })
    }
  }

  private onChunk(turn: RunningTurn, chunk: StreamChunk): void {
    const live = turn.live
    switch (chunk.type) {
      case 'thinking': {
        const incoming = chunk.content || ''
        // Thinking that resumes after text or tools starts a new block.
        if (incoming && live.thinking && turn.lastChunk && turn.lastChunk !== 'thinking') {
          live.thinking += THINKING_BLOCK_SEPARATOR
        }
        live.thinking += incoming
        this.setPhase(turn, 'thinking')
        this.scheduleUpdate(turn)
        break
      }

      case 'text':
        live.content += chunk.content || ''
        this.setPhase(turn, 'text')
        this.scheduleUpdate(turn)
        break

      case 'tool_call':
        if (chunk.toolCall) {
          // Where in the text the call was made, so the chat shows it between the prose around it.
          live.toolCalls = [...live.toolCalls, { ...chunk.toolCall, contentOffset: live.content.length }]
          turn.toolCallsChanged = true
          this.setPhase(turn, 'tools')
          this.sendUpdate(turn)
        }
        break

      case 'tool_result':
        if (chunk.toolCall) {
          const result = chunk.toolCall
          live.toolCalls = live.toolCalls.map((tc) =>
            tc.id === result.id ? { ...result, contentOffset: tc.contentOffset } : tc
          )
          turn.toolCallsChanged = true
          this.setPhase(turn, 'waiting')
          this.sendUpdate(turn)
          if (WORKSPACE_WRITE_TOOLS.has(result.name)) {
            this.deps.emit({ type: 'filesChanged', conversationId: live.conversationId })
          }
        }
        break

      case 'notice':
        if (chunk.content) this.notice(turn, 'warning', chunk.content)
        break

      case 'usage':
        if (chunk.usage) {
          turn.usage = chunk.usage
          this.recordUsage(live.conversationId, chunk.usage)
        }
        break

      case 'error':
        this.notice(turn, 'error', chunk.error || 'Streaming error')
        break

      case 'done':
        break
    }
    if (chunk.type !== 'notice' && chunk.type !== 'usage' && chunk.type !== 'done') {
      turn.lastChunk = chunk.type
    }
  }

  private setPhase(turn: RunningTurn, phase: TurnPhase): void {
    turn.live.phase = phase
  }

  /** Text and thinking arrive in many small pieces; the page gets them a few at a time. */
  private scheduleUpdate(turn: RunningTurn): void {
    if (turn.updateTimer) return
    turn.updateTimer = setTimeout(() => {
      turn.updateTimer = null
      this.sendUpdate(turn)
    }, this.updateMs)
  }

  private sendUpdate(turn: RunningTurn): void {
    if (turn.updateTimer) {
      clearTimeout(turn.updateTimer)
      turn.updateTimer = null
    }
    const live = turn.live
    live.seq += 1
    this.deps.emit({
      type: 'update',
      turnId: live.turnId,
      conversationId: live.conversationId,
      seq: live.seq,
      content: live.content,
      thinking: live.thinking,
      phase: live.phase,
      ...(turn.toolCallsChanged ? { toolCalls: live.toolCalls } : {})
    })
    turn.toolCallsChanged = false
    this.schedulePersist(turn)
  }

  private schedulePersist(turn: RunningTurn): void {
    if (turn.persistTimer || turn.live.messageId === null) return
    turn.persistTimer = setTimeout(() => {
      turn.persistTimer = null
      this.persist(turn)
    }, this.persistMs)
  }

  private persist(turn: RunningTurn): void {
    const { messageId, content, thinking, toolCalls } = turn.live
    if (messageId === null || this.closed) return
    try {
      this.deps.conversations.updateMessage(messageId, {
        content,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined
      })
    } catch (err) {
      console.warn('[TurnService] Could not save the reply so far:', err)
    }
  }

  private clearTimers(turn: RunningTurn): void {
    if (turn.updateTimer) clearTimeout(turn.updateTimer)
    if (turn.persistTimer) clearTimeout(turn.persistTimer)
    turn.updateTimer = null
    turn.persistTimer = null
  }

  /**
   * Saves the finished reply. One with no output at all (stopped before
   * anything came back) is removed, so a retry's earlier reply shows again.
   */
  private finishReply(turn: RunningTurn): void {
    // Text still waiting for its update goes out first, so the page has it all.
    if (turn.updateTimer) this.sendUpdate(turn)
    this.clearTimers(turn)
    const { conversationId, messageId, content, thinking, toolCalls } = turn.live

    if (!this.closed && messageId !== null) {
      try {
        if (!content && !thinking && toolCalls.length === 0) {
          this.deps.conversations.deleteMessageBranch(conversationId, messageId)
        } else {
          this.persist(turn)
        }
      } catch (err) {
        this.notice(turn, 'error', `Could not save the reply: ${errorMessage(err)}`)
      }
    }

    this.turns.delete(conversationId)
    this.emitConversation(conversationId)
    this.deps.emit({ type: 'finished', turnId: turn.live.turnId, conversationId, kind: 'reply' })
    this.maybeAutoCompact(conversationId, turn.usage)
  }

  /**
   * Auto-compact (Settings): a reply that finished normally and filled
   * 80% of a known context window, or left fewer than 32k tokens free
   * (see autoCompactThreshold), is followed at once
   * by a compaction, so the next message starts from a summary instead of
   * overflowing. It runs as its own turn (shown, and stoppable, like Compact).
   * Nothing happens when the window is unknown, the reply was stopped or
   * failed (no usage), or the setting is off.
   */
  private maybeAutoCompact(conversationId: string, usage: ContextUsage | null): void {
    if (this.closed || !usage || !this.deps.getSettings().autoCompact) return
    if (!shouldAutoCompact(usage)) return
    const usedShare = contextRatio(usage) ?? 1
    try {
      this.compact(conversationId, { auto: { usedShare } })
    } catch (err) {
      this.deps.emit({
        type: 'notice',
        conversationId,
        level: 'warning',
        message: `This chat is nearly full, but it could not be compacted automatically: ${errorMessage(err)}`
      })
    }
  }

  // ─── Chat record ──────────────────────────────────────────────────────────

  /** The finished reply's context use, for the chat's context meter. */
  private recordUsage(conversationId: string, usage: ContextUsage): void {
    if (this.closed) return
    try {
      const previous = this.deps.conversations.getConversation(conversationId)?.lastRequest
      if (!previous) return
      this.deps.conversations.updateConversation(conversationId, { lastRequest: { ...previous, usage } })
      this.emitConversation(conversationId)
    } catch {
      // Display-only metadata; never interrupt the chat for it.
    }
  }

  private emitConversation(conversationId: string): void {
    if (this.closed) return
    try {
      const conversation = this.deps.conversations.getConversation(conversationId)
      if (conversation) this.deps.emit({ type: 'conversation', conversation })
    } catch {
      // The database may be closing.
    }
  }

  private notice(turn: RunningTurn, level: 'info' | 'success' | 'warning' | 'error', message: string): void {
    this.deps.emit({ type: 'notice', conversationId: turn.live.conversationId, level, message })
  }

  private snapshot(turn: RunningTurn): LiveTurn {
    return { ...turn.live, toolCalls: [...turn.live.toolCalls] }
  }

  /** Names a chat still called "New Chat" after its first prompt. Best-effort. */
  private maybeNameChat(conversationId: string, provider: ProviderName, model: string): void {
    if (this.titlesInFlight.has(conversationId)) return
    this.titlesInFlight.add(conversationId)

    const isUntitled = () => {
      const title = this.deps.conversations.getConversation(conversationId)?.title
      return !!title && title.trim().toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase()
    }

    void (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, this.titleDelayMs))
        if (this.closed || !isUntitled()) return

        const firstPrompt = this.deps.conversations.listMessages(conversationId)
          .find((message) => message.role === 'user')?.content.trim()
        if (!firstPrompt) return

        const generated = await this.deps.llm.generateTitle({ prompt: firstPrompt, provider, model, maxTokens: TITLE_MAX_TOKENS })
        const title = sanitizeGeneratedChatTitle(generated)
        if (!title || title === DEFAULT_CHAT_TITLE || this.closed || !isUntitled()) return

        this.deps.conversations.updateConversation(conversationId, { title })
        this.emitConversation(conversationId)
      } catch {
        // The chat keeps its placeholder title.
      } finally {
        this.titlesInFlight.delete(conversationId)
      }
    })()
  }
}
