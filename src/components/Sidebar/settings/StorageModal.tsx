import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, Pin, Trash2, X } from 'lucide-react'
import type { ChatStorageInfo, StorageOverview, StoredImageInfo } from '@/types'
import { useConversationStore } from '@/store'
import { ATTACHMENT_URL_SCHEME } from '@/lib/attachments'
import { formatError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import { cn, formatBytes, formatTimestamp } from '@/lib/utils'

type StorageTab = 'chats' | 'images'
type ChatSort = 'size' | 'recent' | 'title'

const DAY_MS = 86_400_000
/** Narrows the image list to chats left alone for a while. Only filters the view. */
const IMAGE_AGE_FILTERS = [
  { days: 0, label: 'Any age' },
  { days: 30, label: 'Chats inactive 30+ days' },
  { days: 90, label: 'Chats inactive 90+ days' },
  { days: 365, label: 'Chats inactive 1+ year' }
]
const ROW_BUTTON_CLASS = 'p-1 rounded-sm text-soft-charcoal/40 transition-colors disabled:opacity-40'

interface StorageListing {
  overview: StorageOverview
  chats: ChatStorageInfo[]
  images: StoredImageInfo[]
  loadedAt: number
}

async function loadStorageListing(): Promise<StorageListing> {
  const [overview, chats, images] = await Promise.all([
    window.redLedger.getStorageOverview(),
    window.redLedger.listChatStorage(),
    window.redLedger.listStoredImages()
  ])
  return { overview, chats, images, loadedAt: Date.now() }
}

function confirmAction(title: string, message: string, detail: string): Promise<boolean> {
  return window.redLedger.showConfirmDialog({ title, message, detail })
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-sm border border-weathered bg-paper-stack/40 px-3 py-2 min-w-0" title={hint}>
      <div className="text-[10px] uppercase tracking-widest text-soft-charcoal/40">{label}</div>
      <div className="text-sm font-semibold text-soft-charcoal tabular-nums">{value}</div>
    </div>
  )
}

/**
 * What the app keeps on disk, with manual ways to free it: delete a chat,
 * remove a large image, compact the database, clear caches. Nothing is
 * deleted on a schedule, and every deletion asks first.
 */
export function StorageModal({ onClose }: { onClose: () => void }) {
  const [listing, setListing] = useState<StorageListing | null>(null)
  const [tab, setTab] = useState<StorageTab>('chats')
  const [chatSort, setChatSort] = useState<ChatSort>('size')
  const [minInactiveDays, setMinInactiveDays] = useState(0)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const setActiveConversation = useConversationStore((s) => s.setActiveConversation)
  const deleteConversation = useConversationStore((s) => s.deleteConversation)

  const refresh = useCallback(() => (
    loadStorageListing()
      .then(setListing)
      .catch((err) => notify({ type: 'error', message: formatError(err) }))
  ), [])

  useEffect(() => {
    let cancelled = false
    loadStorageListing()
      .then((next) => { if (!cancelled) setListing(next) })
      .catch((err) => notify({ type: 'error', message: formatError(err) }))
    return () => { cancelled = true }
  }, [])

  const overview = listing?.overview ?? null
  const chats = useMemo(() => listing?.chats ?? [], [listing])
  const images = useMemo(() => listing?.images ?? [], [listing])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyLabel) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, busyLabel])

  const run = async (label: string, action: () => Promise<void>) => {
    if (busyLabel) return
    setBusyLabel(label)
    try {
      await action()
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    } finally {
      await refresh()
      setBusyLabel(null)
    }
  }

  const sortedChats = useMemo(() => {
    const sorted = [...chats]
    if (chatSort === 'recent') sorted.sort((a, b) => b.updatedAt - a.updatedAt)
    else if (chatSort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title))
    else sorted.sort((a, b) => b.totalBytes - a.totalBytes)
    return sorted
  }, [chats, chatSort])

  const visibleImages = useMemo(() => {
    if (minInactiveDays === 0 || !listing) return images
    const cutoff = listing.loadedAt - minInactiveDays * DAY_MS
    return images.filter((image) => image.lastChatActivityAt <= cutoff)
  }, [images, listing, minInactiveDays])

  const handleOpenChat = (chat: ChatStorageInfo) => {
    void setActiveConversation(chat.conversationId)
    onClose()
  }

  const handleDeleteChat = async (chat: ChatStorageInfo) => {
    const confirmed = await confirmAction(
      'Delete Conversation',
      `Delete "${chat.title}"?`,
      `This frees about ${formatBytes(chat.totalBytes)}. This action cannot be undone.`
    )
    if (!confirmed) return
    await run('Deleting chat…', () => deleteConversation(chat.conversationId))
  }

  const handleRemoveImage = async (image: StoredImageInfo) => {
    const chatCount = image.chats.length
    const confirmed = await confirmAction(
      'Remove Image',
      `Remove "${image.name}" (${formatBytes(image.bytes)})?`,
      `It is removed from ${chatCount === 1 ? 'its chat' : `all ${chatCount} chats that use it`}. `
        + 'The messages and their text stay. This action cannot be undone.'
    )
    if (!confirmed) return
    await run('Removing image…', async () => {
      const result = await window.redLedger.removeStoredImage(image.blobId)
      const { activeConversationId, loadMessages } = useConversationStore.getState()
      if (activeConversationId && result.conversationIds.includes(activeConversationId)) {
        await loadMessages(activeConversationId)
      }
      notify({ type: 'success', message: `Removed ${image.name} (${formatBytes(result.freedBytes)}).` })
    })
  }

  const handleCompact = () => run('Compacting…', async () => {
    const result = await window.redLedger.compactDatabase()
    notify({
      type: 'success',
      message: `Database compacted: ${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)}.`
    })
  })

  const handleClearCaches = () => run('Clearing caches…', async () => {
    await window.redLedger.clearCaches()
    notify({ type: 'success', message: 'Browser caches cleared.' })
  })

  const isBusy = busyLabel !== null
  const tabs: Array<{ value: StorageTab; label: string }> = [
    { value: 'chats', label: `Chats (${chats.length})` },
    { value: 'images', label: `Images (${images.length})` }
  ]

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-soft-charcoal/40"
      onClick={() => { if (!isBusy) onClose() }}
    >
      <div
        className="bg-paper border border-weathered rounded-lg shadow-xl w-full max-w-2xl mx-4 h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-title"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-weathered">
          <h2 id="storage-title" className="text-sm font-semibold text-soft-charcoal">Storage</h2>
          <div className="flex items-center gap-2">
            {busyLabel && (
              <span className="flex items-center gap-1.5 text-xs text-soft-charcoal/60">
                <span className="loading loading-spinner loading-xs text-rca-red" />
                {busyLabel}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={isBusy}
              className="p-1 rounded-sm hover:bg-base-300 text-soft-charcoal/60 hover:text-soft-charcoal transition-colors disabled:opacity-50"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="px-4 py-3 space-y-2 border-b border-weathered">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Database" value={overview ? formatBytes(overview.databaseBytes) : '—'} hint="Chats, messages and images on disk" />
            <Stat label="Images" value={overview ? formatBytes(overview.imageBytes) : '—'} hint="Stored images, counted once each" />
            <Stat label="Free in file" value={overview ? formatBytes(overview.reclaimableBytes) : '—'} hint="Space from deleted data that Compact gives back" />
            <Stat label="Caches" value={overview ? formatBytes(overview.cacheBytes) : '—'} hint="Browser caches; rebuilt as needed" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={handleCompact} disabled={isBusy} className="btn btn-ghost btn-xs">
              Compact database
            </button>
            <button type="button" onClick={handleClearCaches} disabled={isBusy} className="btn btn-ghost btn-xs">
              Clear caches
            </button>
            <span className="text-[11px] text-soft-charcoal/45">
              Deleted chats and images stay in the file as free space until you compact it.
            </span>
          </div>
        </div>

        <div className="px-4 pt-2 flex items-center gap-1 border-b border-weathered">
          {tabs.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setTab(option.value)}
              className={cn(
                'px-2.5 py-1.5 text-xs border-b-2 -mb-px transition-colors',
                tab === option.value
                  ? 'border-rca-red text-soft-charcoal font-medium'
                  : 'border-transparent text-soft-charcoal/50 hover:text-soft-charcoal'
              )}
            >
              {option.label}
            </button>
          ))}
          <div className="ml-auto pb-1">
            {tab === 'chats' && (
              <select
                value={chatSort}
                onChange={(e) => setChatSort(e.target.value as ChatSort)}
                className="select select-xs"
                aria-label="Sort chats"
              >
                <option value="size">Largest first</option>
                <option value="recent">Most recent</option>
                <option value="title">Title</option>
              </select>
            )}
            {tab === 'images' && (
              <select
                value={minInactiveDays}
                onChange={(e) => setMinInactiveDays(Number(e.target.value))}
                className="select select-xs"
                aria-label="Filter images by chat age"
              >
                {IMAGE_AGE_FILTERS.map((filter) => (
                  <option key={filter.days} value={filter.days}>{filter.label}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === 'chats' && (
            <ul className="divide-y divide-weathered/60">
              {sortedChats.map((chat) => (
                <li key={chat.conversationId} className="flex items-center gap-3 px-4 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-sm text-soft-charcoal">
                      {chat.isPinned && <Pin size={11} className="shrink-0 text-rca-red/70" />}
                      <span className="truncate" title={chat.title}>{chat.title}</span>
                    </div>
                    <div className="text-[11px] text-soft-charcoal/50 tabular-nums">
                      {chat.messageCount} messages · text {formatBytes(chat.textBytes)}
                      {chat.imageCount > 0 && ` · ${chat.imageCount} image${chat.imageCount === 1 ? '' : 's'} ${formatBytes(chat.imageBytes)}`}
                      {` · ${formatTimestamp(chat.updatedAt)}`}
                    </div>
                  </div>
                  <span className="text-xs font-medium text-soft-charcoal tabular-nums">{formatBytes(chat.totalBytes)}</span>
                  <button
                    type="button"
                    onClick={() => handleOpenChat(chat)}
                    disabled={isBusy}
                    className={`${ROW_BUTTON_CLASS} hover:bg-base-300 hover:text-soft-charcoal`}
                    title="Open chat"
                  >
                    <MessageSquare size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteChat(chat)}
                    disabled={isBusy}
                    className={`${ROW_BUTTON_CLASS} hover:bg-error/10 hover:text-error`}
                    title="Delete chat"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {tab === 'images' && (
            visibleImages.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-soft-charcoal/50">
                {images.length === 0 ? 'No stored images.' : 'No images in chats that old.'}
              </p>
            ) : (
              <ul className="divide-y divide-weathered/60">
                {visibleImages.map((image) => (
                  <li key={image.blobId} className="flex items-center gap-3 px-4 py-2">
                    <img
                      src={`${ATTACHMENT_URL_SCHEME}://${image.blobId}`}
                      alt=""
                      loading="lazy"
                      className="h-10 w-10 shrink-0 rounded-sm border border-weathered object-cover bg-base-100"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm text-soft-charcoal" title={image.name}>{image.name}</div>
                      <div
                        className="truncate text-[11px] text-soft-charcoal/50"
                        title={image.chats.map((chat) => chat.title).join('\n')}
                      >
                        {image.chats[0]?.title}
                        {image.chats.length > 1 && ` and ${image.chats.length - 1} more`}
                        {` · last active ${formatTimestamp(image.lastChatActivityAt)}`}
                      </div>
                    </div>
                    <span className="text-xs font-medium text-soft-charcoal tabular-nums">{formatBytes(image.bytes)}</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveImage(image)}
                      disabled={isBusy}
                      className={`${ROW_BUTTON_CLASS} hover:bg-error/10 hover:text-error`}
                      title="Remove image"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
