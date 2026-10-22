import { useState, useCallback } from 'react'
import { Copy, Check, RotateCcw, GitFork, Pencil, Trash2, ChevronLeft, ChevronRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ─── Action Descriptor ───────────────────────────────────────────────────────

export interface MessageAction {
  /** Unique key for React rendering. */
  key: string
  /** Lucide icon component. */
  icon: LucideIcon
  /** Tooltip text. */
  label: string
  /** Handler invoked on click. */
  onClick: () => void
}

// ─── Pre-built Action Factories ──────────────────────────────────────────────

/** Copy plain text to clipboard. Returns a MessageAction descriptor. */
export function useCopyAction(text: string): MessageAction {
  const [copied, setCopied] = useState(false)

  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied by the environment/user permissions.
    }
  }, [text])

  return {
    key: 'copy',
    icon: copied ? Check : Copy,
    label: copied ? 'Copied!' : 'Copy',
    onClick
  }
}

/** Retry action — just wraps a callback. */
export function retryAction(onRetry: () => void): MessageAction {
  return {
    key: 'retry',
    icon: RotateCcw,
    label: 'Retry',
    onClick: onRetry
  }
}

/** Edit action — opens inline edit for the latest user prompt. */
export function editAction(onEdit: () => void): MessageAction {
  return {
    key: 'edit',
    icon: Pencil,
    label: 'Edit',
    onClick: onEdit
  }
}

/** Fork action - starts a new chat from this message context. */
export function forkAction(onFork: () => void): MessageAction {
  return {
    key: 'fork',
    icon: GitFork,
    label: 'Fork Chat',
    onClick: onFork
  }
}

/** Delete-version action - removes this version of a message and what follows it. */
export function deleteVersionAction(onDelete: () => void): MessageAction {
  return {
    key: 'delete-version',
    icon: Trash2,
    label: 'Delete this version',
    onClick: onDelete
  }
}

// ─── Version Switcher ────────────────────────────────────────────────────────

export interface BranchPagerProps {
  /** Zero-based position among the versions. */
  index: number
  count: number
  onSelect: (offset: -1 | 1) => void
  disabled?: boolean
}

/** "‹ 2/3 ›" beneath a message that has other versions (retries or edits). */
function BranchPager({ index, count, onSelect, disabled = false }: BranchPagerProps) {
  return (
    <div className="message-branch-pager" aria-label={`Version ${index + 1} of ${count}`}>
      <button
        type="button"
        onClick={() => onSelect(-1)}
        disabled={disabled || index === 0}
        className="message-action-btn"
        title="Previous version"
      >
        <ChevronLeft size={13} />
      </button>
      <span>{index + 1}/{count}</span>
      <button
        type="button"
        onClick={() => onSelect(1)}
        disabled={disabled || index === count - 1}
        className="message-action-btn"
        title="Next version"
      >
        <ChevronRight size={13} />
      </button>
    </div>
  )
}

// ─── Toolbar Component ───────────────────────────────────────────────────────

interface MessageActionsBarProps {
  actions: MessageAction[]
  /** 'left' for assistant messages, 'right' for user messages. */
  align: 'left' | 'right'
  /** Set when the message has other versions; the switcher stays visible. */
  branch?: BranchPagerProps
}

/**
 * A small row beneath a message bubble: the version switcher, when there is
 * one, then icon-only buttons shown on hover (CSS class `message-row`).
 */
export function MessageActionsBar({ actions, align, branch }: MessageActionsBarProps) {
  if (actions.length === 0 && !branch) return null

  return (
    <div className={`flex items-center gap-1 mt-0.5 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
      {branch && <BranchPager {...branch} />}
      {actions.length > 0 && (
        <div className="message-actions flex items-center gap-0.5">
          {actions.map((action) => {
            const Icon = action.icon
            return (
              <button
                key={action.key}
                onClick={action.onClick}
                className="message-action-btn"
                title={action.label}
              >
                <Icon size={13} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
