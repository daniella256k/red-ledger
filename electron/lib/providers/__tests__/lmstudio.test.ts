import { describe, expect, it } from 'vitest'
import { toNativeChatMessages } from '../lmstudio'

describe('LM Studio native messages', () => {
  it('folds tool rounds into the assistant text, keeping the results', () => {
    const messages = toNativeChatMessages([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'what is in notes.md?' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.md"}' } }]
      },
      { role: 'tool', content: '{"content":"buy paint"}', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'It says to buy paint.' },
      { role: 'user', content: 'thanks' }
    ])

    expect(messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'what is in notes.md?' },
      {
        role: 'assistant',
        content: 'Checking.\n\n[Called read_file {"path":"notes.md"}]\n\n'
          + '[Result of read_file]\n{"content":"buy paint"}\n\n'
          + 'It says to buy paint.'
      },
      { role: 'user', content: 'thanks' }
    ])
  })

  it('leaves chats without tools as they are', () => {
    expect(toNativeChatMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ])).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ])
  })
})
