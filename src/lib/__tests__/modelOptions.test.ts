import { describe, expect, it } from 'vitest'
import { parseContextWindow, withModelOptions } from '../modelOptions'

describe('model settings', () => {
  it('reads a typed context window only when it is a whole number in range', () => {
    expect(parseContextWindow(' 16384 ')).toBe(16384)
    expect(parseContextWindow('16k')).toBeNull()
    expect(parseContextWindow('100')).toBeNull()
    expect(parseContextWindow('1.5')).toBeNull()
    expect(parseContextWindow('')).toBeNull()
  })

  it('keeps only choices that differ from the defaults', () => {
    const one = withModelOptions(undefined, 'qwen3', { contextWindow: 8192 })
    expect(one).toEqual({ qwen3: { contextWindow: 8192 } })

    const two = withModelOptions(one, 'qwen3', { tools: 'off' })
    expect(two).toEqual({ qwen3: { contextWindow: 8192, tools: 'off' } })

    // Back to the defaults: the model, then the whole map, drop out.
    expect(withModelOptions(two, 'qwen3', { contextWindow: undefined, tools: 'auto' })).toBeUndefined()
    expect(withModelOptions({ ...two, other: { tools: 'on' } }, 'qwen3', { contextWindow: undefined, tools: 'auto' })).toEqual({ other: { tools: 'on' } })
  })
})
