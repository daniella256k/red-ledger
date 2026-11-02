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
  const contentRef = useRef<HTMLDivElement>(null)
  const prevMessageIdsRef = useRef<string[]>([])
  // Whether the view follows the end of the chat. Decided by where the reader
  // scrolls, never by how much the content grew, so a reply that adds a lot
  // in one update cannot leave the view behind.
  const stickToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const hasList = !isLoadingMessages && messages.length > 0

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const scrollableHeight = Math.max(0, el.scrollHeight - el.clientHeight)
    const threshold = Math.max(
      NEAR_BOTTOM_MIN_PX,
      Math.min(NEAR_BOTTOM_MAX_PX, scrollableHeight * NEAR_BOTTOM_RATIO)
    )
    const distanceFromBottom = scrollableHeight - el.scrollTop
    // Content shrinking also lowers scrollTop, but leaves the view at the bottom.
    const movedUp = el.scrollTop < lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop

    if (movedUp && distanceFromBottom > 1) {
      stickToBottomRef.current = false
    } else if (distanceFromBottom <= threshold) {
      stickToBottomRef.current = true
    }
  }, [])

  // Follow the end whenever the content or the visible area changes size:
  // streamed text, images loading, the action bar appearing, the input growing.
  useEffect(() => {
    if (!hasList) return
    const el = scrollContainerRef.current
    const content = contentRef.current
    if (!el || !content) return

    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom()
    })
    observer.observe(el)
    observer.observe(content)
    return () => observer.disconnect()
  }, [hasList, scrollToBottom])

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

  // Jump to the end when a chat opens or a message is added to the end. Switching
  // versions replaces messages instead of adding one, so the reader stays where
  // they are (the observer above still follows if they were at the end).
  useEffect(() => {
    const previousIds = prevMessageIdsRef.current
    prevMessageIdsRef.current = messages.map((message) => message.id)
    const opened = previousIds.length === 0
    const appended = messages.length > previousIds.length
      && previousIds.every((id, index) => messages[index]?.id === id)

    if (opened || appended) {
      stickToBottomRef.current = true
      scrollToBottom()
    }
  }, [messages, scrollToBottom])

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
      onScroll={handleScroll}
      className="h-full overflow-y-auto px-4 py-4"
    >
      <div ref={contentRef} className="space-y-4">
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
    </div>
  )
}
