import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'stream'
import axios from 'axios'
import { OllamaProvider } from '../ollama'
import { TRUNCATED_REPLY_NOTICE } from '../base'
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
    expect(chunks).toContainEqual({ type: 'notice', content: "gemma:2b doesn't support tools, so it replied without them." })
    expect(chunks).toContainEqual({ type: 'text', content: 'Hi' })
  })
})
