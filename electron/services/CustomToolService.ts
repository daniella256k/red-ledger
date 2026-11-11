import { mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import type { ToolEntry } from '../lib/tools/registry'
import type { ApiRequestOptions, ApiResponse } from './SearchService'
import {
  buildCustomToolUrl,
  customToolParameters,
  formatCustomToolResult,
  parseToolsetJson,
  toolsetNeedsNetwork,
  type CustomTool,
  type CustomToolResult,
  type CustomToolset
} from '../../src/lib/customTools'
import { expandMcpVariables } from '../../src/lib/mcpConfig'
import type { CustomToolsStatus, CustomToolsetStatus } from '../../src/types'

/** Results larger than this are clipped so one call can't flood the context. */
export const MAX_CUSTOM_TOOL_RESULT_CHARS = 100_000
/** Descriptions sent to the settings panel are clipped; the model still gets the full text. */
const MAX_STATUS_DESCRIPTION_CHARS = 300
/** Editors save in several steps; wait for the folder to settle before reading it again. */
const WATCH_DEBOUNCE_MS = 300

export interface CustomToolServiceDeps {
  /** The tools folder; created when missing. */
  folder: string
  registerTool: (entry: ToolEntry) => void
  unregisterTool: (name: string) => void
  /** Sends a tool's GET (SearchService.requestApi in the app). */
  request: (url: string, options: ApiRequestOptions) => Promise<ApiResponse>
  /** Tool name prefixes already taken by MCP connections. */
  getReservedPrefixes?: () => string[]
  onStatusChange?: (status: CustomToolsStatus) => void
  /** Override for tests; defaults to this process's environment. */
  env?: Record<string, string | undefined>
}

function clipDescription(text: string): string {
  return text.length <= MAX_STATUS_DESCRIPTION_CHARS ? text : `${text.slice(0, MAX_STATUS_DESCRIPTION_CHARS)}...`
}

/** The response as a tool result, clipped to what a model can take in one go. */
export function toCustomToolResult(response: ApiResponse): CustomToolResult {
  const truncated = response.text.length > MAX_CUSTOM_TOOL_RESULT_CHARS
  return {
    url: response.url,
    status: response.status,
    content_type: response.contentType,
    content: truncated ? response.text.slice(0, MAX_CUSTOM_TOOL_RESULT_CHARS) : response.text,
    total_chars: response.text.length,
    truncated
  }
}

/**
 * Domain service for custom tools: reads every .json file in the tools
 * folder, registers each file's tools in the shared tool registry as
 * `<toolset>__<tool>`, and does so again when a file changes. A file that
 * can't be used is reported in the status, and the other files still load.
 * No Electron imports: the registry and the request function are injected.
 */
export class CustomToolService {
  private deps: CustomToolServiceDeps
  private registered = new Set<string>()
  private toolsets: CustomToolsetStatus[] = []
  private reservedKey = ''
  private watcher: FSWatcher | null = null
  private watchTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: CustomToolServiceDeps) {
    this.deps = deps
  }

  get folder(): string {
    return this.deps.folder
  }

  getStatus(): CustomToolsStatus {
    return { folder: this.deps.folder, toolsets: this.toolsets }
  }

  /** Create the tools folder when it isn't there yet. */
  ensureFolder(): void {
    mkdirSync(this.deps.folder, { recursive: true })
  }

  /** Read the folder and bring the registered tools in line with it. */
  reload(): CustomToolsStatus {
    for (const name of this.registered) this.deps.unregisterTool(name)
    this.registered.clear()

    const reserved = this.deps.getReservedPrefixes?.() ?? []
    this.reservedKey = JSON.stringify(reserved)
    const taken = new Map<string, string>(reserved.map((prefix) => [prefix, 'a connection in Settings']))
    const statuses: CustomToolsetStatus[] = []

    for (const file of this.listFiles()) {
      const fallbackName = file.replace(/\.json$/i, '')
      try {
        // Windows editors may save with a byte order mark, which JSON.parse rejects.
        const raw = readFileSync(join(this.deps.folder, file), 'utf8')
        const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
        const toolset = parseToolsetJson(text, { fallbackName, expand: (value) => this.expand(value) })
        const owner = taken.get(toolset.prefix)
        if (owner) {
          throw new Error(`Its tool names would start with "${toolset.prefix}__", which ${owner} already uses. Give it another name.`)
        }
        taken.set(toolset.prefix, `"${file}"`)
        for (const tool of toolset.tools) this.register(toolset, tool)
        statuses.push({
          file,
          name: toolset.name,
          prefix: toolset.prefix,
          baseUrl: toolset.baseUrl,
          ...(toolset.allowLocal ? { allowLocal: true } : {}),
          tools: toolset.tools.map((tool) => ({ name: tool.name, description: clipDescription(tool.description) }))
        })
      } catch (err) {
        statuses.push({ file, name: fallbackName, tools: [], error: err instanceof Error ? err.message : String(err) })
      }
    }

    this.toolsets = statuses
    const status = this.getStatus()
    this.deps.onStatusChange?.(status)
    return status
  }

  /**
   * Reload when the MCP connections' prefixes changed, so a tool file and a
   * connection never end up sharing tool names. Cheap to call on every
   * settings save.
   */
  syncReservedPrefixes(): void {
    const key = JSON.stringify(this.deps.getReservedPrefixes?.() ?? [])
    if (key !== this.reservedKey) this.reload()
  }

  /** Reload whenever a file in the folder is added, changed or removed. */
  startWatching(): void {
    if (this.watcher) return
    try {
      this.ensureFolder()
      this.watcher = watch(this.deps.folder, () => {
        if (this.watchTimer) clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null
          this.reload()
        }, WATCH_DEBOUNCE_MS)
      })
      this.watcher.on('error', () => this.stopWatching())
    } catch {
      // No watching on this system; the Reload button still works.
    }
  }

  stopWatching(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    this.watcher?.close()
    this.watcher = null
  }

  private listFiles(): string[] {
    try {
      this.ensureFolder()
      return readdirSync(this.deps.folder, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  }

  private expand(text: string): string {
    return expandMcpVariables(text, {
      workspaceFolder: null,
      userHome: homedir(),
      pathSeparator: sep,
      env: this.deps.env ?? process.env
    })
  }

  private register(toolset: CustomToolset, tool: CustomTool): void {
    const allowLocalHost = toolset.allowLocal ? new URL(toolset.baseUrl).hostname : undefined
    this.registered.add(tool.qualifiedName)
    this.deps.registerTool({
      definition: {
        type: 'function',
        function: {
          name: tool.qualifiedName,
          description: tool.description,
          parameters: customToolParameters(tool)
        }
      },
      source: 'custom',
      network: toolsetNeedsNetwork(toolset),
      execute: async (args, { signal }) => {
        const url = buildCustomToolUrl(toolset, tool, args)
        const response = await this.deps.request(url, {
          headers: toolset.headers,
          ...(allowLocalHost ? { allowLocalHost } : {}),
          ...(signal ? { signal } : {})
        })
        return toCustomToolResult(response)
      },
      formatForModel: formatCustomToolResult
    })
  }
}
