import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'stream'
import axios from 'axios'
import { OpenAIProvider, ReasoningCollector } from '../openai'
import { OpenRouterProvider } from '../openrouter'
import type { ProviderChunk, ProviderSendOptions } from '../base'

function sse(...events: unknown[]) {
  return { data: Readable.from([events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n']) }
}

async function stream(provider: OpenAIProvider, events: unknown[], options: Partial<ProviderSendOptions> = {}) {
  const post = vi.spyOn(axios, 'post').mockResolvedValue(sse(...events))
  const chunks: ProviderChunk[] = []

  await new Promise<void>((resolve) => {
    provider.sendStreaming({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'model',
      tools: [],
      ...options,
      onChunk: (chunk) => {
        chunks.push(chunk)
        if (chunk.type === 'done') resolve()
      }
    })
  })

  return { chunks, body: post.mock.calls[0][1] as Record<string, unknown> }
}

const STOP = { choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenAI-compatible request body', () => {
  it('leaves temperature to the model unless it is set', async () => {
    const unset = await stream(new OpenAIProvider('key', 'https://api.example/v1'), [STOP])
    expect(unset.body).not.toHaveProperty('temperature')

    vi.restoreAllMocks()
    const set = await stream(new OpenAIProvider('key', 'https://api.example/v1'), [STOP], { temperature: 0.3 })
    expect(set.body.temperature).toBe(0.3)
  })

  it('uses max_completion_tokens for OpenAI and max_tokens for compatible servers', async () => {
    const openai = await stream(
      new OpenAIProvider('key', 'https://api.openai.com/v1', { maxTokensField: 'max_completion_tokens' }),
      [STOP],
      { maxTokens: 500 }
    )
    expect(openai.body.max_completion_tokens).toBe(500)
    expect(openai.body).not.toHaveProperty('max_tokens')

    vi.restoreAllMocks()
    const openrouter = await stream(new OpenRouterProvider('key'), [STOP], { maxTokens: 500 })
    expect(openrouter.body.max_tokens).toBe(500)
    expect(openrouter.body).not.toHaveProperty('max_completion_tokens')
  })
})

describe('SSE parsing', () => {
  it('reads data lines written without a space after the colon', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: Readable.from([`data:${JSON.stringify(STOP)}\n\ndata:[DONE]\n\n`])
    })
    const chunks: ProviderChunk[] = []

    await new Promise<void>((resolve) => {
      new OpenAIProvider('key', 'https://api.example/v1').sendStreaming({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'model',
        tools: [],
        onChunk: (chunk) => {
          chunks.push(chunk)
          if (chunk.type === 'done') resolve()
        }
      })
    })

    expect(chunks).toContainEqual({ type: 'text', content: 'Hi' })
  })

  it('keeps characters whole when their bytes are split across network chunks', async () => {
    const event = { choices: [{ delta: { content: 'Café — \u{1F600}' }, finish_reason: 'stop' }] }
    const bytes = Buffer.from(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, 'utf-8')
    // Split inside each multi-byte character (é is 2 bytes, the dash 3, the emoji 4).
    const bounds = [0, bytes.indexOf(0xc3) + 1, bytes.indexOf(0xe2) + 1, bytes.indexOf(0xf0) + 2, bytes.length]
    const pieces = bounds.slice(1).map((end, i) => bytes.subarray(bounds[i], end))
    vi.spyOn(axios, 'post').mockResolvedValue({ data: Readable.from(pieces) })
    const chunks: ProviderChunk[] = []

    await new Promise<void>((resolve) => {
      new OpenAIProvider('key', 'https://api.example/v1').sendStreaming({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'model',
        tools: [],
        onChunk: (chunk) => {
          chunks.push(chunk)
          if (chunk.type === 'done') resolve()
        }
      })
    })

    expect(chunks).toContainEqual({ type: 'text', content: 'Café — \u{1F600}' })
  })

  it('gives tool calls sent without an id a different id every round', async () => {
    const idless = {
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"path":"a.md"}' } }] },
        finish_reason: 'tool_calls'
      }]
    }
    const ids: string[] = []
    for (let round = 0; round < 2; round++) {
      vi.restoreAllMocks()
      const { chunks } = await stream(new OpenAIProvider('key', 'https://api.example/v1'), [idless])
      for (const chunk of chunks) if (chunk.type === 'tool_call' && chunk.toolCall) ids.push(chunk.toolCall.id)
    }

    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids.every((id) => id.startsWith('call_'))).toBe(true)
  })
})

describe('reasoning echo', () => {
  it('joins streamed reasoning blocks and hands them over before the reply ends', async () => {
    const { chunks } = await stream(new OpenRouterProvider('key'), [
      { choices: [{ delta: { reasoning: 'Read ', reasoning_details: [{ type: 'reasoning.text', text: 'Read ', index: 0, format: 'f1' }] } }] },
      { choices: [{ delta: { reasoning: 'notes.', reasoning_details: [{ type: 'reasoning.text', text: 'notes.', index: 0, signature: 'sig' }] } }] },
      STOP
    ])

    const echoAt = chunks.findIndex((chunk) => chunk.type === 'reasoning_echo')
    expect(chunks[echoAt]).toEqual({
      type: 'reasoning_echo',
      reasoning: { reasoning_details: [{ type: 'reasoning.text', text: 'Read notes.', index: 0, format: 'f1', signature: 'sig' }] }
    })
    expect(echoAt).toBeLessThan(chunks.findIndex((chunk) => chunk.type === 'done'))
  })

  it('sends nothing for replies without reasoning', async () => {
    const { chunks } = await stream(new OpenAIProvider('key', 'https://api.example/v1'), [STOP])
    expect(chunks.some((chunk) => chunk.type === 'reasoning_echo')).toBe(false)
  })

  it('keeps the plain field a server used when there are no structured blocks', () => {
    const kimi = new ReasoningCollector()
    kimi.add({ reasoning_content: 'Think ' })
    kimi.add({ reasoning_content: 'first.' })
    expect(kimi.echo()).toEqual({ reasoning_content: 'Think first.' })

    const vllm = new ReasoningCollector()
    vllm.add({ reasoning: 'Plan.' })
    expect(vllm.echo()).toEqual({ reasoning: 'Plan.' })

    expect(new ReasoningCollector().echo()).toBeNull()
  })
})

describe('prompt caching', () => {
  const USAGE = (usage: Record<string, unknown>) => ({ choices: [], usage })

  it('sends OpenAI a prompt_cache_key for chat requests only', async () => {
    const openai = () => new OpenAIProvider('key', 'https://api.openai.com/v1', { promptCacheKey: true })
    const chat = await stream(openai(), [STOP], { cacheKey: 'chat-1' })
    expect(chat.body.prompt_cache_key).toBe('chat-1')

    vi.restoreAllMocks()
    const title = await stream(openai(), [STOP])
    expect(title.body).not.toHaveProperty('prompt_cache_key')

    vi.restoreAllMocks()
    const compatible = await stream(new OpenAIProvider('', 'http://localhost:8080/v1'), [STOP], { cacheKey: 'chat-1' })
    expect(compatible.body).not.toHaveProperty('prompt_cache_key')
  })

  it('routes OpenRouter chats by session, and asks Anthropic models to cache', async () => {
    const claude = await stream(new OpenRouterProvider('key'), [STOP], { model: 'anthropic/claude-sonnet-5.5', cacheKey: 'chat-1' })
    expect(claude.body.session_id).toBe('chat-1')
    expect(claude.body.cache_control).toEqual({ type: 'ephemeral' })

    vi.restoreAllMocks()
    const gpt = await stream(new OpenRouterProvider('key'), [STOP], { model: 'openai/gpt-5.5', cacheKey: 'chat-1' })
    expect(gpt.body.session_id).toBe('chat-1')
    expect(gpt.body).not.toHaveProperty('cache_control')

    vi.restoreAllMocks()
    const title = await stream(new OpenRouterProvider('key'), [STOP], { model: 'anthropic/claude-sonnet-5.5' })
    expect(title.body).not.toHaveProperty('session_id')
    expect(title.body).not.toHaveProperty('cache_control')
  })

  it('retries without the caching fields when a server rejects them', async () => {
    const rejected = Object.assign(new axios.AxiosError('Request failed with status code 400'), {
      response: { status: 400, data: Readable.from([JSON.stringify({ error: { message: 'Unknown field cache_control' } })]) }
    })
    const post = vi.spyOn(axios, 'post').mockRejectedValueOnce(rejected).mockResolvedValueOnce(sse(STOP))
    const chunks: ProviderChunk[] = []

    await new Promise<void>((resolve) => {
      new OpenRouterProvider('key').sendStreaming({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'anthropic/claude-sonnet-5.5',
        tools: [],
        cacheKey: 'chat-1',
        onChunk: (chunk) => {
          chunks.push(chunk)
          if (chunk.type === 'done') resolve()
        }
      })
    })

    const retryBody = post.mock.calls[1][1] as Record<string, unknown>
    expect(retryBody).not.toHaveProperty('cache_control')
    expect(retryBody).not.toHaveProperty('session_id')
    expect(chunks).toContainEqual({ type: 'text', content: 'Hi' })
  })

  it('reads cache reads and writes from the usage report', async () => {
    const reported = await stream(new OpenRouterProvider('key'), [STOP, USAGE({
      prompt_tokens: 5000,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 4200, cache_write_tokens: 700 }
    })])
    expect(reported.chunks).toContainEqual({
      type: 'usage',
      usage: { promptTokens: 5000, completionTokens: 20, contextLength: null, estimated: false, cachedTokens: 4200, cacheWriteTokens: 700 }
    })

    vi.restoreAllMocks()
    const deepseek = await stream(new OpenAIProvider('key', 'https://api.deepseek.com/v1'), [STOP, USAGE({
      prompt_tokens: 900, completion_tokens: 5, prompt_cache_hit_tokens: 640
    })])
    expect(deepseek.chunks).toContainEqual(expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ cachedTokens: 640 }) }))

    vi.restoreAllMocks()
    const silent = await stream(new OpenAIProvider('key', 'http://localhost:8080/v1'), [STOP, USAGE({ prompt_tokens: 900, completion_tokens: 5 })])
    const usage = silent.chunks.find((c) => c.type === 'usage')
    expect(usage && 'usage' in usage ? usage.usage : null).not.toHaveProperty('cachedTokens')
  })
})
