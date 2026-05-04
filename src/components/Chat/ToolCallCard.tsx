import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight, Wrench, ListChecks, Layers } from 'lucide-react'
import type { ToolCall } from '@/types'
import { cn } from '@/lib/utils'

const PLAN_TOOL_NAME = 'plan'

interface ToolCallCardProps {
  toolCall: ToolCall
}

function isToolCallError(toolCall: ToolCall): boolean {
  return Boolean(
    toolCall.result &&
      typeof toolCall.result === 'object' &&
      toolCall.result !== null &&
      'error' in toolCall.result
  )
}

function PlanCard({ toolCall }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const tasks = (() => {
    const raw = (toolCall.arguments as Record<string, unknown> | undefined)?.tasks
    if (Array.isArray(raw)) {
      return raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    }
    if (typeof raw === 'string' && raw.trim().length > 0) return [raw.trim()]
    return [] as string[]
  })()

  return (
    <div className="plan-card">
      <div
        className="plan-card-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <ListChecks size={14} />
          <span>Plan</span>
        </div>
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>

      <ul className="plan-card-list">
        {tasks.length === 0 ? (
          <li className="plan-card-task">
            <span className="text-soft-charcoal/45 italic">No tasks declared.</span>
          </li>
        ) : (
          tasks.map((task, i) => (
            <li key={i} className="plan-card-task">
              <span className="plan-card-task-bullet">&bull;</span>
              <span>{task}</span>
            </li>
          ))
        )}
      </ul>

      {isExpanded && (
        <div className="border-t border-weathered/60 p-3 space-y-2 text-xs">
          <div>
            <div className="font-medium text-soft-charcoal/60 mb-1">Arguments</div>
            <pre className="bg-base-200 rounded p-2 font-mono whitespace-pre-wrap break-all">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>
          {toolCall.result !== undefined && (
            <div>
              <div className="font-medium text-soft-charcoal/60 mb-1">Result</div>
              <pre className="rounded p-2 font-mono whitespace-pre-wrap break-all bg-success/5 text-success">
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

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  if (toolCall.name === PLAN_TOOL_NAME) {
    return <PlanCard toolCall={toolCall} />
  }

  const hasError = isToolCallError(toolCall)

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
            <pre className="bg-base-200 rounded p-2 font-mono whitespace-pre-wrap break-all">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {toolCall.result !== undefined && (
            <div>
              <div className="font-medium text-soft-charcoal/60 mb-1">Result</div>
              <pre className={cn(
                'rounded p-2 font-mono whitespace-pre-wrap break-all',
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

interface ToolGroupCardProps {
  toolCalls: ToolCall[]
}

/**
 * Collapses a run of 3+ consecutive resolved tool calls into a single
 * compact strip. Click the strip (or any chip) to expand all calls back into
 * full ToolCallCards. Clicking a specific chip also scrolls that card into view.
 */
export function ToolGroupCard({ toolCalls }: ToolGroupCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    if (!isExpanded || !focusId) return
    const el = cardRefs.current[focusId]
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    // Clear focus shortly after so the chip can be clicked again later
    const t = setTimeout(() => setFocusId(null), 600)
    return () => clearTimeout(t)
  }, [isExpanded, focusId])

  const handleChipClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setFocusId(id)
    if (!isExpanded) setIsExpanded(true)
  }

  return (
    <div className="tool-group-card">
      <div
        className="tool-group-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-1.5 shrink-0">
          <Layers size={14} />
          <span className="text-xs font-medium">Tools</span>
          <span className="text-xs text-soft-charcoal/55">({toolCalls.length})</span>
        </div>
        <div className="tool-group-chip-row">
          {toolCalls.map((tc) => {
            const isPending = tc.result === undefined
            const hasError = isToolCallError(tc)
            return (
              <button
                key={tc.id}
                type="button"
                className="tool-group-chip"
                onClick={(e) => handleChipClick(e, tc.id)}
                title={tc.name}
              >
                <span
                  className={cn(
                    'tool-group-chip-dot',
                    isPending
                      ? 'bg-soft-charcoal/30 animate-pulse'
                      : hasError
                        ? 'bg-error'
                        : 'bg-success'
                  )}
                />
                <span>{tc.name}</span>
              </button>
            )
          })}
        </div>
        <div className="shrink-0">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-weathered/60 p-2 space-y-2 bg-base-100">
          {toolCalls.map((tc) => (
            <div
              key={tc.id}
              ref={(el) => {
                cardRefs.current[tc.id] = el
              }}
              className={cn(
                'transition-shadow rounded-card w-fit max-w-full',
                focusId === tc.id ? 'ring-2 ring-rca-red/40' : ''
              )}
            >
              <ToolCallCard toolCall={tc} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
