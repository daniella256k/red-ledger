import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from '../providers/base'
import type { ToolCall } from '../../../src/types'

/**
 * Tool registry — maps tool names to definitions + executors.
 * Each tool file self-registers at import time.
 * Adding a new tool = one file + one registerTool() call.
 * MCP tools are registered and unregistered at runtime by McpService.
 */

export interface ToolEntry {
  definition: ToolDefinition
  execute: (args: Record<string, unknown>, win: BrowserWindow | null) => Promise<unknown>
}

const tools = new Map<string, ToolEntry>()

export function registerTool(entry: ToolEntry): void {
  tools.set(entry.definition.function.name, entry)
}

export function unregisterTool(name: string): void {
  tools.delete(name)
}

export function getToolDefinitions(): ToolDefinition[] {
  return [...tools.values()].map((e) => e.definition)
}

export async function dispatchTool(
  toolCall: ToolCall,
  win: BrowserWindow | null
): Promise<unknown> {
  const entry = tools.get(toolCall.name)
  if (!entry) throw new Error(`Unknown tool: ${toolCall.name}`)
  return entry.execute(toolCall.arguments, win)
}
