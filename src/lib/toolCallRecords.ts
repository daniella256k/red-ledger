import type { ToolCall, ToolCallRecord } from '@/types'

/**
 * Convert a message's stored tool calls (JSON, results included) into slim
 * records for the next LLM request. Results are dropped: they can be huge
 * (fetched pages, file contents) and the model only needs to know what it did.
 */
export function toToolCallRecords(toolCallsJson: string | undefined): ToolCallRecord[] | undefined {
  if (!toolCallsJson) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(toolCallsJson)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined

  return (parsed as ToolCall[])
    .filter((tc) => tc && typeof tc.name === 'string')
    .map((tc) => {
      const arguments_ = tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {}
      if (tc.result === undefined) {
        return { name: tc.name, arguments: arguments_, status: 'incomplete' as const }
      }

      const result = tc.result as { error?: unknown } | null
      if (result && typeof result === 'object' && 'error' in result) {
        return {
          name: tc.name,
          arguments: arguments_,
          status: 'error' as const,
          error: typeof result.error === 'string' ? result.error : 'Tool failed'
        }
      }

      return { name: tc.name, arguments: arguments_, status: 'ok' as const }
    })
}
