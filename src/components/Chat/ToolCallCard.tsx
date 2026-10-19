import { useState } from 'react'
import { ChevronDown, ChevronRight, Plug, Wrench } from 'lucide-react'
import type { ToolCall } from '@/types'
import { cn } from '@/lib/utils'
import { findMcpServerByPrefix, parseMcpToolName } from '@/lib/mcpConfig'
import { useSettingsStore } from '@/store'

interface ToolCallCardProps {
  toolCall: ToolCall
}

/** Display name of the connection an MCP tool came from, falling back to its name prefix. */
function useMcpServerLabel(toolName: string): { server: string; tool: string } | null {
  const servers = useSettingsStore((s) => s.settings?.mcpServers)
  const parsed = parseMcpToolName(toolName)
  if (!parsed) return null
  const match = servers ? findMcpServerByPrefix(servers, parsed.server) : undefined
  return { server: match?.name ?? parsed.server, tool: parsed.tool }
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const mcp = useMcpServerLabel(toolCall.name)

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
        <div className="flex items-center gap-2 min-w-0">
          {mcp ? <Plug size={14} className="shrink-0" /> : <Wrench size={14} className="shrink-0" />}
          {mcp ? (
            <>
              <span
                className="shrink-0 max-w-[40%] truncate rounded-sm bg-base-100/70 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide opacity-80"
                title={`From the "${mcp.server}" connection`}
              >
                {mcp.server}
              </span>
              <span className="font-mono text-xs truncate" title={toolCall.name}>{mcp.tool}</span>
            </>
          ) : (
            <span className="font-mono text-xs">{toolCall.name}</span>
          )}
        </div>
        {isExpanded ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
      </div>

      {isExpanded && (
        <div className="p-3 space-y-2 text-xs">
          {/* Arguments */}
          <div>
            <div className="font-medium text-soft-charcoal/60 mb-1">Arguments</div>
            <pre className="bg-base-200 rounded-sm p-2 overflow-x-auto font-mono">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {toolCall.result !== undefined && (
            <div>
              <div className="font-medium text-soft-charcoal/60 mb-1">Result</div>
              <pre className={cn(
                'rounded-sm p-2 overflow-x-auto font-mono',
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
