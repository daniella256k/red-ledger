import {
  CONTEXT_WARNING_RATIO,
  contextRatio,
  describeContextUsage,
  formatTokenCount
} from '@/lib/contextUsage'
import type { ContextUsage } from '@/types'

function buildTooltip(usage: ContextUsage, ratio: number | null): string {
  const lines = [
    `Context used by the last reply: ${describeContextUsage(usage)}${ratio === null ? '' : ` (${Math.round(ratio * 100)}%)`}`,
    `Sent ${formatTokenCount(usage.promptTokens)} · generated ${formatTokenCount(usage.completionTokens)}`
  ]
  if (usage.estimated) lines.push('Estimated from text length: this provider did not report token usage.')
  if (usage.contextLength === null) lines.push('The model\'s context window is unknown for this provider.')
  return lines.join('\n')
}

/**
 * Compact readout under the message box: how full the model's context window
 * was at the end of this chat's last reply.
 */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const ratio = contextRatio(usage)
  const isNearLimit = ratio !== null && ratio >= CONTEXT_WARNING_RATIO

  return (
    <div
      className={`flex items-center gap-1.5 shrink-0 tabular-nums cursor-default ${isNearLimit ? 'text-rca-red/80' : ''}`}
      title={buildTooltip(usage, ratio)}
    >
      {ratio !== null && (
        <div className="h-1 w-14 rounded-full bg-weathered/60 overflow-hidden">
          <div
            className={`h-full rounded-full ${isNearLimit ? 'bg-rca-red/70' : 'bg-soft-charcoal/30'}`}
            style={{ width: `${Math.max(ratio * 100, 2)}%` }}
          />
        </div>
      )}
      <span>{describeContextUsage(usage)}</span>
    </div>
  )
}
