import { useState } from 'react'
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import type { ToolCall } from '@/types'
import { cn } from '@/lib/utils'

interface ToolCallCardProps {
  toolCall: ToolCall
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const hasError = toolCall.result &&
    typeof toolCall.result === 'object' &&
    toolCall.result !== null &&
    'error' in toolCall.result

  return (
    <div className="tool-card">
      <div
        className={cn(
          'tool-card-header',
          hasError ? 'error' : toolCall.result ? 'success' : ''
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <Wrench size={14} />
          <span className="font-mono text-xs">{toolCall.name}</span>
        </div>
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>

      {isExpanded && (
        <div className="p-3 space-y-2 text-xs">
          {/* Arguments */}
          <div>
            <div className="font-medium text-soft-charcoal/60 mb-1">Arguments</div>
            <pre className="bg-base-200 rounded p-2 overflow-x-auto font-mono">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {toolCall.result !== undefined && (
            <div>
              <div className="font-medium text-soft-charcoal/60 mb-1">Result</div>
              <pre className={cn(
                'rounded p-2 overflow-x-auto font-mono',
                hasError ? 'bg-error/5 text-error' : 'bg-success/5 text-success'
              )}>
                {typeof toolCall.result === 'string'
                  ? toolCall.result
                  : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
