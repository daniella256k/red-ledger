import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, Conversation } from '@/types'
import { selectComposer, useConversationStore } from '../conversationStore'
import { useContextProfileStore } from '../contextProfileStore'

function conversation(id: string): Conversation {
  return {
    id,
    title: 'New Chat',
    model: 'm',
    provider: 'openai',
    isPinned: false,
    createdAt: 1,
    updatedAt: 1,
    workspacePath: null,
    lastRequest: null,
    profileId: null
  } as Conversation
}

const attachment = { kind: 'text', name: 'notes.txt', content: 'x' } as unknown as Attachment

const api = {
  createConversation: vi.fn(async () => conversation('created')),
  listMessages: vi.fn(async () => []),
  deleteConversation: vi.fn(async () => {})
}

function composer() {
  return selectComposer(useConversationStore.getState())
}

function setProfile(activeProfileId: string) {
  useContextProfileStore.setState({ activeProfileId })
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = { redLedger: api }
  useConversationStore.setState({
    conversations: [conversation('saved')],
    activeConversationId: null,
    messages: [],
    isLoadingMessages: false,
    draft: null,
    chatComposer: { input: '', attachments: [] }
  })
  setProfile('default')
})

describe('New Chat draft', () => {
  it('opens one unsaved draft however often New Chat is clicked', async () => {
    const store = useConversationStore.getState()
    await store.openDraft()
    await store.openDraft()
    await useConversationStore.getState().setActiveConversation('saved')
    await useConversationStore.getState().openDraft()

    expect(api.createConversation).not.toHaveBeenCalled()
    expect(useConversationStore.getState().draft).not.toBeNull()
    expect(useConversationStore.getState().conversations).toHaveLength(1)
  })

  it('keeps its text and attachments while another chat is open', async () => {
    await useConversationStore.getState().openDraft()
    useConversationStore.getState().setComposerInput('masterpiece prompt')
    useConversationStore.getState().addComposerAttachments([attachment])

    await useConversationStore.getState().setActiveConversation('saved')
    expect(composer()).toEqual({ input: '', attachments: [] })

    await useConversationStore.getState().setActiveConversation(null)
    expect(composer()).toMatchObject({ input: 'masterpiece prompt', attachments: [attachment] })
  })

  it('does not carry text typed in a saved chat to another chat', async () => {
    useConversationStore.setState({ conversations: [conversation('saved'), conversation('other')] })
    await useConversationStore.getState().setActiveConversation('saved')
    useConversationStore.getState().setComposerInput('half a thought')

    await useConversationStore.getState().setActiveConversation('other')

    expect(composer().input).toBe('')
    expect(useConversationStore.getState().draft).toBeNull()
  })

  it('remembers the profile it was left set to', async () => {
    setProfile('campaign-a')
    await useConversationStore.getState().openDraft()
    setProfile('committee-b')

    // Opening a saved chat switches the active profile to that chat's.
    await useConversationStore.getState().setActiveConversation('saved')
    setProfile('default')

    expect(useConversationStore.getState().draft?.profileId).toBe('committee-b')
  })

  it('starts when typing on the start screen', () => {
    useConversationStore.getState().setComposerInput('hello')

    expect(useConversationStore.getState().draft).toMatchObject({ input: 'hello', profileId: 'default' })
  })

  it('becomes the new chat on its first send', async () => {
    await useConversationStore.getState().openDraft()
    useConversationStore.getState().setComposerInput('hello')

    await useConversationStore.getState().createConversation({ workspacePath: null })

    const state = useConversationStore.getState()
    expect(api.createConversation).toHaveBeenCalledTimes(1)
    expect(state.activeConversationId).toBe('created')
    expect(state.draft).toBeNull()
    expect(composer().input).toBe('')
  })

  it('can be discarded', async () => {
    await useConversationStore.getState().openDraft()
    useConversationStore.getState().setComposerInput('never mind')

    useConversationStore.getState().discardDraft()

    expect(useConversationStore.getState().draft).toBeNull()
    expect(composer().input).toBe('')
  })
})
