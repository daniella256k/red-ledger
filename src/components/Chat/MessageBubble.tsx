import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { ChevronDown, ChevronUp, Paperclip } from 'lucide-react'
import type { Attachment, Message, ToolCall } from '@/types'
import { ToolCallCard } from './ToolCallCard'
import {
  MessageActionsBar,
  useCopyAction,
  editAction,
  forkAction,
  retryAction,
  type MessageAction
} from './MessageActions'

// Configure marked for GFM + line breaks
marked.setOptions({
  gfm: true,
  breaks: true
})

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
  isReceivingThinking?: boolean
  /** If provided, a retry button is shown in the action bar. */
  onRetry?: () => void
  /** If provided on latest user message, shows an edit button. */
  onEdit?: (content: string) => Promise<void> | void
  /** If provided on assistant messages, shows a fork button. */
  onFork?: () => void
}

/** A renderable segment: either a block of text or a tool call. */
type Segment =
  | { kind: 'text'; text: string; html: string }
  | { kind: 'tool'; toolCall: ToolCall }

type CollapsedPreviewBlock =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; content: string }

const COPY_MESSAGE_SEPARATOR = '\n\n'
const ASSISTANT_COLLAPSE_MIN_CHARS = 500
const ASSISTANT_COLLAPSE_PREVIEW_CHARS = 180
const ASSISTANT_COLLAPSE_PREVIEW_MAX_BLOCKS = 3

function isImageAttachment(attachment: Attachment): attachment is Extract<Attachment, { kind: 'image' }> {
  return attachment.kind === 'image'
}

/**
 * Build an interleaved list of text segments and tool call cards.
 *
 * Each ToolCall may carry a `contentOffset` indicating where in the full
 * `content` string the tool call was initiated. We split the text at those
 * boundaries so tool calls appear *between* the prose they interrupted.
 *
 * Backward-compatible: tool calls without `contentOffset` are grouped at the top.
 */
function buildSegments(content: string, toolCalls: ToolCall[]): Segment[] {
  if (toolCalls.length === 0) {
    // No tool calls — just one text block
    if (!content) return []
    const html = DOMPurify.sanitize(marked.parse(content) as string)
    return [{ kind: 'text', text: content, html }]
  }

  // Separate tool calls with offsets from legacy ones (no offset)
  const withOffset = toolCalls.filter((tc) => tc.contentOffset !== undefined)
  const legacy = toolCalls.filter((tc) => tc.contentOffset === undefined)

  // If none have offsets, fall back to old behavior: all tool calls then text
  if (withOffset.length === 0) {
    const segments: Segment[] = legacy.map((tc) => ({ kind: 'tool', toolCall: tc }))
    if (content) {
      const html = DOMPurify.sanitize(marked.parse(content) as string)
      segments.push({ kind: 'text', text: content, html })
    }
    return segments
  }

  // Sort by offset
  const sorted = [...withOffset].sort((a, b) => a.contentOffset! - b.contentOffset!)

  const segments: Segment[] = []

  // Legacy tool calls first (if any)
  for (const tc of legacy) {
    segments.push({ kind: 'tool', toolCall: tc })
  }

  let cursor = 0
  for (const tc of sorted) {
    const offset = tc.contentOffset!
    // Text before this tool call
    if (offset > cursor) {
      const slice = content.slice(cursor, offset)
      if (slice.trim()) {
        const html = DOMPurify.sanitize(marked.parse(slice) as string)
        segments.push({ kind: 'text', text: slice, html })
      }
    }
    segments.push({ kind: 'tool', toolCall: tc })
    cursor = offset
  }

  // Remaining text after the last tool call
  if (cursor < content.length) {
    const slice = content.slice(cursor)
    if (slice.trim()) {
      const html = DOMPurify.sanitize(marked.parse(slice) as string)
      segments.push({ kind: 'text', text: slice, html })
    }
  }

  return segments
}

function getToolCallPreviewLabel(toolCall: ToolCall): string {
  const hasError = toolCall.result !== undefined
    && typeof toolCall.result === 'object'
    && toolCall.result !== null
    && 'error' in toolCall.result

  const status = toolCall.result === undefined
    ? 'pending'
    : hasError
      ? 'error'
      : 'complete'

  return `[Tool] ${toolCall.name} (${status})`
}

function truncateCollapsedBlock(text: string): string {
  if (text.length <= ASSISTANT_COLLAPSE_PREVIEW_CHARS) return text
  return `${text.slice(0, ASSISTANT_COLLAPSE_PREVIEW_CHARS).trimEnd()}...`
}

export function MessageBubble({
  message,
  isStreaming,
  isReceivingThinking,
  onRetry,
  onEdit,
  onFork
}: MessageBubbleProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editingText, setEditingText] = useState('')
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isCollapseToggleHovered, setIsCollapseToggleHovered] = useState(false)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Parse tool calls from JSON string if present
  const toolCalls = useMemo<ToolCall[]>(() => {
    if (!message.toolCalls) return []
    try {
      return JSON.parse(message.toolCalls)
    } catch {
      return []
    }
  }, [message.toolCalls])

  const userParts = useMemo(() => {
    if (message.role !== 'user') return null
    return {
      text: message.content,
      attachments: message.attachments ?? []
    }
  }, [message.attachments, message.content, message.role])

  const segments = useMemo(
    () => buildSegments(message.content, toolCalls),
    [message.content, toolCalls]
  )

  const assistantCopyText = useMemo(() => {
    if (message.role !== 'assistant') return message.content

    const textSegments = segments
      .filter((seg): seg is Extract<Segment, { kind: 'text' }> => seg.kind === 'text')
      .map((seg) => seg.text.trim())
      .filter(Boolean)

    if (textSegments.length <= 1) return message.content
    return textSegments.join(COPY_MESSAGE_SEPARATOR)
  }, [message.content, message.role, segments])

  const assistantCollapseBlocks = useMemo(() => {
    if (message.role !== 'assistant') return [] as CollapsedPreviewBlock[]

    const blocks: CollapsedPreviewBlock[] = []
    for (const seg of segments) {
      if (seg.kind === 'tool') {
        blocks.push({ kind: 'tool', content: getToolCallPreviewLabel(seg.toolCall) })
        continue
      }

      const normalizedText = seg.text.trim()
      if (normalizedText) {
        blocks.push({ kind: 'text', content: normalizedText })
      }
    }

    return blocks
  }, [message.role, segments])

  const assistantCollapseSourceText = useMemo(
    () => assistantCollapseBlocks.map((block) => block.content).join(COPY_MESSAGE_SEPARATOR).trim(),
    [assistantCollapseBlocks]
  )

  const canCollapseAssistantMessage = message.role === 'assistant'
    && !isStreaming
    && assistantCollapseSourceText.length > ASSISTANT_COLLAPSE_MIN_CHARS

  const assistantCollapsedPreviewBlocks = useMemo(() => {
    if (assistantCollapseBlocks.length === 0) return [] as CollapsedPreviewBlock[]

    const previewBlocks = assistantCollapseBlocks
      .slice(0, ASSISTANT_COLLAPSE_PREVIEW_MAX_BLOCKS)
      .map((block) => ({
        ...block,
        content: truncateCollapsedBlock(block.content)
      }))

    if (assistantCollapseBlocks.length > ASSISTANT_COLLAPSE_PREVIEW_MAX_BLOCKS) {
      previewBlocks.push({ kind: 'text', content: '...' })
    }

    return previewBlocks
  }, [assistantCollapseBlocks])

  const showCollapsedAssistantMessage = canCollapseAssistantMessage && isCollapsed

  useEffect(() => {
    if (!canCollapseAssistantMessage && isCollapsed) {
      setIsCollapsed(false)
    }
    if (!canCollapseAssistantMessage && isCollapseToggleHovered) {
      setIsCollapseToggleHovered(false)
    }
  }, [canCollapseAssistantMessage, isCollapsed, isCollapseToggleHovered])

  // ─── Actions ───────────────────────────────────────────────────────────────

  // Copy action: for user messages copy the user text only; for assistant separate text blocks.
  const copyText = message.role === 'user'
    ? (userParts?.text || '')
    : assistantCopyText
  const copyAction = useCopyAction(copyText)

  const openEditMode = useCallback(() => {
    if (!onEdit || message.role !== 'user') return
    setEditingText(userParts?.text || '')
    setIsEditing(true)
  }, [onEdit, message.role, userParts])

  const syncEditTextareaHeight = useCallback(() => {
    const textarea = editTextareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`
  }, [])

  const closeEditMode = useCallback(() => {
    if (isSubmittingEdit) return
    setIsEditing(false)
    setEditingText(userParts?.text || '')
  }, [isSubmittingEdit, userParts])

  const handleEditInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditingText(e.target.value)
    const textarea = editTextareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`
  }, [])

  const handleEditSubmit = useCallback(async () => {
    if (!onEdit || message.role !== 'user' || isSubmittingEdit) return

    const nextContent = editingText.trim()
    const hasAttachments = Boolean(userParts?.attachments.length)
    if (!nextContent && !hasAttachments) return

    setIsSubmittingEdit(true)
    try {
      await onEdit(nextContent)
      setIsEditing(false)
    } finally {
      setIsSubmittingEdit(false)
    }
  }, [onEdit, message.role, isSubmittingEdit, editingText, userParts])

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    void handleEditSubmit()
  }, [handleEditSubmit])

  useEffect(() => {
    if (!isEditing) return
    syncEditTextareaHeight()
    const textarea = editTextareaRef.current
    if (!textarea) return
    textarea.focus()
    const cursor = textarea.value.length
    textarea.setSelectionRange(cursor, cursor)
  }, [isEditing, syncEditTextareaHeight])

  const actions = useMemo<MessageAction[]>(() => {
    // Don't show actions during streaming or for system messages
    if (isStreaming || message.role === 'system' || isEditing) return []

    const list: MessageAction[] = []
    if (onRetry) list.push(retryAction(onRetry))
    if (message.role === 'user' && onEdit) list.push(editAction(openEditMode))
    if (message.role === 'assistant' && onFork) list.push(forkAction(onFork))
    list.push(copyAction)
    return list
  }, [copyAction, onRetry, onEdit, onFork, isStreaming, isEditing, message.role, openEditMode])

  // ─── Assistant Message ─────────────────────────────────────────────────────

  const align = message.role === 'user' ? 'right' : 'left'
  const hasThinking = Boolean(message.thinking?.trim())

  if (message.role === 'system') return null // Don't render system messages

  // ─── User Message ──────────────────────────────────────────────────────────

  if (message.role === 'user') {
    const { text, attachments } = userParts!
    return (
      <div className="message-row group flex flex-col items-end">
        <div className="message-bubble user">
          {isEditing ? (
            <>
              <textarea
                ref={editTextareaRef}
                value={editingText}
                onChange={handleEditInput}
                onKeyDown={handleEditKeyDown}
                disabled={isSubmittingEdit}
                rows={3}
                className="textarea textarea-bordered w-full bg-base-100/70 text-sm resize-none min-h-[84px] max-h-[220px] leading-relaxed focus:outline-none focus:border-weathered"
              />
              <div className="mt-2 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={closeEditMode}
                  disabled={isSubmittingEdit}
                  className="btn btn-ghost btn-xs h-7 min-h-[28px]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => { void handleEditSubmit() }}
                  disabled={isSubmittingEdit || (!editingText.trim() && attachments.length === 0)}
                  className="btn btn-primary btn-xs h-7 min-h-[28px]"
                >
                  {isSubmittingEdit ? 'Resending...' : 'Resend'}
                </button>
              </div>
            </>
          ) : (
            text && text !== '(see attached files)' && (
              <pre className="whitespace-pre-wrap font-sans text-sm m-0">{text}</pre>
            )
          )}
          {attachments.length > 0 && (
            <div className={`flex flex-col gap-1 ${text && text !== '(see attached files)' ? 'mt-2' : ''}`}>
              {attachments.map((a, i) => (
                <details key={i} className="group/attach">
                  <summary className="inline-flex items-center gap-1.5 cursor-pointer text-xs text-soft-charcoal/60 hover:text-soft-charcoal select-none list-none [&::-webkit-details-marker]:hidden">
                    <Paperclip size={11} className="shrink-0" />
                    <span>{a.name}</span>
                    <span className="text-[10px] opacity-50 group-open/attach:rotate-90 transition-transform">&#9654;</span>
                  </summary>
                  {isImageAttachment(a) ? (
                    <div className="mt-1 p-2 bg-base-200/60 rounded max-w-[320px]">
                      <img
                        src={a.dataUrl}
                        alt={a.name}
                        className="block max-w-full max-h-[260px] rounded border border-weathered object-contain bg-base-100"
                        loading="lazy"
                      />
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap font-mono text-xs mt-1 p-2 bg-base-200/60 rounded max-h-[200px] overflow-y-auto m-0">{a.content}</pre>
                  )}
                </details>
              ))}
            </div>
          )}
        </div>
        <MessageActionsBar actions={actions} align={align} />
      </div>
    )
  }

  // Determine if the last segment is a text segment (for streaming cursor placement)
  const lastSegment = segments[segments.length - 1]
  const lastSegmentIsText = lastSegment?.kind === 'text'

  return (
    <div className="message-row group flex flex-col gap-2 items-start">
      <div className="assistant-message-shell">
        {showCollapsedAssistantMessage ? (
          <div className="message-bubble assistant assistant-collapsed-preview">
            <div className="assistant-collapsed-content">
              {assistantCollapsedPreviewBlocks.map((block, index) => {
                const previousKind = index > 0 ? assistantCollapsedPreviewBlocks[index - 1].kind : null

                if (block.kind === 'tool') {
                  const toolSpacingClass = index === 0
                    ? ''
                    : previousKind === 'tool'
                      ? 'mt-0'
                      : 'mt-1.5'

                  return (
                    <p
                      key={`collapsed-tool-${index}`}
                      className={`assistant-collapsed-tool ${toolSpacingClass}`}
                    >
                      {block.content}
                    </p>
                  )
                }

                const textSpacingClass = index === 0
                  ? ''
                  : previousKind === 'text'
                    ? 'mt-3'
                    : 'mt-1.5'

                return (
                  <pre
                    key={`collapsed-text-${index}`}
                    className={`assistant-collapsed-text ${textSpacingClass}`}
                  >
                    {block.content}
                  </pre>
                )
              })}
            </div>
          </div>
        ) : (
          <>
            {hasThinking && (
              <details className="border border-weathered rounded-card bg-base-100 overflow-hidden group/thinking">
                <summary className="inline-flex items-center gap-1.5 cursor-pointer px-3 py-2 text-xs text-soft-charcoal/70 hover:text-soft-charcoal select-none list-none [&::-webkit-details-marker]:hidden">
                  <span className="font-medium uppercase tracking-wide">Reasoning Trace</span>
                  <span className="text-[10px] opacity-50 group-open/thinking:rotate-90 transition-transform">&#9654;</span>
                </summary>
                <pre className="m-0 border-t border-weathered bg-base-200/40 px-3 py-2 text-xs font-mono whitespace-pre-wrap max-h-[260px] overflow-y-auto">
                  {message.thinking}
                </pre>
              </details>
            )}

            {segments.map((seg, i) => {
              if (seg.kind === 'tool') {
                return <ToolCallCard key={seg.toolCall.id} toolCall={seg.toolCall} />
              }

              // Text segment
              const isLastTextSegment = i === segments.length - 1 && seg.kind === 'text'
              return (
                <div
                  key={`text-${i}`}
                  className="message-bubble assistant"
                >
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: seg.html }}
                  />
                  {/* Streaming activity indicator - only on the very last text segment */}
                  {isStreaming && isLastTextSegment && (
                    <span className="inline-flex items-center">
                      {isReceivingThinking
                        ? <span className="thinking-inline-indicator ml-0">thinking...</span>
                        : <span className="streaming-cursor" />}
                    </span>
                  )}
                </div>
              )
            })}

            {/* If streaming and the last segment is a tool call (text hasn't resumed yet),
                show an activity indicator in a minimal bubble so the user sees activity */}
            {isStreaming && !lastSegmentIsText && segments.length > 0 && (
              <div className="message-bubble assistant">
                <span className="inline-flex items-center">
                  {isReceivingThinking
                    ? <span className="thinking-inline-indicator ml-0">thinking...</span>
                    : <span className="streaming-cursor" />}
                </span>
              </div>
            )}

            {/* If streaming but no segments yet (very start), show activity indicator */}
            {isStreaming && segments.length === 0 && (
              <div className="message-bubble assistant">
                <span className="inline-flex items-center">
                  {isReceivingThinking
                    ? <span className="thinking-inline-indicator ml-0">thinking...</span>
                    : <span className="streaming-cursor" />}
                </span>
              </div>
            )}
          </>
        )}

        {canCollapseAssistantMessage && (
          <div className="assistant-collapse-anchor">
            <button
              type="button"
              className={`message-collapse-toggle ${isCollapseToggleHovered ? 'is-hovered' : ''}`}
              data-collapsed={isCollapsed ? 'true' : 'false'}
              onPointerEnter={() => setIsCollapseToggleHovered(true)}
              onPointerLeave={() => setIsCollapseToggleHovered(false)}
              onPointerCancel={() => setIsCollapseToggleHovered(false)}
              onBlur={() => setIsCollapseToggleHovered(false)}
              onClick={(e) => {
                setIsCollapsed((prev) => !prev)
                setIsCollapseToggleHovered(false)
                // Pointer clicks keep focus on the button, which can leave the
                // hover-only control visually "stuck" after mouse-out.
                if (e.detail > 0) {
                  e.currentTarget.blur()
                }
              }}
              aria-label={isCollapsed ? 'Expand assistant message' : 'Collapse assistant message'}
              aria-expanded={!isCollapsed}
              title={isCollapsed ? 'Expand message' : 'Collapse message'}
            >
              {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </div>
        )}
      </div>

      <MessageActionsBar actions={actions} align={align} />
    </div>
  )
}
