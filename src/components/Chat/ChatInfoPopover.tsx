import { useEffect, useMemo, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { resolveConversationProfile, useContextProfileStore, useConversationStore } from '@/store'
import type { Conversation, Message, ProviderName } from '@/types'

const PROVIDER_LABELS: Record<ProviderName, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Custom'
}

function formatDateTime(value: number | string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function countToolCalls(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    if (!message.toolCalls) continue
    try {
      const parsed = JSON.parse(message.toolCalls) as unknown
      if (Array.isArray(parsed)) total += parsed.length
    } catch {
      // Ignore malformed tool call payloads.
    }
  }
  return total
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-soft-charcoal/45">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-soft-charcoal/80 ${mono ? 'font-mono text-[10px]' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mt-2 mb-0.5 text-[10px] uppercase tracking-widest text-soft-charcoal/30 first:mt-0">
      {children}
    </div>
  )
}

/**
 * Small "i" button next to the chat title that reveals technical details
 * about the active chat: model, request settings, and simple counts.
 */
export function ChatInfoPopover({ conversation }: { conversation: Conversation }) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const messages = useConversationStore((s) => s.messages)
  const profiles = useContextProfileStore((s) => s.profiles)
  const activeProfileId = useContextProfileStore((s) => s.activeProfileId)
  const { profile, isFallback } = resolveConversationProfile(conversation.profileId, { profiles, activeProfileId })
  const profileLabel = profile
    ? (isFallback ? `${profile.name} (active)` : profile.name)
    : '—'

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  // Close when switching chats.
  useEffect(() => {
    setIsOpen(false)
  }, [conversation.id])

  const stats = useMemo(() => {
    if (!isOpen) return null
    return {
      userMessages: messages.filter((m) => m.role === 'user').length,
      assistantMessages: messages.filter((m) => m.role === 'assistant').length,
      attachments: messages.reduce((sum, m) => sum + (m.attachments?.length ?? 0), 0),
      toolCalls: countToolCalls(messages)
    }
  }, [isOpen, messages])

  const lastRequest = conversation.lastRequest ?? null
  const hasMessages = messages.length > 0

  return (
    <div ref={containerRef} className="shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-label="Chat info"
        title="Chat info"
        className={`flex items-center justify-center h-6 w-6 rounded transition-colors ${isOpen
          ? 'text-soft-charcoal/70 bg-base-200'
          : 'text-soft-charcoal/30 hover:text-soft-charcoal/60'
        }`}
      >
        <Info size={13} />
      </button>

      {isOpen && (
        <div className="absolute left-4 top-full mt-1 z-40 w-72 max-w-[calc(100%-2rem)] rounded-lg border border-weathered bg-paper-stack shadow-lg px-3 py-2.5 text-[11px]">
          <div>
            {hasMessages ? (
              <>
                <InfoRow label="Model" value={conversation.model} mono />
                <InfoRow label="Provider" value={PROVIDER_LABELS[conversation.provider] ?? conversation.provider} />
              </>
            ) : (
              <p className="py-0.5 text-soft-charcoal/50">
                The model is set from Settings when you send the first message.
              </p>
            )}

            {lastRequest && (
              <>
                <SectionLabel>Last request</SectionLabel>
                <InfoRow label="Sent" value={formatDateTime(lastRequest.sentAt)} />
                <InfoRow label="Context profile" value={lastRequest.contextProfile ?? '—'} />
                <InfoRow
                  label="Temperature"
                  value={lastRequest.temperature === null ? 'Provider default' : lastRequest.temperature.toFixed(1)}
                />
                <InfoRow
                  label="Max tokens"
                  value={lastRequest.maxTokens === null ? 'Provider default' : lastRequest.maxTokens.toLocaleString()}
                />
                <InfoRow label="Reasoning" value={lastRequest.reasoningEnabled ? 'On' : 'Off'} />
                <InfoRow label="Web search" value={lastRequest.searchToolsEnabled ? 'On' : 'Off'} />
              </>
            )}

            {stats && (
              <>
                <SectionLabel>Chat</SectionLabel>
                <InfoRow
                  label="Messages"
                  value={`${stats.userMessages} sent · ${stats.assistantMessages} replies`}
                />
                <InfoRow label="Tool calls" value={String(stats.toolCalls)} />
                <InfoRow label="Attachments" value={String(stats.attachments)} />
                <InfoRow label="Context profile" value={profileLabel} />
                <InfoRow label="Workspace" value={conversation.workspacePath ?? 'None'} />
                <InfoRow label="Created" value={formatDateTime(conversation.createdAt)} />
                <InfoRow label="Last activity" value={formatDateTime(conversation.updatedAt)} />
                <InfoRow label="Chat ID" value={conversation.id} mono />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
