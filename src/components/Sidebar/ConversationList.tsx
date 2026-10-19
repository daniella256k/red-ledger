import { useCallback, useEffect, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { Plus, Trash2, Pencil, Check, X, Star, Search } from 'lucide-react'
import { useConversationStore } from '@/store'
import { cn, formatTimestamp } from '@/lib/utils'
import { DEFAULT_CHAT_TITLE } from '@/lib/chatTitle'
import type { Conversation } from '@/types'

interface ConversationListProps {
  compactNewChatButton?: boolean
}

/** Height of a chat row (py-2, one title line, one timestamp line). Rows are measured once shown. */
const ROW_HEIGHT_ESTIMATE = 51
/** The list's py-1 sits above the first row. */
const LIST_PADDING_TOP = 4

export function ConversationList({ compactNewChatButton = false }: ConversationListProps) {
  const conversations = useConversationStore((s) => s.conversations)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const loadConversations = useConversationStore((s) => s.loadConversations)
  const searchConversations = useConversationStore((s) => s.searchConversations)
  const hasDraft = useConversationStore((s) => s.draft !== null)
  const openDraft = useConversationStore((s) => s.openDraft)
  const discardDraft = useConversationStore((s) => s.discardDraft)
  const deleteConversation = useConversationStore((s) => s.deleteConversation)
  const renameConversation = useConversationStore((s) => s.renameConversation)
  const setConversationPinned = useConversationStore((s) => s.setConversationPinned)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const searchSeqRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    const seq = ++searchSeqRef.current
    const trimmed = searchQuery.trim()

    if (trimmed.length === 0) {
      void loadConversations()
      return
    }

    const handle = window.setTimeout(() => {
      if (seq !== searchSeqRef.current) return
      void searchConversations(trimmed)
    }, 150)

    return () => window.clearTimeout(handle)
  }, [searchQuery, loadConversations, searchConversations])

  // New Chat opens the one unsaved draft rather than saving a blank chat.
  const handleCreate = () => {
    void openDraft()
  }

  const handleDiscardDraft = (e: React.MouseEvent) => {
    e.stopPropagation()
    discardDraft()
  }

  // The draft is listed while not searching, since it has nothing to match yet.
  const showDraft = hasDraft && searchQuery.trim().length === 0
  const draftRows = showDraft ? 1 : 0

  // Keep the row being renamed mounted, so scrolling away doesn't drop its focus.
  const renamingRow = renamingId === null ? -1 : conversations.findIndex((c) => c.id === renamingId)
  const renamingIndex = renamingRow < 0 ? -1 : renamingRow + draftRows
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range)
    if (renamingIndex < 0 || indexes.includes(renamingIndex)) return indexes
    return [...indexes, renamingIndex].sort((a, b) => a - b)
  }, [renamingIndex])

  // Only the rows in view are rendered: long histories otherwise make every
  // style recalc (editor creation, theme switch) walk thousands of rows.
  // eslint-disable-next-line react-hooks/incompatible-library -- only affects React Compiler, which this app doesn't use
  const virtualizer = useVirtualizer({
    count: conversations.length + draftRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    getItemKey: (index) => (index < draftRows ? 'draft' : conversations[index - draftRows].id),
    rangeExtractor,
    scrollMargin: LIST_PADDING_TOP,
    overscan: 8
  })

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.redLedger) return
    const confirmed = await window.redLedger.showConfirmDialog({
      title: 'Delete Conversation',
      message: 'Delete this conversation?',
      detail: 'This action cannot be undone.'
    })
    if (confirmed) {
      await deleteConversation(id)
    }
  }

  const handleStartRename = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setRenamingId(id)
    setRenameValue(currentTitle)
  }

  const handleConfirmRename = async () => {
    if (renamingId && renameValue.trim()) {
      await renameConversation(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }

  const handleCancelRename = () => {
    setRenamingId(null)
  }

  const handleTogglePin = async (id: string, isPinned: boolean, e: React.MouseEvent) => {
    e.stopPropagation()
    await setConversationPinned(id, !isPinned)
  }

  const renderDraftRow = () => (
    <div
      onClick={() => setActiveConversation(null)}
      className={cn('conversation-item group', activeConversationId === null && 'active')}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate leading-snug">
          {DEFAULT_CHAT_TITLE}
        </div>
        <div className="text-[11px] text-soft-charcoal/40 mt-0.5 leading-tight">
          Draft, not saved yet
        </div>
      </div>
      <div className="hidden group-hover:flex items-center gap-0.5 shrink-0 ml-1">
        <button
          onClick={handleDiscardDraft}
          className="p-1 rounded-sm hover:bg-error/10 text-soft-charcoal/40 hover:text-error transition-colors"
          title="Discard draft"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )

  const renderConversationRow = (conv: Conversation) => (
    <div
      onClick={() => setActiveConversation(conv.id)}
      className={cn(
        'conversation-item group',
        activeConversationId === conv.id && 'active'
      )}
    >
      <div className="flex-1 min-w-0">
        {renamingId === conv.id ? (
          <div className="flex items-center gap-1">
            <input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmRename()
                if (e.key === 'Escape') handleCancelRename()
              }}
              className="input input-xs flex-1"
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <button onClick={(e) => { e.stopPropagation(); handleConfirmRename() }} className="text-success p-0.5">
              <Check size={14} />
            </button>
            <button onClick={(e) => { e.stopPropagation(); handleCancelRename() }} className="text-error p-0.5">
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            <div className="text-sm font-medium truncate leading-snug">
              {conv.title}
            </div>
            <div className="text-[11px] text-soft-charcoal/40 mt-0.5 leading-tight">
              {formatTimestamp(conv.updatedAt)}
            </div>
          </>
        )}
      </div>

      {/* Action Buttons (visible on hover) */}
      {renamingId !== conv.id && (
        <>
          {conv.isPinned && (
            <div className="ml-1 flex shrink-0 items-center text-amber-600/80 group-hover:hidden pointer-events-none">
              <Star size={12} className="fill-current" />
            </div>
          )}

          <div className="hidden group-hover:flex items-center gap-0.5 shrink-0 ml-1">
            <button
              onClick={(e) => handleTogglePin(conv.id, conv.isPinned, e)}
              className={cn(
                'p-1 rounded-sm hover:bg-base-300 transition-colors',
                conv.isPinned
                  ? 'text-amber-600 hover:text-amber-700'
                  : 'text-soft-charcoal/40 hover:text-soft-charcoal'
              )}
              title={conv.isPinned ? 'Unpin' : 'Pin'}
            >
              <Star size={12} className={cn(conv.isPinned && 'fill-current')} />
            </button>
            <button
              onClick={(e) => handleStartRename(conv.id, conv.title, e)}
              className="p-1 rounded-sm hover:bg-base-300 text-soft-charcoal/40 hover:text-soft-charcoal transition-colors"
              title="Rename"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={(e) => handleDelete(conv.id, e)}
              className="p-1 rounded-sm hover:bg-error/10 text-soft-charcoal/40 hover:text-error transition-colors"
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </>
      )}
    </div>
  )

  return (
    <div className="h-full flex flex-col">
      {/* New Chat Button */}
      <div className="p-3 pb-2 flex justify-center">
        <button
          onClick={handleCreate}
          className={cn(
            'btn btn-primary btn-sm w-full max-w-[300px] whitespace-nowrap',
            compactNewChatButton ? 'px-0' : 'gap-2'
          )}
          title="New Chat"
        >
          <Plus size={14} />
          {!compactNewChatButton && 'New Chat'}
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2 top-1/2 z-10 -translate-y-1/2 text-soft-charcoal/40 pointer-events-none"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search chats…"
            className="input input-xs w-full pl-7 pr-7"
            aria-label="Search chats"
          />
          {searchQuery.length > 0 && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-soft-charcoal/40 hover:text-soft-charcoal hover:bg-base-300 transition-colors"
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Conversation List */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-1">
        {conversations.length === 0 && !showDraft ? (
          <div className="px-4 py-8 text-center text-xs text-soft-charcoal/40">
            {searchQuery.trim().length > 0 ? 'No matching chats' : 'No conversations yet'}
          </div>
        ) : (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${item.start - LIST_PADDING_TOP}px)` }}
              >
                {item.index < draftRows
                  ? renderDraftRow()
                  : renderConversationRow(conversations[item.index - draftRows])}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
