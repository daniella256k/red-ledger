import { useCallback, useRef, useState } from 'react'
import { formatError } from '@/lib/errors'
import { DEFAULT_CHAT_TITLE } from '@/lib/chatTitle'
import { APP_NAME } from '@/lib/appInfo'
import { useConversationStore, useUIStore } from '@/store'
import { useStreaming } from '@/hooks/useStreaming'
import type { Attachment } from '@/types'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { ChatInfoPopover } from './ChatInfoPopover'

const MAX_FAILED_NAMES_IN_TOAST = 3

function describeFailedAttachments(failed: string[]): string {
  const shown = failed.slice(0, MAX_FAILED_NAMES_IN_TOAST).join(', ')
  const extra = failed.length - MAX_FAILED_NAMES_IN_TOAST
  return `Could not attach ${shown}${extra > 0 ? ` and ${extra} more` : ''}.`
}

function hasFileDragPayload(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

export function ChatPanel() {
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const isEmptyChatState = !activeConversationId
  const activeConversation = useConversationStore((s) =>
    s.conversations.find((item) => item.id === s.activeConversationId) ?? null
  )
  const activeConversationTitle = useConversationStore((s) => {
    if (!s.activeConversationId) return null
    const conversation = s.conversations.find((item) => item.id === s.activeConversationId)
    const title = conversation?.title.trim()
    return title && title.length > 0 ? title : DEFAULT_CHAT_TITLE
  })
  const streaming = useStreaming()
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isDropTargetActive, setIsDropTargetActive] = useState(false)
  const [isParsingDrop, setIsParsingDrop] = useState(false)
  const dropDepthRef = useRef(0)

  const addAttachments = useCallback((nextAttachments: Attachment[]) => {
    if (nextAttachments.length === 0) return
    setAttachments((prev) => [...prev, ...nextAttachments])
  }, [])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const clearAttachments = useCallback(() => {
    setAttachments([])
  }, [])

  const onDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileDragPayload(event)) return
    event.preventDefault()
    dropDepthRef.current += 1
    setIsDropTargetActive(true)
  }, [])

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileDragPayload(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setIsDropTargetActive(true)
  }, [])

  const onDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileDragPayload(event)) return
    event.preventDefault()
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1)
    if (dropDepthRef.current === 0) {
      setIsDropTargetActive(false)
    }
  }, [])

  const onDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileDragPayload(event)) return
    event.preventDefault()

    dropDepthRef.current = 0
    setIsDropTargetActive(false)

    const droppedFiles = Array.from(event.dataTransfer.files)
    if (droppedFiles.length === 0) return

    // The main process decides what is supported: images, PDFs, and any
    // file whose content is text (code, config, markup, ...).
    setIsParsingDrop(true)
    try {
      const result = await window.redLedger.parseAttachmentFiles(droppedFiles)
      if (result.attachments.length > 0) {
        addAttachments(result.attachments)
      }

      if (result.failed.length > 0) {
        useUIStore.getState().addToast({
          type: 'warning',
          message: describeFailedAttachments(result.failed)
        })
      }
    } catch (err) {
      useUIStore.getState().addToast({
        type: 'error',
        message: formatError(err)
      })
    } finally {
      setIsParsingDrop(false)
    }
  }, [addAttachments])

  const showDropOverlay = isDropTargetActive || isParsingDrop

  return (
    <div
      className="h-full flex flex-col bg-paper relative"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {showDropOverlay && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-paper/75">
          <div className="rounded-lg border-2 border-dashed border-rca-red/45 bg-paper-stack/95 px-6 py-5 text-center shadow-sm">
            <p className="text-sm font-medium text-soft-charcoal">
              {isParsingDrop ? 'Attaching files...' : 'Drop files to attach to your next message'}
            </p>
            <p className="mt-1 text-xs text-soft-charcoal/55">
              Text and code files (.py, .yaml, .json, .xml, ...), PDFs, and images
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="relative px-4 py-2.5 border-b border-weathered bg-paper-stack/50 flex items-center gap-1.5 min-h-[42px]">
        <h2
          className={isEmptyChatState
            ? 'text-xs font-semibold text-soft-charcoal/70 uppercase tracking-wider'
            : 'text-sm font-semibold text-soft-charcoal/75 truncate min-w-0'
          }
          title={isEmptyChatState ? APP_NAME : (activeConversationTitle ?? DEFAULT_CHAT_TITLE)}
        >
          {isEmptyChatState ? APP_NAME.toUpperCase() : activeConversationTitle}
        </h2>
        {activeConversation && <ChatInfoPopover conversation={activeConversation} />}
      </div>

      {activeConversationId ? (
        <>
          {/* Message Feed */}
          <div className="flex-1 overflow-hidden">
            <MessageList
              isStreaming={streaming.isStreaming}
              isReceivingThinking={streaming.isReceivingThinking}
              streamingMessageId={streaming.streamingMessageId}
              onRetry={streaming.retry}
              onEdit={streaming.editLastUserMessage}
            />
          </div>

          {/* Input */}
          <ChatInput
            streaming={streaming}
            attachments={attachments}
            onAddAttachments={addAttachments}
            onRemoveAttachment={removeAttachment}
            onClearAttachments={clearAttachments}
          />
        </>
      ) : (
        <>
          {/* Empty State */}
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-4">
              <div className="text-6xl text-rca-red/15 leading-none">&#128213;</div>
              <div>
                <h3 className="text-base font-semibold text-soft-charcoal">
                  {APP_NAME}
                </h3>
                <p className="text-xs text-soft-charcoal/40 max-w-[240px] mt-1.5 leading-relaxed">
                  Create a new conversation or select one from the sidebar to get started.
                </p>
              </div>
            </div>
          </div>
          <ChatInput
            streaming={streaming}
            attachments={attachments}
            onAddAttachments={addAttachments}
            onRemoveAttachment={removeAttachment}
            onClearAttachments={clearAttachments}
          />
        </>
      )}
    </div>
  )
}
