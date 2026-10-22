import { create } from 'zustand'
import type { Attachment, Conversation, CreateMessageInput, Message, SelectBranchOptions } from '@/types'
import { formatError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import { useContextProfileStore } from './contextProfileStore'

function sortConversationsByPriority(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => {
    const pinnedDelta = Number(b.isPinned) - Number(a.isPinned)
    if (pinnedDelta !== 0) return pinnedDelta
    return b.updatedAt - a.updatedAt
  })
}

/** What is typed into the message box but not sent yet. */
export interface ComposerContent {
  input: string
  attachments: Attachment[]
}

/**
 * The one unsaved New Chat. It is not in the database: it becomes a real chat
 * on its first send, and closing the app discards it. While you look at other
 * chats it keeps what was typed for it and the profile it was set to.
 */
export interface ChatDraft extends ComposerContent {
  profileId: string | null
}

const EMPTY_COMPOSER: ComposerContent = { input: '', attachments: [] }

interface ConversationState {
  conversations: Conversation[]
  // null means the New Chat view (the draft, or the empty start screen) is on screen.
  activeConversationId: string | null
  messages: Message[]
  isLoadingMessages: boolean
  draft: ChatDraft | null
  // The message box for a saved chat. It starts empty each time you open a chat.
  chatComposer: ComposerContent

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
  addMessage: (data: CreateMessageInput) => Promise<Message>
  touchConversation: (id: string, updatedAt?: number) => void
  updateMessage: (id: string, data: Partial<Message>) => void
  /** Shows another version of a message (see RedLedgerAPI.selectBranch). */
  selectBranch: (messageId: string, options?: SelectBranchOptions) => Promise<void>
  /** Deletes a version of a message and everything after it. */
  deleteMessageBranch: (messageId: string) => Promise<void>

  openDraft: () => Promise<void>
  discardDraft: () => void
  setDraftProfile: (profileId: string) => void
  setComposerInput: (input: string) => void
  addComposerAttachments: (attachments: Attachment[]) => void
  removeComposerAttachment: (index: number) => void
  clearComposer: () => void
}

/** The message box contents for whatever is on screen. */
export function selectComposer(state: Pick<ConversationState, 'activeConversationId' | 'draft' | 'chatComposer'>): ComposerContent {
  if (state.activeConversationId !== null) return state.chatComposer
  return state.draft ?? EMPTY_COMPOSER
}

function currentProfileId(): string | null {
  return useContextProfileStore.getState().activeProfileId ?? null
}

/**
 * State changes for putting a different chat (or the New Chat view, for null)
 * on screen. Leaving the New Chat view remembers the draft's profile, so it
 * can be put back on return; a saved chat always opens with an empty box.
 */
function switchTo(state: ConversationState, nextId: string | null): Partial<ConversationState> {
  if (nextId === state.activeConversationId) return { activeConversationId: nextId }
  const leavingDraft = state.activeConversationId === null && state.draft !== null
  return {
    activeConversationId: nextId,
    chatComposer: EMPTY_COMPOSER,
    ...(leavingDraft ? { draft: { ...state.draft!, profileId: currentProfileId() } } : {})
  }
}

/** Applies a change to the message box on screen, creating the draft if it is the New Chat view's. */
function updateComposer(
  state: ConversationState,
  change: (content: ComposerContent) => ComposerContent
): Partial<ConversationState> {
  if (state.activeConversationId !== null) {
    return { chatComposer: change(state.chatComposer) }
  }
  const draft = state.draft ?? { ...EMPTY_COMPOSER, profileId: currentProfileId() }
  return { draft: { ...draft, ...change(draft) } }
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  isLoadingMessages: false,
  draft: null,
  chatComposer: EMPTY_COMPOSER,

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
      // This is the draft's first send, so the draft becomes this chat.
      set((state) => ({
        conversations: sortConversationsByPriority([conversation, ...state.conversations]),
        activeConversationId: conversation.id,
        messages: [],
        draft: null,
        chatComposer: EMPTY_COMPOSER
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

      set((state) => ({
        ...switchTo(state, forkedConversation.id),
        conversations: sortConversationsByPriority(conversations),
        messages,
        isLoadingMessages: false
      }))
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
        ...(activeConversationId === id ? switchTo(state, null) : {}),
        conversations: state.conversations.filter((c) => c.id !== id),
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
    set((state) => ({ ...switchTo(state, id), messages: [], isLoadingMessages: !!id }))

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
      // A message placed under a chosen parent (an edit) starts a new branch,
      // so the branch on screen is reloaded rather than appended to.
      const branch = data.parentId !== undefined && get().activeConversationId === data.conversationId
        ? await window.redLedger.listMessages(data.conversationId)
        : null
      set((state) => ({
        messages: state.activeConversationId !== data.conversationId
          ? state.messages
          : branch ?? [...state.messages, message],
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

  selectBranch: async (messageId, options) => {
    if (!window.redLedger) return
    const conversationId = get().activeConversationId
    if (!conversationId) return

    try {
      const messages = await window.redLedger.selectBranch(conversationId, messageId, options)
      if (get().activeConversationId === conversationId) set({ messages })
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
      throw err
    }
  },

  deleteMessageBranch: async (messageId) => {
    if (!window.redLedger) return
    const conversationId = get().activeConversationId
    if (!conversationId) return

    try {
      const messages = await window.redLedger.deleteMessageBranch(conversationId, messageId)
      if (get().activeConversationId === conversationId) set({ messages })
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  },

  // New Chat: go to the one draft, making it if there is none yet.
  openDraft: async () => {
    if (get().activeConversationId === null && get().draft !== null) return
    set((state) => ({
      draft: state.draft ?? { ...EMPTY_COMPOSER, profileId: currentProfileId() }
    }))
    await get().setActiveConversation(null)
  },

  discardDraft: () => {
    set({ draft: null })
  },

  setDraftProfile: (profileId) => {
    set((state) => (state.draft ? { draft: { ...state.draft, profileId } } : {}))
  },

  setComposerInput: (input) => {
    set((state) => updateComposer(state, (content) => ({ ...content, input })))
  },

  addComposerAttachments: (attachments) => {
    if (attachments.length === 0) return
    set((state) => updateComposer(state, (content) => ({
      ...content,
      attachments: [...content.attachments, ...attachments]
    })))
  },

  removeComposerAttachment: (index) => {
    set((state) => updateComposer(state, (content) => ({
      ...content,
      attachments: content.attachments.filter((_, i) => i !== index)
    })))
  },

  clearComposer: () => {
    set((state) => {
      if (state.activeConversationId !== null) return { chatComposer: EMPTY_COMPOSER }
      return state.draft ? { draft: { ...state.draft, ...EMPTY_COMPOSER } } : {}
    })
  }
}))
