import { describe, expect, it } from 'vitest'
import { LlmService, MAX_TOOL_CALLS, buildPastReplyMessages, buildToolCallBudgetNotice, estimateUsage, fitToolResultsToContext } from '../LlmService'
import { parseStoredToolCalls } from '../../../src/lib/storedToolCalls'
import { sanitizeSettings } from '../SettingsService'
import { BaseLLMProvider, readContextLength, reportedUsageChunk } from '../../lib/providers/base'
import type { LLMMessage, ProviderSendOptions } from '../../lib/providers/base'
import { registerProvider } from '../../lib/providers/registry'
import { registerTool } from '../../lib/tools/registry'
import { detectFileType } from '../../lib/fileType'
import type { Attachment, StreamChunk } from '../../../src/types'

function createService(): LlmService {
  return new LlmService({
    getSettings: () => ({} as never),
    getSystemPrompt: () => ''
  })
}

function invokeBuildOrgSearchToolDescription(service: LlmService, orgSite: string): string {
  const internal = service as unknown as {
    buildOrgSearchToolDescription: (value: string | undefined) => string
  }
  return internal.buildOrgSearchToolDescription(orgSite)
}

function invokeBuildTextAttachmentBlocks(service: LlmService, attachments: Attachment[]): string {
  const internal = service as unknown as {
    buildTextAttachmentBlocks: (value: Attachment[]) => string
  }
  return internal.buildTextAttachmentBlocks(attachments)
}

describe('LlmService org_search tool description', () => {
  it('includes the configured org site and effective site operator', () => {
    const service = createService()
    const description = invokeBuildOrgSearchToolDescription(service, 'reuters.com')

    expect(description).toContain('Current org_search site setting: "reuters.com"')
    expect(description).toContain('effective filter: site:reuters.com')
  })

  it('normalizes URL org sites to hostname for the effective site operator', () => {
    const service = createService()
    const description = invokeBuildOrgSearchToolDescription(
      service,
      'https://www.reuters.com/world/business?foo=1'
    )

    expect(description).toContain(
      'Current org_search site setting: "https://www.reuters.com/world/business?foo=1"'
    )
    expect(description).toContain('effective filter: site:www.reuters.com')
  })

  it('reports when org site is not set', () => {
    const service = createService()
    const description = invokeBuildOrgSearchToolDescription(service, '   ')

    expect(description).toContain('Current org_search site setting: not set')
  })
})

describe('LlmService text attachment formatting', () => {
  it('renders text attachments as strict tags with type, line and byte metadata', () => {
    const service = createService()
    const content = 'Workers of the world,\nunite!'
    const result = invokeBuildTextAttachmentBlocks(service, [
      { kind: 'text', name: 'manifesto.txt', content }
    ])

    expect(result).toContain('<attached_file name="manifesto.txt" type="text" lines="2" bytes="28">')
    expect(result).not.toContain('md5')
    expect(result).toContain(content)
    expect(result).toContain('</attached_file>')
    expect(result).not.toContain('```')
  })

  it('escapes attachment names and ignores image attachments', () => {
    const service = createService()
    const result = invokeBuildTextAttachmentBlocks(service, [
      { kind: 'text', name: 'dialectics "v1" <draft>&.md', content: 'line one' },
      { kind: 'image', name: 'poster.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }
    ])

    expect(result).toContain('name="dialectics &quot;v1&quot; &lt;draft&gt;&amp;.md"')
    expect((result.match(/<attached_file /g) || []).length).toBe(1)
    expect(result).not.toContain('poster.png')
  })
})

describe('LlmService tool call budget', () => {
  it('only produces a notice when a warning threshold is crossed', () => {
    expect(buildToolCallBudgetNotice(0, 24)).toBeNull()
    expect(buildToolCallBudgetNotice(23, 26)).toContain('used=26')
    expect(buildToolCallBudgetNotice(25, 39)).toBeNull()
    expect(buildToolCallBudgetNotice(39, 40)).toContain('used=40')
    expect(buildToolCallBudgetNotice(49, 50)).toContain(`limit=${MAX_TOOL_CALLS}`)
    expect(buildToolCallBudgetNotice(74, 75)).toContain('reached the tool call limit')
    expect(buildToolCallBudgetNotice(75, 75)).toBeNull()
  })

  function createLoopingService(stopWhenLimited: boolean) {
    const roundsSeen: LLMMessage[][] = []

    class LoopingProvider extends BaseLLMProvider {
      sendStreaming(options: ProviderSendOptions) {
        roundsSeen.push([...options.messages])
        const last = options.messages[options.messages.length - 1]
        const limited = typeof last?.content === 'string' && last.content.includes('LIMIT_REACHED')
        queueMicrotask(() => {
          if (!(stopWhenLimited && limited)) {
            options.onChunk({
              type: 'tool_call',
              toolCall: { id: `call-${roundsSeen.length}`, name: 'noop', arguments: {} }
            })
          } else {
            options.onChunk({ type: 'text', content: 'Final answer' })
          }
          options.onChunk({ type: 'done' })
        })
        return { abort: () => {} }
      }

      async listModels() {
        return []
      }
    }

    registerProvider({
      name: 'openai',
      displayName: 'Looping',
      defaultBaseUrl: '',
      factory: () => new LoopingProvider('', '')
    })

    const service = new LlmService({
      getSettings: () => sanitizeSettings(undefined),
      getSystemPrompt: () => 'system'
    })
    const chunks: StreamChunk[] = []
    const run = () => service.orchestrateStream(
      {
        conversationId: 'c1',
        messages: [{ role: 'user', content: 'research', timestamp: '2026-01-01T00:00:00.000Z' }],
        model: 'test',
        provider: 'openai'
      },
      'stream-1',
      { send: (chunk) => chunks.push(chunk) },
      async (tc) => ({ ...tc, result: { ok: true } })
    )

    return { run, chunks, roundsSeen }
  }

  function toolMessages(messages: LLMMessage[]): string[] {
    return messages
      .filter((m) => m.role === 'tool')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
  }

  it('warns the model at thresholds and stops a model that ignores the hard limit', async () => {
    const { run, chunks, roundsSeen } = createLoopingService(false)
    await run()

    const finalHistory = toolMessages(roundsSeen[roundsSeen.length - 1])
    const noticeIndexes = finalHistory
      .map((content, index) => (content.includes('[system: tool_call_budget') ? index + 1 : null))
      .filter((value) => value !== null)
    expect(noticeIndexes).toEqual([25, 40, 50, 75])

    const limited = chunks.filter((c) =>
      c.type === 'tool_result'
      && (c.toolCall?.result as { code?: string } | undefined)?.code === 'LIMIT_REACHED'
    )
    expect(limited).toHaveLength(2)
    expect(chunks.filter((c) => c.type === 'notice')).toHaveLength(1)
    expect(chunks.some((c) => c.type === 'error')).toBe(true)
    expect(chunks[chunks.length - 1].type).toBe('done')
  })

  it('lets the model finish normally after reaching the limit', async () => {
    const { run, chunks } = createLoopingService(true)
    await run()

    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(chunks.some((c) => c.type === 'text' && c.content === 'Final answer')).toBe(true)
    expect(chunks[chunks.length - 1].type).toBe('done')
  })
})

describe('LlmService tool call history', () => {
  it('keeps past tool results, ids and offsets when parsing stored calls', () => {
    const toolCalls = parseStoredToolCalls(JSON.stringify([
      { id: '1', name: 'web_search', arguments: { query: 'archipelago paint' }, result: { results: ['big payload'] }, contentOffset: 4 },
      { id: '2', name: 'read_file', arguments: { path: 'a.txt' } },
      { name: 42 }
    ]))

    expect(toolCalls).toEqual([
      { id: '1', name: 'web_search', arguments: { query: 'archipelago paint' }, result: { results: ['big payload'] }, contentOffset: 4 },
      { id: '2', name: 'read_file', arguments: { path: 'a.txt' } }
    ])
    expect(parseStoredToolCalls(undefined)).toBeUndefined()
    expect(parseStoredToolCalls('not json')).toBeUndefined()
  })

  it('rebuilds each round of an earlier reply with its full results', () => {
    const content = 'Searching. Reading the page. It is blue.'
    const messages = buildPastReplyMessages(content, [
      { id: 'tool_0', name: 'web_search', arguments: { query: 'sky' }, result: { results: ['sky.example'] }, contentOffset: 11 },
      { id: 'tool_0', name: 'fetch_url', arguments: { url: 'https://sky.example' }, result: { text: 'The sky is blue.' }, contentOffset: 29 },
      { id: 'tool_1', name: 'read_file', arguments: { path: 'notes.md' }, contentOffset: 29 }
    ])

    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'tool', 'assistant'])
    expect(messages[0]).toMatchObject({ content: 'Searching. ', tool_calls: [{ id: 'tool_0', function: { name: 'web_search' } }] })
    expect(messages[1]).toEqual({ role: 'tool', content: '{"results":["sky.example"]}', tool_call_id: 'tool_0' })

    // A repeated id is made unique, and each result still answers its own call.
    const secondRound = messages[2].tool_calls!
    expect(messages[2].content).toBe('Reading the page. ')
    expect(secondRound.map((tc) => tc.function.name)).toEqual(['fetch_url', 'read_file'])
    expect(secondRound[0].id).not.toBe('tool_0')
    expect(messages[3]).toMatchObject({ content: '{"text":"The sky is blue."}', tool_call_id: secondRound[0].id })
    expect(messages[4].tool_call_id).toBe('tool_1')
    expect(messages[4].content).toContain('did not finish')

    expect(messages[5]).toEqual({ role: 'assistant', content: 'It is blue.' })
  })

  it('puts calls stored without an offset before the reply text', () => {
    const messages = buildPastReplyMessages('Done.', [
      { id: 'a', name: 'list_files', arguments: {}, result: { files: [] } }
    ])

    expect(messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
      { role: 'tool', content: '{"files":[]}', tool_call_id: 'a' },
      { role: 'assistant', content: 'Done.' }
    ])
  })

  it('shortens only the oldest results, and only when a known context window would overflow', () => {
    const build = (): LLMMessage[] => [
      { role: 'system', content: 'system' },
      ...buildPastReplyMessages('Old answer.', [{ id: 'old', name: 'fetch_url', arguments: {}, result: 'x'.repeat(40_000) }]),
      ...buildPastReplyMessages('New answer.', [{ id: 'new', name: 'fetch_url', arguments: {}, result: 'y'.repeat(40_000) }])
    ]

    const unknownWindow = build()
    expect(fitToolResultsToContext(unknownWindow, [], null)).toBe(0)
    expect(unknownWindow.filter((m) => m.role === 'tool').every((m) => (m.content as string).length > 40_000)).toBe(true)

    const roomy = build()
    expect(fitToolResultsToContext(roomy, [], 200_000)).toBe(0)

    // ~20k tokens of results against a 16k window: the older one gives way.
    const tight = build()
    expect(fitToolResultsToContext(tight, [], 16_000)).toBe(1)
    const [oldResult, newResult] = tight.filter((m) => m.role === 'tool').map((m) => m.content as string)
    expect(oldResult).toContain('"shortened":true')
    expect(oldResult.length).toBeLessThan(3_000)
    expect(newResult.length).toBeGreaterThan(40_000)
  })

  it('replays earlier tool calls and results in the request', async () => {
    const seen: LLMMessage[][] = []
    class OneShotProvider extends BaseLLMProvider {
      sendStreaming(options: ProviderSendOptions) {
        seen.push(options.messages)
        queueMicrotask(() => options.onChunk({ type: 'done' }))
        return { abort: () => {} }
      }
      async listModels() { return [] }
    }
    registerProvider({ name: 'openai', displayName: 'One shot', defaultBaseUrl: '', factory: () => new OneShotProvider('', '') })

    const service = new LlmService({ getSettings: () => sanitizeSettings(undefined), getSystemPrompt: () => 'system' })
    await service.orchestrateStream(
      {
        conversationId: 'c1',
        model: 'test',
        provider: 'openai',
        messages: [
          { role: 'user', content: 'what is this file?', timestamp: 't1' },
          {
            role: 'assistant',
            content: 'It is a Paint options file.',
            timestamp: 't2',
            toolCalls: [{ id: 'call_1', name: 'web_search', arguments: { query: 'paint' }, result: { results: ['paint.example'] } }]
          },
          { role: 'user', content: 'what did the search find?', timestamp: 't3' }
        ]
      },
      'stream-2',
      { send: () => {} },
      async (tc) => tc
    )

    const [, firstUser, toolRound, toolResult, reply, secondUser] = seen[0]
    expect(firstUser.content).toContain('what is this file?')
    expect(toolRound).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'web_search' } }] })
    expect(toolResult).toEqual({ role: 'tool', content: '{"results":["paint.example"]}', tool_call_id: 'call_1' })
    expect(reply).toEqual({ role: 'assistant', content: 'It is a Paint options file.' })
    expect(secondUser.content).toBe('[system: msg_timestamp=t3]\n\nwhat did the search find?')
  })
})

describe('LlmService saved images', () => {
  it('sends stored images by their bytes and notes removed ones', async () => {
    const seen: LLMMessage[][] = []
    class OneShotProvider extends BaseLLMProvider {
      sendStreaming(options: ProviderSendOptions) {
        seen.push(options.messages)
        queueMicrotask(() => options.onChunk({ type: 'done' }))
        return { abort: () => {} }
      }
      async listModels() { return [] }
    }
    registerProvider({ name: 'openai', displayName: 'One shot', defaultBaseUrl: '', factory: () => new OneShotProvider('', '') })

    const blobId = 'a'.repeat(64)
    const service = new LlmService({
      getSettings: () => sanitizeSettings(undefined),
      getSystemPrompt: () => 'system',
      getAttachmentBlob: (id) => id === blobId ? { mimeType: 'image/png', data: Buffer.from([1, 2, 3]) } : null
    })
    await service.orchestrateStream(
      {
        conversationId: 'c1',
        model: 'test',
        provider: 'openai',
        messages: [{
          role: 'user',
          content: 'compare these',
          timestamp: 't1',
          attachments: [
            { kind: 'image', name: 'kept.png', mimeType: 'image/png', blobId },
            { kind: 'image', name: 'gone.png', mimeType: 'image/png', removed: true }
          ]
        }]
      },
      'stream-images',
      { send: () => {} },
      async (tc) => tc
    )

    const parts = seen[0][1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(parts.filter((part) => part.type === 'image_url')).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` } }
    ])
    expect(parts[0].text).toContain('**Attached image: kept.png**')
    expect(parts[0].text).toContain('**Attached image: gone.png**\n[Image no longer available')
  })
})

describe('detectFileType', () => {
  it('maps extensions, known filenames, and falls back sensibly', () => {
    expect(detectFileType('paint.yaml')).toBe('yaml')
    expect(detectFileType('options.YML')).toBe('yaml')
    expect(detectFileType('script.py')).toBe('python')
    expect(detectFileType('Dockerfile')).toBe('dockerfile')
    expect(detectFileType('.env.example')).toBe('dotenv')
    expect(detectFileType('notes.weird-ext')).toBe('weird-ext')
    expect(detectFileType('LICENSE')).toBe('text')
    expect(detectFileType('report.pdf')).toBe('pdf')
  })
})

describe('LlmService system prompt', () => {
  it('builds the system message from the conversation being answered', async () => {
    const seen: LLMMessage[][] = []

    class CapturingProvider extends BaseLLMProvider {
      sendStreaming(options: ProviderSendOptions) {
        seen.push([...options.messages])
        queueMicrotask(() => {
          options.onChunk({ type: 'text', content: 'ok' })
          options.onChunk({ type: 'done' })
        })
        return { abort: () => {} }
      }

      async listModels() {
        return []
      }
    }

    registerProvider({
      name: 'openai',
      displayName: 'Capturing',
      defaultBaseUrl: '',
      factory: () => new CapturingProvider('', '')
    })

    const prompts: Record<string, string> = { 'chat-a': 'Campaign A prompt', 'chat-b': 'Committee B prompt' }
    const service = new LlmService({
      getSettings: () => sanitizeSettings(undefined),
      getSystemPrompt: (conversationId) => prompts[conversationId]
    })

    for (const conversationId of ['chat-b', 'chat-a']) {
      await service.orchestrateStream(
        {
          conversationId,
          messages: [{ role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }],
          model: 'test',
          provider: 'openai'
        },
        `stream-${conversationId}`,
        { send: () => {} },
        async (tc) => tc
      )
    }

    expect(seen.map((messages) => messages[0])).toEqual([
      { role: 'system', content: 'Committee B prompt' },
      { role: 'system', content: 'Campaign A prompt' }
    ])
  })
})

describe('LlmService cancellation', () => {
  it('stops between rounds when cancelled while a tool runs', async () => {
    let rounds = 0
    class ToolCallingProvider extends BaseLLMProvider {
      sendStreaming(options: ProviderSendOptions) {
        rounds += 1
        queueMicrotask(() => {
          options.onChunk({ type: 'tool_call', toolCall: { id: `a-${rounds}`, name: 'noop', arguments: {} } })
          options.onChunk({ type: 'tool_call', toolCall: { id: `b-${rounds}`, name: 'noop', arguments: {} } })
          options.onChunk({ type: 'done' })
        })
        return { abort: () => {} }
      }
      async listModels() { return [] }
    }
    registerProvider({ name: 'openai', displayName: 'Tools', defaultBaseUrl: '', factory: () => new ToolCallingProvider('', '') })
    // Only registered tools reach the executor.
    registerTool({
      definition: { type: 'function', function: { name: 'noop', description: 'Does nothing', parameters: { type: 'object' } } },
      execute: async () => ({ ok: true })
    })

    const service = new LlmService({ getSettings: () => sanitizeSettings(undefined), getSystemPrompt: () => 'system' })
    const executed: string[] = []
    const chunks: StreamChunk[] = []
    await service.orchestrateStream(
      { conversationId: 'c1', model: 'test', provider: 'openai', messages: [{ role: 'user', content: 'go', timestamp: 't' }] },
      'stream-cancel',
      { send: (chunk) => chunks.push(chunk) },
      async (tc) => {
        executed.push(tc.id)
        service.cancelStream('stream-cancel')
        return { ...tc, result: { ok: true } }
      }
    )

    expect(rounds).toBe(1)
    expect(executed).toEqual(['a-1'])
    expect(chunks.some((c) => c.type === 'usage')).toBe(false)
    expect(chunks[chunks.length - 1].type).toBe('done')
  })

  it('ignores a cancel for a channel that is not streaming', () => {
    expect(() => createService().cancelStream('unknown')).not.toThrow()
  })
})

describe('LlmService context usage', () => {
  function createUsageService(reported: StreamChunk | null, contextLength: number | null) {
    class UsageProvider extends BaseLLMProvider {
      sendStreaming(options: ProviderSendOptions) {
        queueMicrotask(() => {
          options.onChunk({ type: 'text', content: 'Hello there' })
          if (reported) options.onChunk(reported)
          options.onChunk({ type: 'done' })
        })
        return { abort: () => {} }
      }
      async listModels() { return [] }
      override async getContextLength() { return contextLength }
    }
    registerProvider({ name: 'openai', displayName: 'Usage', defaultBaseUrl: '', factory: () => new UsageProvider('', '') })

    const service = new LlmService({ getSettings: () => sanitizeSettings(undefined), getSystemPrompt: () => 'system' })
    const chunks: StreamChunk[] = []
    const run = () => service.orchestrateStream(
      { conversationId: 'c1', model: 'test', provider: 'openai', messages: [{ role: 'user', content: 'hi', timestamp: 't' }] },
      'stream-usage',
      { send: (chunk) => chunks.push(chunk) },
      async (tc) => tc
    )
    return { run, chunks }
  }

  it('sends the reported usage once, with the context window, before done', async () => {
    const { run, chunks } = createUsageService(reportedUsageChunk(1200, 30), 8192)
    await run()

    const usageChunks = chunks.filter((c) => c.type === 'usage')
    expect(usageChunks).toHaveLength(1)
    expect(usageChunks[0].usage).toEqual({ promptTokens: 1200, completionTokens: 30, contextLength: 8192, estimated: false })
    expect(chunks[chunks.length - 2].type).toBe('usage')
    expect(chunks[chunks.length - 1].type).toBe('done')
  })

  it('estimates usage when the provider reports none', async () => {
    const { run, chunks } = createUsageService(null, null)
    await run()

    const usage = chunks.find((c) => c.type === 'usage')?.usage
    expect(usage?.estimated).toBe(true)
    expect(usage?.contextLength).toBeNull()
    expect(usage?.promptTokens).toBeGreaterThan(0)
    expect(usage?.completionTokens).toBe(Math.ceil('Hello there'.length / 4))
  })

  it('counts text, tool calls and images in an estimate', () => {
    const estimate = estimateUsage(
      [
        { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }, { type: 'image_url', image_url: { url: 'data:' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] }
      ],
      [],
      ''
    )
    // 400 text + "read{}" + "[]" tool definitions = 408 chars -> 102 tokens, plus one image.
    expect(estimate.promptTokens).toBe(102 + 1000)
    expect(estimate.completionTokens).toBe(0)
  })

  it('ignores missing or zero reported usage', () => {
    expect(reportedUsageChunk(undefined, 5)).toBeNull()
    expect(reportedUsageChunk(0, 5)).toBeNull()
    expect(reportedUsageChunk(10, undefined)?.usage?.completionTokens).toBe(0)
  })
})

describe('readContextLength', () => {
  it('reads the field each server uses and prefers the loaded window', () => {
    expect(readContextLength({ id: 'm', context_length: 128000 })).toBe(128000)
    expect(readContextLength({ id: 'm', max_model_len: 32768 })).toBe(32768)
    expect(readContextLength({ id: 'm', max_context_length: 131072, loaded_context_length: 8192 })).toBe(8192)
    expect(readContextLength({ key: 'm', max_context_length: 131072, loaded_instances: [{ config: { context_length: 4096 } }] })).toBe(4096)
    expect(readContextLength({ id: 'gpt-x' })).toBeNull()
    expect(readContextLength(undefined)).toBeNull()
  })
})
