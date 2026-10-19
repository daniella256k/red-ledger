import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from '../providers/base'
import type { ToolCall } from '../../../src/types'
import type { WorkspaceService } from '../../services/WorkspaceService'

/**
 * Tool registry — maps tool names to definitions + executors.
 * Each tool file self-registers at import time.
 * Adding a new tool = one file + one registerTool() call.
 * MCP tools are registered and unregistered at runtime by McpService.
 */

/** What a tool call runs against. */
export interface ToolContext {
  /** Window for confirmation dialogs; null when none is available. */
  win: BrowserWindow | null
  /**
   * Workspace pinned when the turn started, so a running chat keeps working in
   * its own folder after the user switches to a chat with another one.
   */
  workspace: WorkspaceService
}

export interface ToolEntry {
  definition: ToolDefinition
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
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
  context: ToolContext
): Promise<unknown> {
  const entry = tools.get(toolCall.name)
  if (!entry) throw new Error(`Unknown tool: ${toolCall.name}`)
  return entry.execute(toolCall.arguments, context)
}
