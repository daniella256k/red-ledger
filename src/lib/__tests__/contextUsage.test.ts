import { describe, expect, it } from 'vitest'
import { autoCompactThreshold, contextRatio, describeCacheUsage, describeContextUsage, formatTokenCount, shouldAutoCompact } from '../contextUsage'
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

describe('prompt cache use', () => {
  it('says how much of the input came from the cache', () => {
    expect(describeCacheUsage({ requests: 5, promptTokens: 61_000, readTokens: 48_200, writeTokens: 3_000 }))
      .toBe('48.2k of 61k input tokens from cache (79%) across 5 requests')
    expect(describeCacheUsage({ requests: 1, promptTokens: 4_000, readTokens: 0, writeTokens: 3_900 }))
      .toBe('3.9k tokens cached for the next request')
    expect(describeCacheUsage({ requests: 1, promptTokens: 800, readTokens: 0, writeTokens: 0 }))
      .toBe('Nothing read from cache')
  })
})

describe('auto-compaction threshold', () => {
  it('is 80% of the window, or earlier so 32k tokens stay free', () => {
    expect(autoCompactThreshold(1_000_000)).toBe(800_000)
    expect(autoCompactThreshold(256_000)).toBe(204_800)
    expect(autoCompactThreshold(200_000)).toBe(160_000)
    // 128k: leaving 32k free comes before 80%.
    expect(autoCompactThreshold(128_000)).toBe(96_000)
  })

  it('keeps at most a quarter of a small window in reserve', () => {
    expect(autoCompactThreshold(32_000)).toBe(24_000)
    expect(autoCompactThreshold(8_192)).toBe(6_144)
  })

  it('always stays between 75% and 80% of the window, below the 85% tool result shortening', () => {
    for (const window of [4_096, 8_192, 32_768, 65_536, 128_000, 160_000, 200_000, 256_000, 400_000, 1_000_000, 2_000_000]) {
      const share = autoCompactThreshold(window) / window
      expect(share).toBeGreaterThanOrEqual(0.75)
      expect(share).toBeLessThanOrEqual(0.8)
    }
  })

  it('counts the reply too, and never fires for an unknown window', () => {
    const at = (promptTokens: number, completionTokens: number, contextLength: number | null) =>
      shouldAutoCompact({ promptTokens, completionTokens, contextLength, estimated: false })
    expect(at(95_000, 1_000, 128_000)).toBe(true)
    expect(at(94_000, 1_000, 128_000)).toBe(false)
    expect(at(10_000_000, 0, null)).toBe(false)
  })
})
