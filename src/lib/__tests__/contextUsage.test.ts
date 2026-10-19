import { describe, expect, it } from 'vitest'
import { contextRatio, describeContextUsage, formatTokenCount } from '../contextUsage'
import type { ContextUsage } from '../../types'

function usage(overrides: Partial<ContextUsage> = {}): ContextUsage {
  return { promptTokens: 12_000, completionTokens: 400, contextLength: 128_000, estimated: false, ...overrides }
}

describe('context usage formatting', () => {
  it('formats token counts compactly', () => {
    expect(formatTokenCount(950)).toBe('950')
    expect(formatTokenCount(12_400)).toBe('12.4k')
    expect(formatTokenCount(8_000)).toBe('8k')
    expect(formatTokenCount(128_000)).toBe('128k')
    expect(formatTokenCount(1_048_576)).toBe('1.05M')
  })

  it('describes usage with and without a known window', () => {
    expect(describeContextUsage(usage())).toBe('12.4k / 128k tokens')
    expect(describeContextUsage(usage({ contextLength: null, estimated: true }))).toBe('~12.4k tokens')
  })

  it('caps the ratio and returns null for an unknown window', () => {
    expect(contextRatio(usage())).toBeCloseTo(12_400 / 128_000)
    expect(contextRatio(usage({ contextLength: 8_000 }))).toBe(1)
    expect(contextRatio(usage({ contextLength: null }))).toBeNull()
  })
})
