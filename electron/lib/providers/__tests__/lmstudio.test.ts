import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'stream'
import axios from 'axios'
import { LMStudioProvider } from '../lmstudio'
import type { ProviderChunk } from '../base'

const provider = () => new LMStudioProvider({ apiKey: '', baseUrl: 'http://lms:1234', models: [] })

/** LM Studio's REST listing (GET /api/v1/models) with one model. */
function listing(model: Record<string, unknown>) {
  return { data: { models: [{ type: 'llm', key: 'qwen/qwen3-4b', variants: ['qwen/qwen3-4b@q4_k_m'], ...model }] } }
}

const sse = () => ({ data: Readable.from(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n']) })

function send(contextWindow?: number): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = []
  return new Promise((resolve) => {
    provider().sendStreaming({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'qwen/qwen3-4b',
      tools: [],
      ...(contextWindow ? { contextWindow } : {}),
      onChunk: (chunk) => {
        chunks.push(chunk)
        if (chunk.type === 'done' || chunk.type === 'error') resolve(chunks)
      }
    })
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LMStudioProvider model info', () => {
  it('reads vision, tool training and the loaded window from the REST listing', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue(listing({
      max_context_length: 262_144,
      loaded_instances: [{ id: 'qwen/qwen3-4b', config: { context_length: 8192 } }],
      capabilities: { vision: true, trained_for_tool_use: false }
    }))
    expect(await provider().getModelInfo('qwen/qwen3-4b')).toEqual({ contextLength: 8192, capabilities: { vision: true, tools: false } })
  })

  it('reports no window for a model that isn\'t loaded, rather than its trained maximum', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue(listing({ max_context_length: 262_144, loaded_instances: [], capabilities: { vision: false, trained_for_tool_use: true } }))
    expect(await provider().getModelInfo('qwen/qwen3-4b@q4_k_m')).toEqual({ contextLength: null, capabilities: { vision: false, tools: true } })
  })
})

describe('LMStudioProvider context window', () => {
  it('loads a model that isn\'t loaded with the set window before the request', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue(listing({ loaded_instances: [] }))
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url) => (String(url).endsWith('/models/load') ? { data: { status: 'loaded' } } : sse()))

    const chunks = await send(16_384)
    expect(get.mock.calls[0][0]).toBe('http://lms:1234/api/v1/models')
    expect(post.mock.calls.map((call) => call[0])).toEqual(['http://lms:1234/api/v1/models/load', 'http://lms:1234/v1/chat/completions'])
    expect(post.mock.calls[0][1]).toEqual({ model: 'qwen/qwen3-4b', context_length: 16_384 })
    expect(chunks).toContainEqual({ type: 'text', content: 'Hi' })
  })

  it('leaves a model that is already loaded as it is, and loads nothing without a set window', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue(listing({ loaded_instances: [{ id: 'qwen/qwen3-4b', config: { context_length: 4096 } }] }))
    const post = vi.spyOn(axios, 'post').mockResolvedValue(sse())

    await send(16_384)
    await send()
    expect(post.mock.calls.map((call) => call[0])).toEqual(['http://lms:1234/v1/chat/completions', 'http://lms:1234/v1/chat/completions'])
  })

  it('goes ahead on servers without the REST API, and says why a load failed', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('404'))
    const post = vi.spyOn(axios, 'post').mockResolvedValue(sse())
    await send(16_384)
    expect(post.mock.calls.map((call) => call[0])).toEqual(['http://lms:1234/v1/chat/completions'])

    vi.restoreAllMocks()
    vi.spyOn(axios, 'get').mockResolvedValue(listing({ loaded_instances: [] }))
    vi.spyOn(axios, 'post').mockRejectedValue(Object.assign(new axios.AxiosError('Request failed'), {
      response: { status: 500, data: { error: { message: 'Not enough memory' } } }
    }))
    const chunks = await send(65_536)
    expect(chunks.at(-1)).toEqual({
      type: 'error',
      error: "LM Studio couldn't load qwen/qwen3-4b with a 65536 token context window: Not enough memory"
    })
  })
})
