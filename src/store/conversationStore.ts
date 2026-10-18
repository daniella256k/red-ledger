import { create } from 'zustand'
import type { Conversation, Message } from '@/types'
import { formatError } from '@/lib/errors'
import { notify } from '@/lib/notify'

function sortConversationsByPriority(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => {
    const pinnedDelta = Number(b.isPinned) - Number(a.isPinned)
    if (pinnedDelta !== 0) return pinnedDelta
    return b.updatedAt - a.updatedAt
  })
}

interface ConversationState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: Message[]
  isLoadingMessages: boolean

  loadConversations: () => Promise<void>
  searchConversations: (query: string) => Promise<void>
  createConversation: (partial?: Partial<Conversation>) => Promise<Conversation>
  forkConversationFromMessage: (messageId: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  setConversationPinned: (id: string, isPinned: boolean) => Promise<void>
  setConversationWorkspace: (id: string, workspacePath: string | null) => Promise<void>
  setConversationProfile: (id: string, profileId: string) => Promise<void>
  setActiveConversation: (id: string | null) => Promise<void>
  loadMessages: (conversationId: string) => Promise<void>
  addMessage: (data: Omit<Message, 'id' | 'createdAt' | 'timestamp'>) => Promise<Message>
  touchConversation: (id: string, updatedAt?: number) => void
  updateMessage: (id: string, data: Partial<Message>) => void
  deleteMessagesFrom: (messageId: string) => Promise<void>
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  isLoadingMessages: false,

  loadConversations: async () => {
    if (!window.redLedger) return
    try {
      const conversations = await window.redLedger.listConversations()
      set({ conversations: sortConversationsByPriority(conversations) })
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  },

  searchConversations: async (query) => {
    if (!window.redLedger) return
    if (query.trim().length === 0) {
      await get().loadConversations()
      return
    }
    try {
      const conversations = await window.redLedger.searchConversations(query)
      set({ conversations: sortConversationsByPriority(conversations) })
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  },

  createConversation: async (partial) => {
    if (!window.redLedger) throw new Error('API not available')
    try {
      const conversation = await window.redLedger.createConversation(partial ?? {})
      set((state) => ({
        conversations: sortConversationsByPriority([conversation, ...state.conversations]),
        activeConversationId: conversation.id,
        messages: []
      }))
      return conversation
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
      throw err
    }
  },

  forkConversationFromMessage: async (messageId) => {
    if (!window.redLedger) throw new Error('API not available')

    const { activeConversationId } = get()
    if (!activeConversationId) return

    try {
      const forkedConversation = await window.redLedger.forkConversation(activeConversationId, messageId)
      const [conversations, messages] = await Promise.all([
        window.redLedger.listConversations(),
        window.redLedger.listMessages(forkedConversation.id)
      ])

      set({
        conversations: sortConversationsByPriority(conversations),
        activeConversationId: forkedConversation.id,
        messages,
        isLoadingMessages: false
      })
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
      throw err
    }
  },

  deleteConversation: async (id) => {
    if (!window.redLedger) return
    try {
      await window.redLedger.deleteConversation(id)
      const { activeConversationId } = get()
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== id),
        activeConversationId: activeConversationId === id ? null : activeConversationId,
        messages: activeConversationId === id ? [] : state.messages
      }))
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  },

  renameConversation: async (id, title) => {
    if (!window.redLedger) return
    try {
      await window.redLedger.updateConversation(id, { title })
      const updatedAt = Date.now()
      set((state) => ({
        conversations: sortConversationsByPriority(
          state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt } : c
          )
        )
      }))
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  },

  setConversationPinned: async (id, isPinned) => {
    if (!window.redLedger) return
    try {
      await window.redLedger.updateConversation(id, { isPinned })
      set((state) => ({
        conversations: sortConversationsByPriority(
          state.conversations.map((c) =>
            c.id === id ? { ...c, isPinned } : c
          )
        )
      }))
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  },

  setConversationWorkspace: async (id, workspacePath) => {
    if (!window.redLedger) return
    try {
      await window.redLedger.updateConversation(id, { workspacePath })
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, workspacePath } : c
        )
      }))
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  },

  setConversationProfile: async (id, profileId) => {
    if (!window.redLedger) return
    try {
      await window.redLedger.updateConversation(id, { profileId })
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, profileId } : c
        )
      }))
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  },

  setActiveConversation: async (id) => {
    set({ activeConversationId: id, messages: [], isLoadingMessages: !!id })

    if (id) {
      await get().loadMessages(id)
    }
  },

  loadMessages: async (conversationId) => {
    set({ isLoadingMessages: true })
    if (!window.redLedger) { set({ isLoadingMessages: false }); return }
    try {
      const messages = await window.redLedger.listMessages(conversationId)
      // Only update if this conversation is still active
      if (get().activeConversationId === conversationId) {
        set({ messages, isLoadingMessages: false })
      }
    } catch (err) {
      set({ isLoadingMessages: false })
      notify({ type: 'error', message: formatError(err) })
    }
  },

  addMessage: async (data) => {
    if (!window.redLedger) throw new Error('API not available')
    try {
      const message = await window.redLedger.createMessage(data)
      const updatedAt = message.createdAt
      set((state) => ({
        messages: state.activeConversationId === data.conversationId
          ? [...state.messages, message]
          : state.messages,
        conversations: sortConversationsByPriority(
          state.conversations.map((c) =>
            c.id === data.conversationId ? { ...c, updatedAt } : c
          )
        )
      }))

      return message
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
      throw err
    }
  },

  touchConversation: (id, updatedAt = Date.now()) => {
    set((state) => ({
      conversations: sortConversationsByPriority(
        state.conversations.map((c) =>
          c.id === id ? { ...c, updatedAt } : c
        )
      )
    }))
  },

  // Local-only update (for streaming content accumulation)
  updateMessage: (id, data) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...data } : m
      )
    }))
  },

  deleteMessagesFrom: async (messageId) => {
    if (!window.redLedger) return
    const { activeConversationId, messages } = get()
    if (!activeConversationId) return

    const msgIndex = messages.findIndex((m) => m.id === messageId)
    if (msgIndex === -1) return

    try {
      await window.redLedger.deleteMessagesFrom(activeConversationId, messageId)
      set((state) => ({
        messages: state.messages.slice(0, msgIndex)
      }))
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  }
}))
