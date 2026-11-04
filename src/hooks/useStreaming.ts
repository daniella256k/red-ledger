import { useCallback } from 'react'
import { useConversationStore, useTurnStore } from '@/store'
import { formatError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import type { Attachment, TurnStartRequest } from '@/types'

/**
 * The chat on screen's turns: starting a reply (send, retry, edit) or a
 * compaction, stopping it, and whether one is running. The main process runs
 * each turn and saves it as it goes (see TurnEvent), so switching chats or
 * reloading the page leaves it running, and other chats can reply meanwhile.
 *
 * Each value is selected on its own, so a streaming reply re-renders only
 * what shows its text, not everything that asks whether a chat is busy.
 */
export function useStreaming() {
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const isStreaming = useTurnStore((s) => !!activeConversationId && !!s.turns[activeConversationId])
  const isCompacting = useTurnStore((s) => !!activeConversationId && s.turns[activeConversationId]?.kind === 'compact')
  const streamingMessageId = useTurnStore((s) =>
    (activeConversationId ? s.turns[activeConversationId]?.messageId : null) ?? null
  )
  const isReceivingThinking = useTurnStore((s) =>
    !!activeConversationId && s.turns[activeConversationId]?.phase === 'thinking'
  )

  /** Starts a reply and shows the branch it is on: the prompt and the empty reply. */
  const start = useCallback(async (request: TurnStartRequest) => {
    try {
      const messages = await window.redLedger.startTurn(request)
      if (useConversationStore.getState().activeConversationId === request.conversationId) {
        useConversationStore.setState({ messages })
      }
      useConversationStore.getState().touchConversation(request.conversationId)
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  }, [])

  const sendMessage = useCallback(async (content: string, attachments?: Attachment[]) => {
    // Read at call time: a New Chat draft becomes a chat just before its first send.
    const conversationId = useConversationStore.getState().activeConversationId
    if (!conversationId) return
    await start({ conversationId, kind: 'send', content, attachments })
  }, [start])

  /** Asks again: a new reply to this user message, kept beside the earlier ones. */
  const retry = useCallback(async (userMessageId: string) => {
    if (!activeConversationId || isStreaming) return
    await start({ conversationId: activeConversationId, kind: 'retry', userMessageId })
  }, [activeConversationId, isStreaming, start])

  /** Sends an edited copy of this user message as a new version; the original stays. */
  const editMessage = useCallback(async (userMessageId: string, content: string) => {
    if (!activeConversationId || isStreaming) return
    await start({ conversationId: activeConversationId, kind: 'edit', userMessageId, content })
  }, [activeConversationId, isStreaming, start])

  /**
   * Compacts the chat: the model summarizes the branch on screen, and the
   * summary is added after it. From then on requests send the summary in
   * place of everything before it.
   */
  const compact = useCallback(async () => {
    if (!activeConversationId || isStreaming) return
    try {
      const result = await window.redLedger.compactChat(activeConversationId)
      if (result === 'nothing_to_compact') notify({ type: 'info', message: 'Nothing new to compact yet.' })
    } catch (err) {
      notify({ type: 'error', message: `Could not compact the chat: ${formatError(err)}` })
    }
  }, [activeConversationId, isStreaming])

  /** Stops the chat on screen's turn; what it wrote so far is kept. */
  const cancel = useCallback(() => {
    if (!activeConversationId) return
    void window.redLedger.cancelTurn(activeConversationId).catch(() => {})
  }, [activeConversationId])

  return {
    isStreaming,
    isCompacting,
    compact,
    isReceivingThinking,
    streamingMessageId,
    sendMessage,
    cancel,
    retry,
    editMessage
  }
}
