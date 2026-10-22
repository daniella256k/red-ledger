import { useRef, useCallback, useLayoutEffect } from 'react'
import { Send, Square, Paperclip, X } from 'lucide-react'
import { useConversationStore, useSettingsStore, useUIStore } from '@/store'
import { selectComposer } from '@/store/conversationStore'
import type { useStreaming } from '@/hooks/useStreaming'
import { ContextMeter } from './ContextMeter'
import type { ImageAttachment, ImageAttachmentMimeType } from '@/types'
import { IMAGE_EXTENSION_BY_MIME_TYPE, isImageMimeType } from '@/lib/attachments'

function getClipboardImageFiles(event: React.ClipboardEvent<HTMLTextAreaElement>): File[] {
  return Array
    .from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Clipboard image parse failed'))
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('Clipboard image parse failed'))
    }
    reader.readAsDataURL(blob)
  })
}

async function normalizePastedImage(file: File): Promise<{ blob: Blob; mimeType: ImageAttachmentMimeType } | null> {
  if (isImageMimeType(file.type)) {
    return {
      blob: file,
      mimeType: file.type
    }
  }

  if (!file.type.startsWith('image/')) {
    return null
  }

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, bitmap.width)
    canvas.height = Math.max(1, bitmap.height)

    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0)

    const pngBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    })
    if (!pngBlob) return null

    return {
      blob: pngBlob,
      mimeType: 'image/png'
    }
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

function buildPastedImageName(timestamp: number, index: number, mimeType: ImageAttachmentMimeType): string {
  const extension = IMAGE_EXTENSION_BY_MIME_TYPE[mimeType]
  return `pasted-image-${timestamp}-${index + 1}.${extension}`
}

async function toClipboardImageAttachment(
  file: File,
  timestamp: number,
  index: number
): Promise<ImageAttachment | null> {
  const normalized = await normalizePastedImage(file)
  if (!normalized) return null

  try {
    return {
      kind: 'image',
      name: buildPastedImageName(timestamp, index, normalized.mimeType),
      mimeType: normalized.mimeType,
      dataUrl: await blobToDataUrl(normalized.blob)
    }
  } catch {
    return null
  }
}

interface ChatInputProps {
  streaming: ReturnType<typeof useStreaming>
}

export function ChatInput({ streaming }: ChatInputProps) {
  const MAX_TEXTAREA_HEIGHT = 200
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The box shows the draft's text in the New Chat view, and a fresh box in a saved chat.
  const input = useConversationStore((s) => selectComposer(s).input)
  const attachments = useConversationStore((s) => selectComposer(s).attachments)
  const setInput = useConversationStore((s) => s.setComposerInput)
  const onAddAttachments = useConversationStore((s) => s.addComposerAttachments)
  const onRemoveAttachment = useConversationStore((s) => s.removeComposerAttachment)
  const onClearAttachments = useConversationStore((s) => s.clearComposer)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const contextUsage = useConversationStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)?.lastRequest?.usage ?? null
  )
  const createConversation = useConversationStore((s) => s.createConversation)
  const isCreatingConversationRef = useRef(false)
  const settings = useSettingsStore((s) => s.settings)
  const workspacePath = useUIStore((s) => s.workspacePath)
  const addToast = useUIStore((s) => s.addToast)
  const { isStreaming, sendMessage, cancel } = streaming

  const handleAttach = useCallback(async () => {
    const files = await window.redLedger.openAttachmentFiles()
    if (files.length > 0) {
      onAddAttachments(files)
    }
  }, [onAddAttachments])

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = getClipboardImageFiles(event)
    if (imageFiles.length === 0 || !settings || isStreaming) return

    const timestamp = Date.now()

    void (async () => {
      const parsed = await Promise.all(
        imageFiles.map((file, index) => toClipboardImageAttachment(file, timestamp, index))
      )
      const pastedAttachments = parsed.filter((attachment): attachment is ImageAttachment => attachment !== null)
      const failedCount = parsed.length - pastedAttachments.length

      if (pastedAttachments.length > 0) {
        onAddAttachments(pastedAttachments)
      }
      if (failedCount > 0) {
        addToast({
          type: 'warning',
          message: `${failedCount} clipboard image${failedCount === 1 ? '' : 's'} could not be attached.`
        })
      }
    })()
  }, [addToast, isStreaming, onAddAttachments, settings])

  const handleSend = useCallback(async () => {
    const content = input.trim()
    if ((!content && attachments.length === 0) || !settings || isStreaming) return
    // A quick second Enter while the draft is still being saved would save it twice.
    if (isCreatingConversationRef.current) return

    // The draft is saved as a chat here, on its first send.
    if (!activeConversationId) {
      isCreatingConversationRef.current = true
      try {
        await createConversation({ workspacePath })
      } catch {
        return
      } finally {
        isCreatingConversationRef.current = false
      }
    }

    const pending = attachments.length > 0 ? [...attachments] : undefined
    onClearAttachments()

    await sendMessage(content, pending)
  }, [input, attachments, activeConversationId, createConversation, workspacePath, settings, isStreaming, onClearAttachments, sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }

  // Auto-grow textarea, also when switching chats swaps the text in or out
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px'
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden'
  }, [input])

  const isDisabled = !settings

  return (
    <div className="border-t border-weathered bg-paper-stack/30 px-4 py-3">
      {/* Attachment pills */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-base-100 border border-weathered rounded-sm text-xs text-soft-charcoal"
            >
              <Paperclip size={10} className="shrink-0 text-soft-charcoal/40" />
              <span className="truncate max-w-[150px]">{a.name}</span>
              <button
                onClick={() => onRemoveAttachment(i)}
                className="ml-0.5 hover:text-rca-red transition-colors"
                title="Remove"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            isDisabled
              ? 'Loading settings...'
              : isStreaming
                ? 'Waiting for response...'
                : activeConversationId
                  ? 'Type a message... (Enter to send)'
                  : 'Start a new conversation... (Enter to send)'
          }
          disabled={isDisabled || isStreaming}
          rows={1}
          className="textarea flex-1 resize-none overflow-y-hidden text-sm min-h-[40px] max-h-[200px] leading-relaxed focus:outline-hidden focus:border-weathered"
        />

        {isStreaming ? (
          <button
            onClick={cancel}
            className="btn btn-error btn-sm h-10 w-10 min-w-[40px] p-0 shrink-0"
            title="Cancel"
          >
            <Square size={14} />
          </button>
        ) : (
          <>
            <button
              onClick={handleAttach}
              disabled={isDisabled}
              className="btn btn-ghost btn-sm h-10 w-10 min-w-[40px] p-0 shrink-0 text-soft-charcoal/50 hover:text-soft-charcoal disabled:text-soft-charcoal/20"
              title="Attach files: text and code (.py, .yaml, .json, .xml, ...), PDFs, Word documents, spreadsheets (.xlsx, .xls, .ods, .csv, ...), or images. You can also paste an image into the message box."
            >
              <Paperclip size={16} />
            </button>
            <button
              onClick={handleSend}
              disabled={isDisabled || (!input.trim() && attachments.length === 0)}
              className="btn btn-primary btn-sm h-10 w-10 min-w-[40px] p-0 shrink-0"
              title="Send"
            >
              <Send size={16} />
            </button>
          </>
        )}
      </div>

      {(isStreaming || contextUsage) && (
        <div className="flex items-center gap-2 mt-2 text-xs text-soft-charcoal/40">
          {isStreaming && (
            <>
              <span className="loading loading-dots loading-xs text-rca-red" />
              <span>Generating response...</span>
            </>
          )}
          {contextUsage && (
            <div className="ml-auto">
              <ContextMeter usage={contextUsage} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
