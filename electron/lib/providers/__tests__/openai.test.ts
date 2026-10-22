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
