import type { ToolCall } from '@/types'
import { countToolStatuses } from '@/lib/toolDisplay'
import { ToolCallRow } from './ToolCallRow'

/**
 * A run of tool calls with no text between them. Collapsed to one line, like
 * the reasoning trace, with the call count and any failures; open, one plain
 * line per call. A lone call is just its line.
 */
export function ToolCallBurst({ toolCalls }: { toolCalls: ToolCall[] }) {
  if (toolCalls.length === 1) {
    return (
      <div className="tool-burst">
        <ToolCallRow toolCall={toolCalls[0]} />
      </div>
    )
  }

  const { total, ok, failed, running } = countToolStatuses(toolCalls)

  return (
    <details className="tool-burst">
      <summary className="tool-burst-summary">
        <span className="tool-burst-label">Tool calls</span>
        <span className="tool-burst-toggle">&#9654;</span>
        <span className="tool-burst-counts">
          {total} calls
          {failed > 0 && (
            <> | {ok} ok | <span className="text-error">{failed} failed</span></>
          )}
          {running > 0 && <> | {running} running</>}
        </span>
      </summary>
      <div className="tool-burst-rows">
        {toolCalls.map((toolCall, index) => (
          <ToolCallRow key={toolCall.id || `call-${index}`} toolCall={toolCall} />
        ))}
      </div>
    </details>
  )
}
