import type { ContextUsage } from '@/types'

/** Share of the context window at which the meter turns red. */
export const CONTEXT_WARNING_RATIO = 0.8

/** Compact token count: 950, 12.4k, 128k, 1.05M. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000
    return `${thousands < 100 ? Number(thousands.toFixed(1)) : Math.round(thousands)}k`
  }
  return `${Number((tokens / 1_000_000).toFixed(2))}M`
}

export function contextTokensUsed(usage: ContextUsage): number {
  return usage.promptTokens + usage.completionTokens
}

/** Used share of the context window (0–1, capped), or null when the window is unknown. */
export function contextRatio(usage: ContextUsage): number | null {
  if (!usage.contextLength || usage.contextLength <= 0) return null
  return Math.min(1, contextTokensUsed(usage) / usage.contextLength)
}

/** "~12.4k / 128k tokens", or "~12.4k tokens" when the window is unknown. */
export function describeContextUsage(usage: ContextUsage): string {
  const used = `${usage.estimated ? '~' : ''}${formatTokenCount(contextTokensUsed(usage))}`
  return usage.contextLength
    ? `${used} / ${formatTokenCount(usage.contextLength)} tokens`
    : `${used} tokens`
}
