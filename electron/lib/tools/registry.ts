import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from '../providers/base'
import type { ToolCall } from '../../../src/types'
import type { WorkspaceService } from '../../services/WorkspaceService'
import { parseMcpToolName } from '../../../src/lib/mcpConfig'

/**
 * Tool registry — maps tool names to definitions + executors.
 * Each tool file self-registers at import time.
 * Adding a new tool = one file + one registerTool() call.
 * MCP tools are registered and unregistered at runtime by McpService, and
 * custom tools (JSON files in the profile's tools folder) by CustomToolService.
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
  /**
   * Aborted when the user stops the reply. Tools pass it on to what they wait
   * for (dialogs, MCP calls), so a stopped reply does nothing more.
   */
  signal?: AbortSignal
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
  /**
   * Where the tool comes from: the app itself, a custom tool file, or an MCP
   * connection. Left out, a `<server>__<tool>` name counts as MCP and any
   * other as built-in.
   */
  source?: ToolSource
  /** Custom tools only: whether calls need the network (hidden in offline mode). */
  network?: boolean
}

export type ToolSource = 'builtin' | 'custom' | 'mcp'

const tools = new Map<string, ToolEntry>()

function sourceOf(name: string, entry: ToolEntry): ToolSource {
  return entry.source ?? (parseMcpToolName(name) ? 'mcp' : 'builtin')
}

/** A registered tool's source and whether it needs the network; null when not registered. */
export function getToolInfo(name: string): { source: ToolSource; network?: boolean } | null {
  const entry = tools.get(name)
  if (!entry) return null
  return { source: sourceOf(name, entry), ...(entry.network !== undefined ? { network: entry.network } : {}) }
}

export function registerTool(entry: ToolEntry): void {
  tools.set(entry.definition.function.name, entry)
}

export function unregisterTool(name: string): void {
  tools.delete(name)
}

/**
 * Every tool's definition, in an order that only changes when the set of
 * tools does: built-in tools as registered, then custom tools by name, then
 * MCP tools by name. Tools go first in every request, so a reconnecting MCP
 * server (or a reloaded tool file) re-registering its tools must not
 * reshuffle them, which would make the provider's prompt cache miss from the
 * very start.
 */
export function getToolDefinitions(): ToolDefinition[] {
  const bySource: Record<ToolSource, ToolDefinition[]> = { builtin: [], custom: [], mcp: [] }
  for (const [name, entry] of tools) {
    bySource[sourceOf(name, entry)].push(entry.definition)
  }
  const byName = (a: ToolDefinition, b: ToolDefinition) =>
    (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0)
  return [...bySource.builtin, ...bySource.custom.sort(byName), ...bySource.mcp.sort(byName)]
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
