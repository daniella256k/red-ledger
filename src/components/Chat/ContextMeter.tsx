import {
  CONTEXT_WARNING_RATIO,
  contextRatio,
  contextTokensUsed,
  formatTokenCount
} from '@/lib/contextUsage'
import type { ContextUsage } from '@/types'

/** "12.4k of 128k tokens used (10%)", or without the limit when the model's window is unknown. */
function buildTooltip(usage: ContextUsage, ratio: number | null): string {
  const used = `${usage.estimated ? '~' : ''}${formatTokenCount(contextTokensUsed(usage))}`
  const fill = usage.contextLength && ratio !== null
    ? `${used} of ${formatTokenCount(usage.contextLength)} tokens used (${Math.round(ratio * 100)}%)`
    : `${used} tokens used (context limit unknown)`
  return usage.estimated ? `${fill}\nEstimated` : fill
}

/**
 * A bare bar under the message box: how full the model's context window was
 * at the end of this chat's last reply. The numbers are in its tooltip.
 */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const ratio = contextRatio(usage)
  const isNearLimit = ratio !== null && ratio >= CONTEXT_WARNING_RATIO
  const tooltip = buildTooltip(usage, ratio)

  return (
    <div className="shrink-0 py-1.5 cursor-default" title={tooltip} aria-label={tooltip} role="img">
      <div className="h-1 w-16 rounded-full bg-weathered/60 overflow-hidden">
        {ratio !== null && (
          <div
            className={`h-full rounded-full ${isNearLimit ? 'bg-rca-red/70' : 'bg-soft-charcoal/30'}`}
            style={{ width: `${Math.max(ratio * 100, 2)}%` }}
          />
        )}
      </div>
    </div>
  )
}
