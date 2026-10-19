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
})
