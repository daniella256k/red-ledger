import { buildMcpToolName, MAX_TOOL_NAME_LENGTH, MCP_TOOL_SEPARATOR, mcpServerPrefix } from './mcpConfig'

/**
 * Custom tools: JSON files in the profile's `tools` folder, one file per API
 * ("toolset"), each tool one GET endpoint. Shared by the main process (which
 * loads and runs them) and the renderer (tool cards). Pure functions only.
 *
 * A toolset file:
 *
 *   {
 *     "name": "My API",
 *     "baseUrl": "https://example.org/api/v1",
 *     "headers": { "Authorization": "Bearer ${env:MY_API_KEY}" },
 *     "allowLocal": false,
 *     "tools": [
 *       {
 *         "name": "search",
 *         "description": "Search the records.",
 *         "path": "/search",
 *         "params": { "q": { "type": "string", "description": "Search text", "required": true } },
 *         "fixed": { "format": "md" }
 *       }
 *     ]
 *   }
 *
 * A param named in the path as `{name}` fills it; every other param is sent
 * in the query string. `fixed` values are always sent and never shown to the
 * model. Tools reach the model as `<toolset>__<tool>`, like MCP tools.
 */

export type CustomToolParamType = 'string' | 'integer' | 'number' | 'boolean' | 'array'

const PARAM_TYPES = new Set<string>(['string', 'integer', 'number', 'boolean', 'array'])
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const PARAM_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/
const PATH_PLACEHOLDER_PATTERN = /\{([^{}]*)\}/g
const MAX_TOOLS_PER_TOOLSET = 100

export interface CustomToolParam {
  name: string
  type: CustomToolParamType
  /** Where the value goes: a `{name}` placeholder in the path, or the query string. */
  in: 'path' | 'query'
  required: boolean
  /** JSON Schema for this param, as the model sees it. */
  schema: Record<string, unknown>
}

export interface CustomTool {
  /** The tool's own name, as written in the file. */
  name: string
  /** Model-facing name: `<toolset>__<tool>`. */
  qualifiedName: string
  description: string
  path: string
  params: CustomToolParam[]
  /** Query values sent on every call. */
  fixed: Record<string, string>
}

export interface CustomToolset {
  name: string
  /** Tool name prefix, from the name: lowercase letters, digits, `_` and `-`. */
  prefix: string
  /** Without a trailing slash. */
  baseUrl: string
  headers: Record<string, string>
  /** The base URL's own host may be a local or private address. */
  allowLocal: boolean
  tools: CustomTool[]
}

/** A tool file that can't be used, with a message for the settings panel. */
export class CustomToolsetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustomToolsetError'
  }
}

/** A tool call whose arguments can't be turned into a request. */
export class CustomToolArgumentError extends Error {
  readonly code = 'INVALID_INPUT'

  constructor(message: string) {
    super(message)
    this.name = 'CustomToolArgumentError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function fail(message: string): never {
  throw new CustomToolsetError(message)
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${what} must be a non-empty string.`)
  return value.trim()
}

function parseParam(toolName: string, name: string, raw: unknown, inPath: boolean): CustomToolParam {
  const where = `Tool "${toolName}", param "${name}"`
  if (!PARAM_NAME_PATTERN.test(name)) fail(`${where}: names may use letters, digits, "_", "-" and "." only.`)
  if (!isPlainObject(raw)) fail(`${where} must be an object like { "type": "string" }.`)

  const type = raw.type === undefined ? 'string' : raw.type
  if (typeof type !== 'string' || !PARAM_TYPES.has(type)) {
    fail(`${where}: type must be one of string, integer, number, boolean, array.`)
  }
  if (raw.required !== undefined && typeof raw.required !== 'boolean') fail(`${where}: required must be true or false.`)
  if (inPath && type === 'array') fail(`${where}: a path param can't be an array.`)

  const { required, ...schema } = raw
  schema.type = type
  if (type === 'array' && !isPlainObject(schema.items)) schema.items = { type: 'string' }

  return {
    name,
    type: type as CustomToolParamType,
    in: inPath ? 'path' : 'query',
    required: inPath || required === true,
    schema
  }
}

function parseFixed(toolName: string, raw: unknown, paramNames: Set<string>): Record<string, string> {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) fail(`Tool "${toolName}": fixed must be an object of values.`)
  const fixed: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (paramNames.has(key)) fail(`Tool "${toolName}": "${key}" is both a param and a fixed value.`)
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      fail(`Tool "${toolName}": fixed value "${key}" must be a string, number or boolean.`)
    }
    fixed[key] = String(value)
  }
  return fixed
}

function parseTool(prefix: string, raw: unknown, index: number): CustomTool {
  if (!isPlainObject(raw)) fail(`Tool ${index + 1} must be an object.`)
  const name = requireString(raw.name, `Tool ${index + 1}: name`)
  if (!TOOL_NAME_PATTERN.test(name) || name.includes(MCP_TOOL_SEPARATOR)) {
    fail(`Tool "${name}": names may use letters, digits, "_" and "-" only, without "__".`)
  }
  const qualifiedName = `${prefix}${MCP_TOOL_SEPARATOR}${name}`
  if (qualifiedName.length > MAX_TOOL_NAME_LENGTH || qualifiedName !== buildMcpToolName(prefix, name)) {
    fail(`Tool "${name}": the full name "${qualifiedName}" is longer than ${MAX_TOOL_NAME_LENGTH} characters.`)
  }

  const description = requireString(raw.description, `Tool "${name}": description`)
  const path = raw.path === undefined ? '' : raw.path
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) {
    fail(`Tool "${name}": path must start with "/".`)
  }
  if (path.includes('?') || path.includes('#')) {
    fail(`Tool "${name}": path can't contain "?" or "#"; use params or fixed for query values.`)
  }

  const placeholders = new Set<string>()
  for (const match of path.matchAll(PATH_PLACEHOLDER_PATTERN)) placeholders.add(match[1])

  const rawParams = raw.params === undefined ? {} : raw.params
  if (!isPlainObject(rawParams)) fail(`Tool "${name}": params must be an object keyed by param name.`)
  const params = Object.entries(rawParams).map(([paramName, spec]) =>
    parseParam(name, paramName, spec, placeholders.has(paramName)))
  const paramNames = new Set(params.map((param) => param.name))
  for (const placeholder of placeholders) {
    if (!paramNames.has(placeholder)) fail(`Tool "${name}": the path uses {${placeholder}} but there is no such param.`)
  }

  return { name, qualifiedName, description, path, params, fixed: parseFixed(name, raw.fixed, paramNames) }
}

export interface ParseToolsetOptions {
  /** Used as the toolset's name when the file gives none (the file name without .json). */
  fallbackName: string
  /** Fills `${env:NAME}` references in the base URL and headers; throws when it can't. */
  expand?: (text: string) => string
}

/** Read one tool file. Throws CustomToolsetError saying what is wrong with it. */
export function parseToolsetJson(text: string, options: ParseToolsetOptions): CustomToolset {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    fail(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isPlainObject(parsed)) fail('Expected a JSON object with "baseUrl" and "tools".')

  const expand = (value: string): string => {
    try {
      return options.expand ? options.expand(value) : value
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }

  const name = parsed.name === undefined ? options.fallbackName : requireString(parsed.name, 'name')
  const prefix = mcpServerPrefix(name)

  const baseUrlText = expand(requireString(parsed.baseUrl, 'baseUrl')).replace(/\/+$/, '')
  let baseUrl: URL
  try {
    baseUrl = new URL(baseUrlText)
  } catch {
    fail(`baseUrl "${baseUrlText}" is not a valid URL.`)
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') fail('baseUrl must start with http:// or https://.')
  if (baseUrl.search || baseUrl.hash) fail('baseUrl can\'t contain "?" or "#".')

  const headers: Record<string, string> = {}
  if (parsed.headers !== undefined) {
    if (!isPlainObject(parsed.headers)) fail('headers must be an object of strings.')
    for (const [key, value] of Object.entries(parsed.headers)) {
      if (typeof value !== 'string') fail(`Header "${key}" must be a string.`)
      headers[key] = expand(value)
    }
  }

  if (parsed.allowLocal !== undefined && typeof parsed.allowLocal !== 'boolean') fail('allowLocal must be true or false.')

  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) fail('tools must be a list with at least one tool.')
  if (parsed.tools.length > MAX_TOOLS_PER_TOOLSET) fail(`A tool file can hold at most ${MAX_TOOLS_PER_TOOLSET} tools.`)
  const tools = parsed.tools.map((tool, index) => parseTool(prefix, tool, index))
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.name)) fail(`Two tools are named "${tool.name}".`)
    seen.add(tool.name)
  }

  return { name, prefix, baseUrl: baseUrlText, headers, allowLocal: parsed.allowLocal === true, tools }
}

/** The tool's parameters as the JSON Schema object the model is given. */
export function customToolParameters(tool: CustomTool): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
  return {
    type: 'object',
    properties: Object.fromEntries(tool.params.map((param) => [param.name, param.schema])),
    required: tool.params.filter((param) => param.required).map((param) => param.name)
  }
}

function scalarText(tool: CustomTool, param: CustomToolParam, value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new CustomToolArgumentError(`${tool.qualifiedName}: "${param.name}" must be a ${param.type === 'array' ? 'list of plain values' : param.type}.`)
}

/** One argument as text, or null when it was left out. Lists are sent comma-separated. */
function argumentText(tool: CustomTool, param: CustomToolParam, value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) {
    if (param.type !== 'array') {
      throw new CustomToolArgumentError(`${tool.qualifiedName}: "${param.name}" takes one value, not a list.`)
    }
    const items = value.map((item) => scalarText(tool, param, item)).filter((item) => item !== '')
    return items.length > 0 ? items.join(',') : null
  }
  const text = scalarText(tool, param, value)
  return text === '' ? null : text
}

/** The full request URL for a call. Throws CustomToolArgumentError for arguments that can't be sent. */
export function buildCustomToolUrl(toolset: CustomToolset, tool: CustomTool, args: unknown): string {
  const input = isPlainObject(args) ? args : {}
  const values = new Map<string, string>()
  for (const param of tool.params) {
    const text = argumentText(tool, param, input[param.name])
    if (text === null) {
      if (param.required) throw new CustomToolArgumentError(`${tool.qualifiedName} requires a "${param.name}" argument.`)
      continue
    }
    values.set(param.name, text)
  }

  const path = tool.path.replace(PATH_PLACEHOLDER_PATTERN, (_match, name: string) =>
    encodeURIComponent(values.get(name) ?? ''))
  const query = new URLSearchParams()
  for (const param of tool.params) {
    const value = values.get(param.name)
    if (param.in === 'query' && value !== undefined) query.append(param.name, value)
  }
  for (const [key, value] of Object.entries(tool.fixed)) query.append(key, value)

  const queryText = query.toString()
  return `${toolset.baseUrl}${path}${queryText ? `?${queryText}` : ''}`
}

/** Whether a host is this computer itself (reachable with no network). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

/** Whether calls to this toolset need the network, for offline mode. */
export function toolsetNeedsNetwork(toolset: CustomToolset): boolean {
  try {
    return !(toolset.allowLocal && isLoopbackHost(new URL(toolset.baseUrl).hostname))
  } catch {
    return true
  }
}

// ─── Results ────────────────────────────────────────────────────────────────

/** What a custom tool call returns: the response body as text. */
export interface CustomToolResult {
  url: string
  status: number
  content_type: string
  content: string
  total_chars: number
  truncated: boolean
}

/** Whether a tool result has the shape custom tools return (MCP results have no content_type). */
export function isCustomToolResult(result: unknown): result is CustomToolResult {
  if (!isPlainObject(result)) return false
  return typeof result.content === 'string' && typeof result.content_type === 'string' && typeof result.url === 'string'
}

/** A custom tool result as the model reads it: the body, plus a note when it was cut short. */
export function formatCustomToolResult(result: unknown): string {
  if (!isCustomToolResult(result)) throw new Error('Not a custom tool result')
  const body = result.content || '(empty response)'
  if (!result.truncated) return body
  return `${body}\n\n[Cut off after ${result.content.length} of ${result.total_chars} characters. Ask for fewer results or a narrower query to see the rest.]`
}
