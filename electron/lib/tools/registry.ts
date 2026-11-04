import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from '../providers/base'
import type { ToolCall } from '../../../src/types'
import type { WorkspaceService } from '../../services/WorkspaceService'
import { parseMcpToolName } from '../../../src/lib/mcpConfig'

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
  /**
   * The text the model reads for a successful result, when JSON isn't the
   * clearest form (e.g. a page as Markdown). The structured result is still
   * what the chat stores and the tool card shows.
   */
  formatForModel?: (result: unknown) => string
}

const tools = new Map<string, ToolEntry>()

export function registerTool(entry: ToolEntry): void {
  tools.set(entry.definition.function.name, entry)
}

export function unregisterTool(name: string): void {
  tools.delete(name)
}

/**
 * Every tool's definition, in an order that only changes when the set of
 * tools does: built-in tools as registered, then MCP tools by name. Tools go
 * first in every request, so a reconnecting MCP server re-registering its
 * tools must not reshuffle them, which would make the provider's prompt
 * cache miss from the very start.
 */
export function getToolDefinitions(): ToolDefinition[] {
  const builtIn: ToolDefinition[] = []
  const mcp: ToolDefinition[] = []
  for (const [name, entry] of tools) {
    (parseMcpToolName(name) ? mcp : builtIn).push(entry.definition)
  }
  mcp.sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0))
  return [...builtIn, ...mcp]
}

function isErrorResult(result: unknown): boolean {
  return !!result && typeof result === 'object' && 'error' in result
}

/**
 * A tool result as the model reads it: the tool's own text form when it has
 * one, otherwise JSON. Errors are always JSON, so every tool reports them alike.
 */
export function formatToolResultForModel(name: string, result: unknown): string {
  const format = tools.get(name)?.formatForModel
  if (format && result !== undefined && !isErrorResult(result)) {
    try {
      return format(result)
    } catch {
      // Unexpected shape (e.g. saved by an older version): fall back to JSON.
    }
  }
  return JSON.stringify(result) ?? 'null'
}

export async function dispatchTool(
  toolCall: ToolCall,
  context: ToolContext
): Promise<unknown> {
  const entry = tools.get(toolCall.name)
  if (!entry) throw new Error(`Unknown tool: ${toolCall.name}`)
  return entry.execute(toolCall.arguments, context)
}
