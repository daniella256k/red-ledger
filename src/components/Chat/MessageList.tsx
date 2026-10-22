import { useRef, useEffect, useCallback } from 'react'
import { useConversationStore } from '@/store'
import type { Message } from '@/types'
import { MessageBubble } from './MessageBubble'
import type { BranchPagerProps } from './MessageActions'

/**
 * Adaptive near-bottom threshold:
 * - small chats can break away quickly (percentage of available scroll)
 * - long chats keep a modest sticky window near the bottom
 */
const NEAR_BOTTOM_RATIO = 0.20
const NEAR_BOTTOM_MIN_PX = 16
const NEAR_BOTTOM_MAX_PX = 96

interface MessageListProps {
  isStreaming: boolean
  isReceivingThinking: boolean
  streamingMessageId: string | null
  /** New reply to a user message, kept beside the earlier replies. */
  onRetry: (userMessageId: string) => void
  /** New version of a user message, kept beside the original. */
  onEdit: (userMessageId: string, content: string) => Promise<void>
}

export function MessageList({
  isStreaming,
  isReceivingThinking,
  streamingMessageId,
  onRetry,
  onEdit
}: MessageListProps) {
  const messages = useConversationStore((s) => s.messages)
  const isLoadingMessages = useConversationStore((s) => s.isLoadingMessages)
  const forkConversationFromMessage = useConversationStore((s) => s.forkConversationFromMessage)
  const selectBranch = useConversationStore((s) => s.selectBranch)
  const deleteMessageBranch = useConversationStore((s) => s.deleteMessageBranch)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const prevMessageIdsRef = useRef<string[]>([])

  const getNearBottomThresholdPx = useCallback((el: HTMLDivElement) => {
    const scrollableHeight = Math.max(0, el.scrollHeight - el.clientHeight)
    const adaptiveThreshold = scrollableHeight * NEAR_BOTTOM_RATIO
    return Math.max(NEAR_BOTTOM_MIN_PX, Math.min(NEAR_BOTTOM_MAX_PX, adaptiveThreshold))
  }, [])

  /** Check if the scroll container is near the bottom. */
  const isNearBottom = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return true

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    return distanceFromBottom <= getNearBottomThresholdPx(el)
  }, [getNearBottomThresholdPx])

  const handleFork = useCallback(async (messageId: string) => {
    await forkConversationFromMessage(messageId)
  }, [forkConversationFromMessage])

  const handleSelectVersion = useCallback((message: Message, offset: -1 | 1) => {
    const siblingIds = message.siblingIds ?? []
    const targetId = siblingIds[siblingIds.indexOf(message.id) + offset]
    if (!targetId) return
    void selectBranch(targetId).catch(() => {})
  }, [selectBranch])

  const handleDeleteVersion = useCallback(async (message: Message) => {
    if (!window.redLedger) return
    const confirmed = await window.redLedger.showConfirmDialog({
      title: 'Delete Version',
      message: message.role === 'user'
        ? 'Delete this version of your message?'
        : 'Delete this version of the reply?',
      detail: 'Everything that follows it in this version is deleted too. The other versions stay. This action cannot be undone.'
    })
    if (!confirmed) return
    await deleteMessageBranch(message.id)
  }, [deleteMessageBranch])

  // Auto-scroll: when a chat opens, when a message is added to the end, or when
  // the user is already near the bottom. Switching versions replaces messages
  // instead of adding one, so the reader stays where they are.
  useEffect(() => {
    const previousIds = prevMessageIdsRef.current
    prevMessageIdsRef.current = messages.map((message) => message.id)
    const opened = previousIds.length === 0
    const appended = messages.length > previousIds.length
      && previousIds.every((id, index) => messages[index]?.id === id)

    if (opened || appended || isNearBottom()) {
      const scrollContainer = scrollContainerRef.current
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight
      }
    }
  }, [messages, isNearBottom])

  if (isLoadingMessages) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="loading loading-spinner loading-md text-rca-red" />
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-soft-charcoal/40">
          Send a message to begin the conversation
        </p>
      </div>
    )
  }

  return (
    <div
      ref={scrollContainerRef}
      className="h-full overflow-y-auto px-4 py-4 space-y-4"
    >
      {messages.map((message) => {
        const messageIsStreaming = isStreaming && message.id === streamingMessageId
        const siblingIds = message.siblingIds ?? []
        const branch: BranchPagerProps | undefined = siblingIds.length > 1
          ? {
            index: siblingIds.indexOf(message.id),
            count: siblingIds.length,
            onSelect: (offset) => handleSelectVersion(message, offset),
            disabled: isStreaming
          }
          : undefined
        // Nothing is overwritten any more, so any of your messages can be retried or edited.
        const canBranch = !isStreaming && message.role === 'user'

        return (
          <MessageBubble
            key={message.id}
            message={message}
            isStreaming={messageIsStreaming}
            isReceivingThinking={isReceivingThinking && messageIsStreaming}
            onRetry={canBranch ? () => onRetry(message.id) : undefined}
            onEdit={canBranch ? (content) => onEdit(message.id, content) : undefined}
            onFork={message.role === 'assistant' && !isStreaming
              ? () => { void handleFork(message.id).catch(() => {}) }
              : undefined}
            branch={branch}
            onDeleteVersion={branch && !isStreaming
              ? () => { void handleDeleteVersion(message) }
              : undefined}
          />
        )
      })}
    </div>
  )
}
