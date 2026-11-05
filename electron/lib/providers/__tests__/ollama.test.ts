import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'stream'
import axios from 'axios'
import { OllamaProvider, forgetModelsWithoutTools, toOllamaMessages } from '../ollama'
import { CONTEXT_FULL_NOTICE, TRUNCATED_REPLY_NOTICE, type ProviderChunk } from '../base'
import type { StreamChunk } from '../../../../src/types'

function ndjson(...lines: unknown[]) {
  return { data: Readable.from([lines.map((line) => JSON.stringify(line)).join('\n') + '\n']) }
}

async function stream(lines: unknown[], maxTokens?: number) {
  const post = vi.spyOn(axios, 'post').mockResolvedValue(ndjson(...lines))
  const chunks: StreamChunk[] = []

  await new Promise<void>((resolve) => {
    new OllamaProvider('', 'http://ollama').sendStreaming({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'llama',
      tools: [],
      maxTokens,
      onChunk: (chunk) => {
        if (chunk.type === 'reasoning_echo') return
        chunks.push(chunk)
        if (chunk.type === 'done') resolve()
      }
    })
  })

  return { chunks, body: post.mock.calls[0][1] as { options: Record<string, unknown> } }
}

afterEach(() => {
  vi.restoreAllMocks()
  forgetModelsWithoutTools()
})

describe('OllamaProvider', () => {
  it('leaves temperature to the model', async () => {
    const { body } = await stream([{ done: true }])
    expect(body.options).not.toHaveProperty('temperature')
  })

  it('keeps characters whole when their bytes are split across network chunks', async () => {
    const bytes = Buffer.from(
      `${JSON.stringify({ message: { content: 'Café \u{1F600}' } })}\n${JSON.stringify({ done: true })}\n`,
      'utf-8'
    )
    const emoji = bytes.indexOf(0xf0)
    const bounds = [0, bytes.indexOf(0xc3) + 1, emoji + 1, emoji + 3, bytes.length]
    const pieces = bounds.slice(1).map((end, i) => bytes.subarray(bounds[i], end))
    vi.spyOn(axios, 'post').mockResolvedValue({ data: Readable.from(pieces) })
    const chunks: StreamChunk[] = []

    await new Promise<void>((resolve) => {
      new OllamaProvider('', 'http://ollama').sendStreaming({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'llama',
        tools: [],
        onChunk: (chunk) => {
          if (chunk.type === 'reasoning_echo') return
          chunks.push(chunk)
          if (chunk.type === 'done') resolve()
        }
      })
    })

    expect(chunks).toContainEqual({ type: 'text', content: 'Café \u{1F600}' })
  })

  it('gives each tool call its own ID, even for the same tool', async () => {
    const { chunks } = await stream([
      {
        message: {
          tool_calls: [
            { function: { name: 'read_file', arguments: { path: 'a.md' } } },
            { function: { name: 'read_file', arguments: { path: 'b.md' } } }
          ]
        },
        done: false
      },
      { done: true }
    ])

    const ids = chunks.filter((c) => c.type === 'tool_call').map((c) => c.toolCall!.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => id.startsWith('call_'))).toBe(true)
  })

  it('sends Max Tokens as num_predict only when set', async () => {
    expect((await stream([{ done: true }], 512)).body.options.num_predict).toBe(512)
    vi.restoreAllMocks()
    expect((await stream([{ done: true }])).body.options).not.toHaveProperty('num_predict')
  })

  it('reports usage and warns when the reply hit the token limit', async () => {
    const { chunks } = await stream([
      { message: { content: 'Partial' }, done: false },
      { done: true, done_reason: 'length', prompt_eval_count: 900, eval_count: 512 }
    ], 512)

    expect(chunks.find((c) => c.type === 'usage')?.usage).toMatchObject({ promptTokens: 900, completionTokens: 512 })
    expect(chunks.find((c) => c.type === 'notice')?.content).toBe(TRUNCATED_REPLY_NOTICE)
    expect(chunks[chunks.length - 1].type).toBe('done')
  })

  it('says the context window is full when Max Tokens isn\'t what stopped the reply', async () => {
    // Seen live: a 4096 window, 4062 prompt tokens, stopped after 34.
    const unset = await stream([{ done: true, done_reason: 'length', prompt_eval_count: 4062, eval_count: 34 }])
    expect(unset.chunks.find((c) => c.type === 'notice')?.content).toBe(CONTEXT_FULL_NOTICE)

    vi.restoreAllMocks()
    const underLimit = await stream([{ done: true, done_reason: 'length', prompt_eval_count: 4062, eval_count: 34 }], 512)
    expect(underLimit.chunks.find((c) => c.type === 'notice')?.content).toBe(CONTEXT_FULL_NOTICE)
  })

  it('retries without tools when the model has no tool support', async () => {
    const rejected = Object.assign(new axios.AxiosError('Request failed with status code 400'), {
      response: { status: 400, data: Readable.from([JSON.stringify({ error: 'registry.ollama.ai/library/gemma:2b does not support tools' })]) }
    })
    const bodies: Record<string, unknown>[] = []
    let calls = 0
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      bodies.push(structuredClone(body as Record<string, unknown>))
      if (calls++ === 0) throw rejected
      return ndjson({ message: { content: 'Hi' }, done: false }, { done: true })
    })
    const chunks: StreamChunk[] = []

    await new Promise<void>((resolve) => {
      new OllamaProvider('', 'http://ollama').sendStreaming({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gemma:2b',
        tools: [{ type: 'function', function: { name: 'read_file', description: '', parameters: { type: 'object', properties: {} } } }],
        onChunk: (chunk) => {
          if (chunk.type === 'reasoning_echo') return
          chunks.push(chunk)
          if (chunk.type === 'done') resolve()
        }
      })
    })

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toHaveProperty('tools')
    expect(bodies[1]).not.toHaveProperty('tools')
    expect(chunks).toContainEqual({ type: 'notice', content: "gemma:2b doesn't support tools, so it replies without them." })
    expect(chunks).toContainEqual({ type: 'text', content: 'Hi' })

    // Remembered: the next request leaves tools out at once, with no second notice.
    const again: ProviderChunk[] = []
    await new Promise<void>((resolve) => {
      new OllamaProvider('', 'http://ollama').sendStreaming({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gemma:2b',
        tools: [{ type: 'function', function: { name: 'read_file', description: '', parameters: { type: 'object', properties: {} } } }],
        onChunk: (chunk) => {
          again.push(chunk)
          if (chunk.type === 'done') resolve()
        }
      })
    })
    expect(bodies).toHaveLength(3)
    expect(bodies[2]).not.toHaveProperty('tools')
    expect(again.some((c) => c.type === 'notice')).toBe(false)
  })

  it('sends the context window as num_ctx only when one is set', async () => {
    const unset = await stream([{ done: true }])
    expect(unset.body.options).not.toHaveProperty('num_ctx')

    vi.restoreAllMocks()
    const post = vi.spyOn(axios, 'post').mockResolvedValue(ndjson({ done: true }))
    await new Promise<void>((resolve) => {
      new OllamaProvider('', 'http://ollama').sendStreaming({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'llama',
        tools: [],
        contextWindow: 16_384,
        onChunk: (chunk) => { if (chunk.type === 'done') resolve() }
      })
    })
    expect((post.mock.calls[0][1] as { options: Record<string, unknown> }).options.num_ctx).toBe(16_384)
  })

  it('returns each round\'s thinking to be sent back, and stops collecting it when stopped', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue(ndjson(
      { message: { thinking: 'Let me ' }, done: false },
      { message: { thinking: 'check.' }, done: false },
      { message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }] }, done: false },
      { done: true }
    ))
    const chunks: ProviderChunk[] = []
    await new Promise<void>((resolve) => {
      new OllamaProvider('', 'http://ollama').sendStreaming({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'qwen3',
        tools: [],
        onChunk: (chunk) => {
          chunks.push(chunk)
          if (chunk.type === 'done') resolve()
        }
      })
    })
    const types = chunks.map((c) => c.type)
    expect(chunks).toContainEqual({ type: 'reasoning_echo', reasoning: { thinking: 'Let me check.' } })
    // Before 'done', as LlmService expects.
    expect(types.indexOf('reasoning_echo')).toBe(types.length - 2)
  })
})

describe('toOllamaMessages', () => {
  it('names each tool result\'s tool, sends thinking back, and moves images to Ollama\'s images list', () => {
    const messages = toOllamaMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image 1: cat.png' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAEC' } },
          { type: 'text', text: 'What is this?' }
        ]
      },
      {
        role: 'assistant',
        content: null,
        thinking: 'I should look.',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'list_files', arguments: '{}' } }
        ]
      },
      { role: 'tool', content: 'A', tool_call_id: 'c1' },
      { role: 'tool', content: 'B', tool_call_id: 'c2' },
      { role: 'assistant', content: 'A cat.' }
    ])

    expect(messages).toEqual([
      { role: 'user', content: 'Image 1: cat.png\n\nWhat is this?', images: ['AAEC'] },
      {
        role: 'assistant',
        content: '',
        thinking: 'I should look.',
        tool_calls: [
          { function: { name: 'read_file', arguments: { path: 'a' } } },
          { function: { name: 'list_files', arguments: {} } }
        ]
      },
      { role: 'tool', content: 'A', tool_name: 'read_file' },
      { role: 'tool', content: 'B', tool_name: 'list_files' },
      { role: 'assistant', content: 'A cat.' }
    ])
  })
})

describe('OllamaProvider model info', () => {
  it('reads capabilities from /api/show, and the window from the loaded model or the Modelfile', async () => {
    const show = (data: unknown) => vi.spyOn(axios, 'post').mockResolvedValue({ data })
    const ps = (models: unknown[]) => vi.spyOn(axios, 'get').mockResolvedValue({ data: { models } })
    const provider = new OllamaProvider('', 'http://ollama')

    show({ capabilities: ['completion', 'tools', 'thinking'], parameters: 'temperature 0.7\nnum_ctx 8192' })
    ps([])
    expect(await provider.getModelInfo('qwen3')).toEqual({ contextLength: 8192, capabilities: { tools: true, vision: false } })

    vi.restoreAllMocks()
    show({ capabilities: ['completion', 'vision'] })
    ps([{ name: 'gemma3', context_length: 4096 }])
    expect(await provider.getModelInfo('gemma3')).toEqual({ contextLength: 4096, capabilities: { tools: false, vision: true } })

    // An older server that lists no capabilities, with the model not loaded.
    vi.restoreAllMocks()
    show({ parameters: '' })
    ps([])
    expect(await provider.getModelInfo('old')).toEqual({ contextLength: null, capabilities: {} })
  })
})
