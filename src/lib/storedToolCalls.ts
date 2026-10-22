import type { ToolCall } from '../types'

/**
 * Parse a message's stored tool calls (JSON) for the next LLM request.
 * Results are kept: later turns are sent the same tool output the reply was
 * written from, so the model can rely on it instead of guessing.
 */
export function parseStoredToolCalls(toolCallsJson: string | undefined): ToolCall[] | undefined {
  if (!toolCallsJson) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(toolCallsJson)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined

  const toolCalls = (parsed as ToolCall[])
    .filter((tc) => tc && typeof tc.name === 'string')
    .map((tc) => ({
      id: typeof tc.id === 'string' ? tc.id : '',
      name: tc.name,
      arguments: tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {},
      ...(tc.result !== undefined ? { result: tc.result } : {}),
      ...(typeof tc.contentOffset === 'number' ? { contentOffset: tc.contentOffset } : {})
    }))

  return toolCalls.length > 0 ? toolCalls : undefined
}
