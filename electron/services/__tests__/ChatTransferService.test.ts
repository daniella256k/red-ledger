import { describe, expect, it } from 'vitest'
import type { Conversation, Message } from '../../../src/types'
import { ChatTransferService } from '../ChatTransferService'
import type { ConversationService } from '../ConversationService'

interface FakeServiceState {
  conversations: Map<string, Conversation>
  messages: Map<string, Message[]>
  created: Array<{ conversationId: string; message: Omit<Message, 'id' | 'createdAt' | 'timestamp'> }>
  newConversations: Array<Partial<Conversation>>
}

function createFakeConversationService(state: FakeServiceState): ConversationService {
  let nextId = 1
  return {
    getConversation: (id: string) => state.conversations.get(id) ?? null,
    listMessages: (id: string) => state.messages.get(id) ?? [],
    createConversation: (data: Partial<Conversation>): Conversation => {
      const id = `imported-${nextId++}`
      const now = Date.now()
      const conversation: Conversation = {
        id,
        title: data.title ?? 'Untitled',
        model: data.model ?? 'gpt-4',
        provider: data.provider ?? 'openai',
        isPinned: data.isPinned ?? false,
        createdAt: now,
        updatedAt: now,
        workspacePath: data.workspacePath ?? null,
        profileId: data.profileId ?? null
      }
      state.conversations.set(id, conversation)
      state.messages.set(id, [])
      state.newConversations.push(data)
      return conversation
    },
    createMessage: (data: Omit<Message, 'id' | 'createdAt' | 'timestamp'>): Message => {
      state.created.push({ conversationId: data.conversationId, message: data })
      const message: Message = {
        ...data,
        id: `msg-${state.created.length}`,
        createdAt: Date.now(),
        timestamp: new Date().toISOString()
      }
      const list = state.messages.get(data.conversationId) ?? []
      list.push(message)
      state.messages.set(data.conversationId, list)
      return message
    }
  } as unknown as ConversationService
}

const sampleConversation: Conversation = {
  id: 'conv-1',
  title: 'My <test> chat & co.',
  model: 'gpt-4',
  provider: 'openrouter',
  isPinned: false,
  createdAt: 1700000000000,
  updatedAt: 1700000060000,
  workspacePath: '/some/path',
  profileId: null
}

const sampleMessages: Message[] = [
  {
    id: 'm1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Hello, world!\n  Indented line.\n\nWith blank line.',
    timestamp: '2024-01-01T00:00:00.000Z',
    createdAt: 1700000000000,
    attachments: [
      { kind: 'text', name: 'note.txt', content: 'attached text' }
    ]
  },
  {
    id: 'm2',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'Reply with <special> chars & ]]> sequence.',
    thinking: 'Considering options',
    toolCalls: '[{"id":"t1","name":"echo","arguments":{"x":1}}]',
    timestamp: '2024-01-01T00:00:01.000Z',
    createdAt: 1700000001000,
    attachments: [
      {
        kind: 'image',
        name: 'pic.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo='
      }
    ]
  }
]

describe('ChatTransferService', () => {
  it('exports markdown with title, metadata, and message bodies', () => {
    const state: FakeServiceState = {
      conversations: new Map([['conv-1', sampleConversation]]),
      messages: new Map([['conv-1', sampleMessages]]),
      created: [],
      newConversations: []
    }
    const service = new ChatTransferService(createFakeConversationService(state))

    const md = service.exportConversation('conv-1', 'markdown')

    expect(md).toContain('# My <test> chat & co.')
    expect(md).toContain('| Provider | openrouter |')
    expect(md).toContain('## User —')
    expect(md).toContain('## Assistant —')
    expect(md).toContain('Hello, world!')
    expect(md).toContain('Reply with <special> chars')
    expect(md).toContain('Tool Calls')
    expect(md).toContain('Thinking')
    expect(md).toContain('**File:** note.txt')
    expect(md).toContain('**Image:** pic.png (image/png)')
  })

  it('round-trips XML preserving content, attachments, thinking, and tool calls', () => {
    const state: FakeServiceState = {
      conversations: new Map([['conv-1', sampleConversation]]),
      messages: new Map([['conv-1', sampleMessages]]),
      created: [],
      newConversations: []
    }
    const service = new ChatTransferService(createFakeConversationService(state))

    const xml = service.exportConversation('conv-1', 'xml')
    expect(xml.startsWith('<?xml')).toBe(true)
    expect(xml).toContain('<redLedgerChat version="1">')

    const result = service.importFromXml(xml)

    expect(result.importedMessageCount).toBe(2)
    expect(state.newConversations[0]).toMatchObject({
      title: 'My <test> chat & co.',
      model: 'gpt-4',
      provider: 'openrouter',
      workspacePath: '/some/path'
    })

    expect(state.created).toHaveLength(2)

    const [first, second] = state.created.map((c) => c.message)

    expect(first.role).toBe('user')
    expect(first.content).toBe(sampleMessages[0].content)
    expect(first.attachments).toEqual(sampleMessages[0].attachments)

    expect(second.role).toBe('assistant')
    expect(second.content).toBe(sampleMessages[1].content)
    expect(second.thinking).toBe('Considering options')
    expect(second.toolCalls).toBe('[{"id":"t1","name":"echo","arguments":{"x":1}}]')
    expect(second.attachments).toEqual(sampleMessages[1].attachments)
  })

  it('preserves message content containing the CDATA terminator sequence', () => {
    const tricky: Message = {
      id: 'm1',
      conversationId: 'conv-1',
      role: 'user',
      content: 'before ]]> after',
      timestamp: '2024-01-01T00:00:00.000Z',
      createdAt: 1700000000000
    }
    const state: FakeServiceState = {
      conversations: new Map([['conv-1', sampleConversation]]),
      messages: new Map([['conv-1', [tricky]]]),
      created: [],
      newConversations: []
    }
    const service = new ChatTransferService(createFakeConversationService(state))

    const xml = service.exportConversation('conv-1', 'xml')
    const result = service.importFromXml(xml)

    expect(result.importedMessageCount).toBe(1)
    expect(state.created[0].message.content).toBe('before ]]> after')
  })

  it('falls back to default provider for unknown providers', () => {
    const state: FakeServiceState = {
      conversations: new Map(),
      messages: new Map(),
      created: [],
      newConversations: []
    }
    const service = new ChatTransferService(createFakeConversationService(state))

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<redLedgerChat version="1">
  <conversation>
    <title><![CDATA[Imported]]></title>
    <model><![CDATA[gpt-4]]></model>
    <provider><![CDATA[bogus-provider]]></provider>
    <createdAt>0</createdAt>
    <updatedAt>0</updatedAt>
  </conversation>
  <messages>
    <message role="user" timestamp="2024-01-01T00:00:00.000Z" createdAt="0">
      <content><![CDATA[hi]]></content>
    </message>
  </messages>
</redLedgerChat>`

    service.importFromXml(xml)

    expect(state.newConversations[0]).toMatchObject({ provider: 'openai' })
  })

  it('rejects XML missing the redLedgerChat root', () => {
    const state: FakeServiceState = {
      conversations: new Map(),
      messages: new Map(),
      created: [],
      newConversations: []
    }
    const service = new ChatTransferService(createFakeConversationService(state))

    expect(() =>
      service.importFromXml('<?xml version="1.0"?><wrong></wrong>')
    ).toThrow(/Unexpected root element/)
  })

  it('sanitizes filenames derived from the title', () => {
    const state: FakeServiceState = {
      conversations: new Map([
        ['conv-1', { ...sampleConversation, title: 'a/b\\c:?* "<>|.' }]
      ]),
      messages: new Map([['conv-1', []]]),
      created: [],
      newConversations: []
    }
    const service = new ChatTransferService(createFakeConversationService(state))

    const name = service.buildSuggestedFilename('conv-1')
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
    expect(name.length).toBeGreaterThan(0)
  })
})
