import { useState, useRef, useCallback, useEffect } from 'react'
import { useConversationStore, useSettingsStore, useUIStore } from '@/store'
import { formatError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import { DEFAULT_CHAT_TITLE, sanitizeGeneratedChatTitle } from '@/lib/chatTitle'
import { toToolCallRecords } from '@/lib/toolCallRecords'
import type {
  StreamChunk,
  ToolCall,
  LLMRequest,
  Message,
  Attachment,
  ProviderName,
  ConversationRequestInfo
} from '@/types'

const STREAM_THROTTLE_MS = 50
const THINKING_ACTIVE_WINDOW_MS = 1500
const THINKING_BLOCK_SEPARATOR = '\n\n---\n\n'
const AUTO_TITLE_PLACEHOLDER = DEFAULT_CHAT_TITLE
const AUTO_TITLE_DELAY_MS = 500
const AUTO_TITLE_MAX_TOKENS = 24

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isUntitledConversationTitle(title: string | undefined | null): boolean {
  if (!title) return false
  return title.trim().toLowerCase() === AUTO_TITLE_PLACEHOLDER.toLowerCase()
}

function findLastUserMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i]
    }
  }
  return undefined
}

/**
 * Save a snapshot of the request settings on the conversation so the chat
 * info popover can show what was actually sent. Best-effort: failures are
 * ignored because this is display-only metadata.
 */
function recordRequestInfo(
  conversationId: string,
  info: Omit<ConversationRequestInfo, 'contextProfile'>
): void {
  void (async () => {
    let contextProfile: string | null = null
    try {
      const { profiles, activeProfileId } = await window.redLedger.listContextProfiles()
      contextProfile = profiles.find((profile) => profile.id === activeProfileId)?.name ?? null
    } catch {
      // Profile name is optional.
    }

    const lastRequest: ConversationRequestInfo = { ...info, contextProfile }
    try {
      await window.redLedger.updateConversation(conversationId, { lastRequest })
      useConversationStore.setState((state) => ({
        conversations: state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, lastRequest }
            : conversation
        )
      }))
    } catch {
      // Display-only metadata; never interrupt the chat for it.
    }
  })()
}

/**
 * React hook that manages the LLM streaming lifecycle.
 *
 * Flow: user sends message -> save to DB -> create a persisted assistant
 * placeholder -> stream chunks into that message -> on done/cancel, finalize
 * the persisted message so chat switches do not orphan the stream.
 *
 * Streaming content updates are throttled to avoid excessive re-renders.
 */
export function useStreaming() {
  const [isStreaming, setIsStreaming] = useState(false)
  const [isReceivingThinking, setIsReceivingThinking] = useState(false)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)

  const cleanupRef = useRef<(() => void) | null>(null)
  const tempMessageIdRef = useRef<string | null>(null)
  const tempConversationIdRef = useRef<string | null>(null)
  const contentRef = useRef('')
  const thinkingRef = useRef('')
  const toolCallsRef = useRef<ToolCall[]>([])
  const lastStreamChunkTypeRef = useRef<StreamChunk['type'] | null>(null)
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const thinkingActivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleGenerationInFlightRef = useRef(new Set<string>())
  const persistenceErrorNotifiedRef = useRef(false)

  const clearThinkingActivity = useCallback(() => {
    setIsReceivingThinking(false)
    if (thinkingActivityTimerRef.current) {
      clearTimeout(thinkingActivityTimerRef.current)
      thinkingActivityTimerRef.current = null
    }
  }, [])

  const markThinkingActivity = useCallback(() => {
    setIsReceivingThinking(true)
    if (thinkingActivityTimerRef.current) {
      clearTimeout(thinkingActivityTimerRef.current)
    }
    thinkingActivityTimerRef.current = setTimeout(() => {
      thinkingActivityTimerRef.current = null
      setIsReceivingThinking(false)
    }, THINKING_ACTIVE_WINDOW_MS)
  }, [])

  const reportPersistenceError = useCallback((err: unknown) => {
    if (persistenceErrorNotifiedRef.current) return

    persistenceErrorNotifiedRef.current = true
    notify({
      type: 'error',
      message: formatError(err)
    })
  }, [])

  const buildStreamingMessageUpdate = useCallback((contentOverride?: string): Partial<Message> => ({
    content: contentOverride ?? contentRef.current,
    thinking: thinkingRef.current || undefined,
    toolCalls: toolCallsRef.current.length > 0
      ? JSON.stringify(toolCallsRef.current)
      : undefined
  }), [])

  const persistStreamingMessage = useCallback((messageId: string, data: Partial<Message>) => {
    void window.redLedger.updateMessage(messageId, data).catch((err) => {
      reportPersistenceError(err)
    })
  }, [reportPersistenceError])

  const finalizeTempMessage = useCallback(async (tempId: string, conversationId: string) => {
    const finalContent = contentRef.current
    const hasAnyOutput = Boolean(
      finalContent
      || thinkingRef.current
      || toolCallsRef.current.length > 0
    )

    const clearTempRefsIfCurrent = () => {
      if (tempMessageIdRef.current === tempId) {
        tempMessageIdRef.current = null
        setStreamingMessageId(null)
      }
      if (tempConversationIdRef.current === conversationId) {
        tempConversationIdRef.current = null
      }
    }

    try {
      if (!hasAnyOutput) {
        await window.redLedger.deleteMessagesFrom(conversationId, tempId)
        useConversationStore.setState((state) => ({
          messages: state.messages.filter((m) => m.id !== tempId)
        }))
        return
      }

      const finalUpdate = buildStreamingMessageUpdate(
        finalContent ? undefined : '_(No text response)_'
      )

      useConversationStore.getState().updateMessage(tempId, finalUpdate)
      await window.redLedger.updateMessage(tempId, finalUpdate)
      useConversationStore.getState().touchConversation(conversationId)
    } catch (err) {
      reportPersistenceError(err)
    } finally {
      clearTempRefsIfCurrent()
      persistenceErrorNotifiedRef.current = false
    }
  }, [buildStreamingMessageUpdate, reportPersistenceError])

  const maybeGenerateConversationTitle = useCallback((
    conversationId: string,
    provider: ProviderName,
    model: string
  ) => {
    if (titleGenerationInFlightRef.current.has(conversationId)) return

    titleGenerationInFlightRef.current.add(conversationId)

    void (async () => {
      try {
        await delay(AUTO_TITLE_DELAY_MS)

        const conversation = await window.redLedger.getConversation(conversationId)
        if (!conversation || !isUntitledConversationTitle(conversation.title)) {
          return
        }

        const persistedMessages = await window.redLedger.listMessages(conversationId)
        const firstUserMessage = persistedMessages.find((message) => message.role === 'user')
        const firstPrompt = firstUserMessage?.content.trim() || ''
        if (!firstPrompt) return

        const generatedTitle = await window.redLedger.generateTitle({
          prompt: firstPrompt,
          provider,
          model,
          maxTokens: AUTO_TITLE_MAX_TOKENS
        })
        const sanitizedTitle = sanitizeGeneratedChatTitle(generatedTitle)
        if (!sanitizedTitle || sanitizedTitle === AUTO_TITLE_PLACEHOLDER) return

        const conversationBeforeRename = await window.redLedger.getConversation(conversationId)
        if (!conversationBeforeRename || !isUntitledConversationTitle(conversationBeforeRename.title)) {
          return
        }

        await useConversationStore.getState().renameConversation(conversationId, sanitizedTitle)
      } catch {
        // Keep placeholder title if generation fails.
      } finally {
        titleGenerationInFlightRef.current.delete(conversationId)
      }
    })()
  }, [])

  const cancel = useCallback(() => {
    const tempId = tempMessageIdRef.current
    const tempConversationId = tempConversationIdRef.current

    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }
    if (throttleRef.current) {
      clearTimeout(throttleRef.current)
      throttleRef.current = null
    }

    if (tempId && tempConversationId) {
      void finalizeTempMessage(tempId, tempConversationId)
    } else if (tempId) {
      useConversationStore.setState((state) => ({
        messages: state.messages.filter((m) => m.id !== tempId)
      }))
      tempMessageIdRef.current = null
      tempConversationIdRef.current = null
      setStreamingMessageId(null)
    }

    setIsStreaming(false)
    clearThinkingActivity()
    contentRef.current = ''
    thinkingRef.current = ''
    toolCallsRef.current = []
    lastStreamChunkTypeRef.current = null
    setStreamingMessageId(null)
    persistenceErrorNotifiedRef.current = false
  }, [clearThinkingActivity, finalizeTempMessage])

  const sendMessage = useCallback(async (content: string, attachments?: Attachment[]) => {
    const store = useConversationStore.getState()
    const conversationId = store.activeConversationId
    const activeConversation = store.conversations.find((c) => c.id === conversationId) || null
    const currentSettings = useSettingsStore.getState().settings
    if (!conversationId || !currentSettings) return
    const workspacePath = useUIStore.getState().workspacePath

    setIsStreaming(true)
    clearThinkingActivity()
    contentRef.current = ''
    thinkingRef.current = ''
    toolCallsRef.current = []
    lastStreamChunkTypeRef.current = null
    persistenceErrorNotifiedRef.current = false

    try {
      const configuredProvider = currentSettings.activeProvider
      const configuredModel = currentSettings.providers[configuredProvider].selectedModel
        ?? currentSettings.defaultModel
      let isFirstMessage = store.messages.length === 0
      if (isFirstMessage) {
        const persistedMessages = await window.redLedger.listMessages(conversationId)
        isFirstMessage = persistedMessages.length === 0
      }

      const lockedProvider = isFirstMessage
        ? configuredProvider
        : (activeConversation?.provider || configuredProvider)
      const lockedModel = isFirstMessage
        ? configuredModel
        : (activeConversation?.model || configuredModel)

      if (isFirstMessage) {
        await window.redLedger.updateConversation(conversationId, {
          provider: lockedProvider,
          model: lockedModel,
          workspacePath
        })

        useConversationStore.setState((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                ...conversation,
                provider: lockedProvider,
                model: lockedModel,
                workspacePath
              }
              : conversation
          )
        }))
      }

      // 1. Save user message to DB
      await store.addMessage({
        conversationId,
        role: 'user',
        content,
        attachments
      })

      // 2. Build the message history for the LLM request
      const conversationMessages = await window.redLedger.listMessages(conversationId)
      const messages = conversationMessages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        ...(m.role === 'user' && m.attachments && m.attachments.length > 0
          ? { attachments: m.attachments }
          : {}),
        ...(m.role === 'assistant' && m.toolCalls
          ? { toolCalls: toToolCallRecords(m.toolCalls) }
          : {})
      }))

      const request: LLMRequest = {
        conversationId,
        messages,
        model: lockedModel,
        provider: lockedProvider,
        ...(currentSettings.temperatureEnabled ? { temperature: currentSettings.temperature } : {}),
        ...(currentSettings.maxTokensEnabled ? { maxTokens: currentSettings.maxTokens } : {})
      }

      recordRequestInfo(conversationId, {
        sentAt: new Date().toISOString(),
        provider: lockedProvider,
        model: lockedModel,
        temperature: request.temperature ?? null,
        maxTokens: request.maxTokens ?? null,
        reasoningEnabled: currentSettings.reasoningEnabled,
        searchToolsEnabled: currentSettings.searchToolsEnabled
      })

      // 3. Create a persisted assistant placeholder so chat switches do not orphan the stream.
      const tempMessage = await store.addMessage({
        conversationId,
        role: 'assistant',
        content: ''
      })
      const tempId = tempMessage.id
      tempMessageIdRef.current = tempId
      tempConversationIdRef.current = conversationId
      setStreamingMessageId(tempId)

      // Helper: flush accumulated content to the temp message in the store
      const flushToStore = () => {
        const update = buildStreamingMessageUpdate()
        useConversationStore.getState().updateMessage(tempId, update)
        persistStreamingMessage(tempId, update)
      }

      // Helper: throttled store update for text chunks
      const scheduleFlush = () => {
        if (!throttleRef.current) {
          throttleRef.current = setTimeout(() => {
            throttleRef.current = null
            flushToStore()
          }, STREAM_THROTTLE_MS)
        }
      }

      // 4. Start the stream
      const cleanup = window.redLedger.sendMessage(request, (chunk: StreamChunk) => {
        switch (chunk.type) {
          case 'thinking': {
            const incomingThinking = chunk.content || ''
            const isResumedThinking = Boolean(
              incomingThinking &&
              thinkingRef.current &&
              lastStreamChunkTypeRef.current &&
              lastStreamChunkTypeRef.current !== 'thinking'
            )
            if (isResumedThinking) {
              thinkingRef.current += THINKING_BLOCK_SEPARATOR
            }
            thinkingRef.current += incomingThinking
            markThinkingActivity()
            scheduleFlush()
            lastStreamChunkTypeRef.current = 'thinking'
            break
          }

          case 'text': {
            // Thinking ends as soon as we receive the first non-thinking output chunk.
            clearThinkingActivity()
            contentRef.current += chunk.content || ''
            scheduleFlush()
            lastStreamChunkTypeRef.current = 'text'
            break
          }

          case 'tool_call': {
            // Tool activity is non-thinking output; hide thinking indicator immediately.
            clearThinkingActivity()
            if (chunk.toolCall) {
              // Stamp the current text length so the UI can interleave tool calls
              const stamped = { ...chunk.toolCall, contentOffset: contentRef.current.length }
              toolCallsRef.current = [...toolCallsRef.current, stamped]
              flushToStore()
            }
            lastStreamChunkTypeRef.current = 'tool_call'
            break
          }

          case 'tool_result': {
            // Tool activity is non-thinking output; hide thinking indicator immediately.
            clearThinkingActivity()
            if (chunk.toolCall) {
              toolCallsRef.current = toolCallsRef.current.map((tc) =>
                tc.id === chunk.toolCall!.id
                  ? { ...chunk.toolCall!, contentOffset: tc.contentOffset }
                  : tc
              )
              flushToStore()
            }
            lastStreamChunkTypeRef.current = 'tool_result'
            break
          }

          case 'notice': {
            if (chunk.content) {
              notify({ type: 'warning', message: chunk.content })
            }
            break
          }

          case 'error': {
            clearThinkingActivity()
            notify({
              type: 'error',
              message: chunk.error || 'Streaming error'
            })
            lastStreamChunkTypeRef.current = 'error'
            break
          }

          case 'done': {
            clearThinkingActivity()
            // Cancel any pending throttled flush
            if (throttleRef.current) {
              clearTimeout(throttleRef.current)
              throttleRef.current = null
            }

            cleanup()
            void finalizeTempMessage(tempId, conversationId)

            setIsStreaming(false)
            contentRef.current = ''
            thinkingRef.current = ''
            toolCallsRef.current = []
            lastStreamChunkTypeRef.current = null
            cleanupRef.current = null
            break
          }
        }
      })

      cleanupRef.current = cleanup
      maybeGenerateConversationTitle(conversationId, lockedProvider, lockedModel)

    } catch (err) {
      if (tempMessageIdRef.current && tempConversationIdRef.current) {
        await finalizeTempMessage(tempMessageIdRef.current, tempConversationIdRef.current)
      } else if (tempMessageIdRef.current) {
        const tempId = tempMessageIdRef.current
        useConversationStore.setState((state) => ({
          messages: state.messages.filter((m) => m.id !== tempId)
        }))
        tempMessageIdRef.current = null
        tempConversationIdRef.current = null
        setStreamingMessageId(null)
      }
      setIsStreaming(false)
      clearThinkingActivity()
      contentRef.current = ''
      thinkingRef.current = ''
      toolCallsRef.current = []
      lastStreamChunkTypeRef.current = null
      persistenceErrorNotifiedRef.current = false
      notify({
        type: 'error',
        message: formatError(err)
      })
    }
  }, [
    buildStreamingMessageUpdate,
    clearThinkingActivity,
    finalizeTempMessage,
    markThinkingActivity,
    maybeGenerateConversationTitle,
    persistStreamingMessage
  ])

  useEffect(() => {
    const titleGenerationInFlight = titleGenerationInFlightRef.current

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
      if (throttleRef.current) {
        clearTimeout(throttleRef.current)
        throttleRef.current = null
      }
      if (thinkingActivityTimerRef.current) {
        clearTimeout(thinkingActivityTimerRef.current)
        thinkingActivityTimerRef.current = null
      }
      titleGenerationInFlight.clear()
    }
  }, [])

  const retry = useCallback(async () => {
    if (isStreaming) return

    const store = useConversationStore.getState()
    const lastUserMsg = findLastUserMessage(store.messages)
    if (!lastUserMsg) return

    // Delete the user message and everything after it from DB + store
    await store.deleteMessagesFrom(lastUserMsg.id)

    await sendMessage(lastUserMsg.content, lastUserMsg.attachments)
  }, [isStreaming, sendMessage])

  const editLastUserMessage = useCallback(async (content: string) => {
    if (isStreaming) return

    const store = useConversationStore.getState()
    const lastUserMsg = findLastUserMessage(store.messages)
    if (!lastUserMsg) return

    const nextContent = content.trim()
    const hasAttachments = Boolean(lastUserMsg.attachments && lastUserMsg.attachments.length > 0)
    if (!nextContent && !hasAttachments) return

    await store.deleteMessagesFrom(lastUserMsg.id)
    await sendMessage(nextContent, lastUserMsg.attachments)
  }, [isStreaming, sendMessage])

  return {
    isStreaming,
    isReceivingThinking,
    streamingMessageId,
    sendMessage,
    cancel,
    retry,
    editLastUserMessage
  }
}
