import { describe, expect, it } from 'vitest'
import { LlmService, MAX_TOOL_CALLS, buildToolCallBudgetNotice, buildToolCallLogTag } from '../LlmService'
import { toToolCallRecords } from '../../../src/lib/toolCallRecords'
import { sanitizeSettings } from '../SettingsService'
import { BaseLLMProvider } from '../../lib/providers/base'
import type { LLMMessage, ProviderSendOptions } from '../../lib/providers/base'
import { registerProvider } from '../../lib/providers/registry'
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
  it('records past tool calls without results', () => {
    const records = toToolCallRecords(JSON.stringify([
      { id: '1', name: 'web_search', arguments: { query: 'archipelago paint' }, result: { results: ['big payload'] } },
      { id: '2', name: 'fetch_url', arguments: { url: 'https://example.com' }, result: { error: 'Timed out', code: 'NETWORK_ERROR' } },
      { id: '3', name: 'read_file', arguments: { path: 'a.txt' } }
    ]))

    expect(records).toEqual([
      { name: 'web_search', arguments: { query: 'archipelago paint' }, status: 'ok' },
      { name: 'fetch_url', arguments: { url: 'https://example.com' }, status: 'error', error: 'Timed out' },
      { name: 'read_file', arguments: { path: 'a.txt' }, status: 'incomplete' }
    ])
    expect(toToolCallRecords(undefined)).toBeUndefined()
    expect(toToolCallRecords('not json')).toBeUndefined()
  })

  it('formats a compact, clipped log', () => {
    expect(buildToolCallLogTag(undefined)).toBeNull()
    expect(buildToolCallLogTag([])).toBeNull()

    const tag = buildToolCallLogTag([
      { name: 'web_search', arguments: { query: 'paint' }, status: 'ok' },
      { name: 'fetch_url', arguments: { url: 'x'.repeat(500) }, status: 'error', error: 'Timed out' }
    ])!
    expect(tag).toContain('previous_reply_tool_calls count=2')
    expect(tag).toContain('1. web_search {"query":"paint"} -> ok')
    expect(tag).toContain('2. fetch_url')
    expect(tag).toContain('-> error: Timed out')
    expect(tag).not.toContain('x'.repeat(300))
  })

  it('puts the log on the user message that follows the reply', async () => {
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
            toolCalls: [{ name: 'web_search', arguments: { query: 'paint' }, status: 'ok' }]
          },
          { role: 'user', content: 'how many tool calls did you make?', timestamp: 't3' }
        ]
      },
      'stream-2',
      { send: () => {} },
      async (tc) => tc
    )

    const [, firstUser, assistant, secondUser] = seen[0]
    expect(firstUser.content).not.toContain('previous_reply_tool_calls')
    expect(assistant.content).toBe('It is a Paint options file.')
    expect(secondUser.content).toContain('[system: msg_timestamp=t3]')
    expect(secondUser.content).toContain('1. web_search {"query":"paint"} -> ok')
    expect(secondUser.content).toMatch(/how many tool calls did you make\?$/)
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
