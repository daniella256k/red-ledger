import { create } from 'zustand'
import type { Conversation, LiveTurn, TurnEvent } from '@/types'
import { notify } from '@/lib/notify'
import { DEFAULT_CHAT_TITLE } from '@/lib/chatTitle'
import { useConversationStore } from './conversationStore'
import { useUIStore } from './uiStore'

/**
 * Running turns, by chat. The main process runs them (see TurnEvent); this
 * follows their progress so the chat on screen can show its reply as it is
 * written, and the sidebar which chats are working.
 */
interface TurnState {
  turns: Record<string, LiveTurn>
  applyEvent: (event: TurnEvent) => void
  /** Replaces what is known with the main process's own list (after a reload). */
  applySnapshot: (turns: LiveTurn[]) => void
}

function sortConversationsByPriority(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => {
    const pinnedDelta = Number(b.isPinned) - Number(a.isPinned)
    if (pinnedDelta !== 0) return pinnedDelta
    return b.updatedAt - a.updatedAt
  })
}

/** A notice from a chat not on screen says which chat it came from. */
function noticeText(conversationId: string, message: string): string {
  const { activeConversationId, conversations } = useConversationStore.getState()
  if (conversationId === activeConversationId) return message
  const title = conversations.find((c) => c.id === conversationId)?.title.trim() || DEFAULT_CHAT_TITLE
  return `In "${title}": ${message}`
}

/** The chat's saved record, put in place of the one in the list (if the list shows it). */
function applyConversation(conversation: Conversation): void {
  useConversationStore.setState((state) => {
    if (!state.conversations.some((c) => c.id === conversation.id)) return {}
    return {
      conversations: sortConversationsByPriority(
        state.conversations.map((c) => (c.id === conversation.id ? conversation : c))
      )
    }
  })
}

function withoutTurn(turns: Record<string, LiveTurn>, conversationId: string, turnId: string): Record<string, LiveTurn> {
  if (turns[conversationId]?.turnId !== turnId) return turns
  const next = { ...turns }
  delete next[conversationId]
  return next
}

export const useTurnStore = create<TurnState>((set, get) => ({
  turns: {},

  applySnapshot: (turns) => {
    set({ turns: Object.fromEntries(turns.map((turn) => [turn.conversationId, turn])) })
  },

  applyEvent: (event) => {
    switch (event.type) {
      case 'started':
        set((state) => ({ turns: { ...state.turns, [event.turn.conversationId]: event.turn } }))
        break

      case 'update': {
        const turn = get().turns[event.conversationId]
        if (!turn || turn.turnId !== event.turnId || event.seq <= turn.seq) break
        set((state) => ({
          turns: {
            ...state.turns,
            [event.conversationId]: {
              ...turn,
              seq: event.seq,
              content: event.content,
              thinking: event.thinking,
              phase: event.phase,
              toolCalls: event.toolCalls ?? turn.toolCalls
            }
          }
        }))
        break
      }

      case 'notice':
        notify({ type: event.level, message: noticeText(event.conversationId, event.message) })
        break

      case 'conversation':
        applyConversation(event.conversation)
        break

      case 'filesChanged':
        useUIStore.getState().bumpFileTree()
        break

      case 'finished': {
        const { conversationId, turnId } = event
        if (useConversationStore.getState().activeConversationId !== conversationId) {
          set((state) => ({ turns: withoutTurn(state.turns, conversationId, turnId) }))
          break
        }
        // The chat on screen keeps showing the live reply until the saved
        // branch is back, then swaps both at once (no flash of older text).
        void window.redLedger.listMessages(conversationId)
          .then((messages) => {
            if (useConversationStore.getState().activeConversationId === conversationId) {
              useConversationStore.setState({ messages })
            }
          })
          .catch(() => {})
          .finally(() => {
            set((state) => ({ turns: withoutTurn(state.turns, conversationId, turnId) }))
          })
        break
      }
    }
  }
}))

let subscribed = false

/**
 * Follows turn events for the life of the page, then catches up on turns
 * already running (after a reload). Call once at startup.
 */
export function initTurnEvents(): void {
  if (subscribed || !window.redLedger) return
  subscribed = true
  window.redLedger.onTurnEvent((event) => useTurnStore.getState().applyEvent(event))
  // Events sent before this answer are already part of it; later ones come after it.
  window.redLedger.listActiveTurns()
    .then((turns) => useTurnStore.getState().applySnapshot(turns))
    .catch(() => {})
}
