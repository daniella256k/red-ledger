import type { McpServerConfig, McpTransport } from '../types'

/**
 * Shared helpers for MCP connections, used by both the main process
 * (tool naming, settings sanitization) and the renderer (forms, Paste JSON,
 * tool call cards). Pure functions only.
 */

/** MCP tools are exposed to the model as `<server>__<tool>`. */
export const MCP_TOOL_SEPARATOR = '__'
/** OpenAI-compatible APIs reject function names longer than this. */
export const MAX_TOOL_NAME_LENGTH = 64
const MAX_SERVER_PREFIX_LENGTH = 24

/**
 * Server part of an MCP tool name: lowercase letters, digits, `_` and `-`.
 * Never contains the `__` separator, so the first `__` in a tool name always
 * marks where the server ends.
 */
export function mcpServerPrefix(serverName: string): string {
  const slug = serverName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_SERVER_PREFIX_LENGTH)
    .replace(/[-_]+$/g, '')
  return slug || 'mcp'
}

/**
 * Tool name prefixes for enabled servers, keyed by server id. Servers whose
 * names slugify the same get a numeric suffix (`files`, `files-2`), in list order.
 * The main process registers tools under these, so anything mapping a tool
 * name back to its server must use this too, not mcpServerPrefix alone.
 */
export function assignMcpServerPrefixes(servers: McpServerConfig[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  for (const server of servers) {
    if (!server.enabled) continue
    const base = mcpServerPrefix(server.name)
    let prefix = base
    for (let n = 2; used.has(prefix); n++) prefix = `${base}-${n}`
    used.add(prefix)
    out.set(server.id, prefix)
  }
  return out
}

/**
 * The server whose tools are registered under `prefix`. Falls back to a plain
 * name match so tool calls in older chats still find a now-disabled server.
 */
export function findMcpServerByPrefix(servers: McpServerConfig[], prefix: string): McpServerConfig | undefined {
  for (const [id, assigned] of assignMcpServerPrefixes(servers)) {
    if (assigned === prefix) return servers.find((server) => server.id === id)
  }
  return servers.find((server) => mcpServerPrefix(server.name) === prefix)
}

/** Model-facing name for a server's tool, clipped to the API's name limit. */
export function buildMcpToolName(prefix: string, toolName: string): string {
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'tool'
  return `${prefix}${MCP_TOOL_SEPARATOR}${safeTool}`.slice(0, MAX_TOOL_NAME_LENGTH)
}

/** Split a model-facing tool name back into server prefix + tool, or null for built-in tools. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const index = name.indexOf(MCP_TOOL_SEPARATOR)
  if (index <= 0) return null
  const tool = name.slice(index + MCP_TOOL_SEPARATOR.length)
  if (!tool) return null
  return { server: name.slice(0, index), tool }
}

// ─── Command lines ──────────────────────────────────────────────────────────

/**
 * Split a command line typed by the user into words. Handles single and
 * double quotes so paths with spaces work; backslashes are kept literally
 * because they are path separators on Windows.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let inWord = false

  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      inWord = true
      continue
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(current)
      current = ''
      inWord = false
      continue
    }
    current += char
    inWord = true
  }
  if (inWord) words.push(current)
  return words
}

/** Inverse of splitCommandLine, quoting words that contain spaces. */
export function joinCommandLine(command: string | undefined, args: string[] | undefined): string {
  return [command ?? '', ...(args ?? [])]
    .filter((word, index) => index > 0 || word.length > 0)
    .map((word) => (/[\s"]/.test(word) || word.length === 0
      ? (word.includes('"') ? `'${word}'` : `"${word}"`)
      : word))
    .join(' ')
}

// ─── Key/value lines (env vars, headers) ────────────────────────────────────

/** Parse `KEY=value` (env) or `Name: value` (headers) lines; blank lines and `#` comments are skipped. */
export function parseKeyValueLines(text: string, separator: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf(separator)
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (!key) continue
    out[key] = line.slice(index + 1).trim()
  }
  return out
}

export function formatKeyValueLines(values: Record<string, string> | undefined, separator: '=' | ':'): string {
  if (!values) return ''
  const joiner = separator === ':' ? ': ' : '='
  return Object.entries(values).map(([key, value]) => `${key}${joiner}${value}`).join('\n')
}

// ─── Field sanitizers (shared with SettingsService) ─────────────────────────

export function sanitizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const trimmedKey = key.trim()
    if (!trimmedKey) continue
    if (typeof entry === 'string') out[trimmedKey] = entry
    else if (typeof entry === 'number' || typeof entry === 'boolean') out[trimmedKey] = String(entry)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((entry) => typeof entry === 'string' || typeof entry === 'number')
    .map((entry) => String(entry))
  return out.length > 0 ? out : undefined
}

/** Map the transport names used by common MCP config files onto ours. */
export function normalizeMcpTransport(value: unknown, hasUrl: boolean): McpTransport {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase().replace(/[\s_-]/g, '')
    if (normalized === 'stdio') return 'stdio'
    if (['http', 'streamablehttp', 'sse', 'remote'].includes(normalized)) return 'http'
  }
  return hasUrl ? 'http' : 'stdio'
}

// ─── Paste JSON ─────────────────────────────────────────────────────────────

export interface ParsedMcpServers {
  servers: Omit<McpServerConfig, 'id'>[]
  errors: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function looksLikeServerEntry(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && (typeof value.command === 'string' || typeof value.url === 'string')
}

/**
 * Parse pasted MCP config JSON. Accepts the common Claude Desktop / Cursor
 * shape `{ "mcpServers": { "<name>": { command, args, env } | { url, headers } } }`,
 * VS Code's `{ "servers": { ... } }`, the bare inner map, or one server object
 * (which needs a "name" field or gets a name from its command/url).
 */
export function parseMcpServersJson(text: string, options: { allowEmpty?: boolean } = {}): ParsedMcpServers {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { servers: [], errors: [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }

  if (!isPlainObject(parsed)) {
    return { servers: [], errors: ['Expected a JSON object like { "mcpServers": { ... } }.'] }
  }

  let entries: [string, unknown][]
  if (isPlainObject(parsed.mcpServers)) {
    entries = Object.entries(parsed.mcpServers)
  } else if (isPlainObject(parsed.servers)) {
    entries = Object.entries(parsed.servers)
  } else if (looksLikeServerEntry(parsed)) {
    const fallbackName = typeof parsed.name === 'string' && parsed.name.trim()
      ? parsed.name
      : (typeof parsed.command === 'string' ? parsed.command : 'server')
    entries = [[fallbackName, parsed]]
  } else {
    entries = Object.entries(parsed)
  }

  const servers: Omit<McpServerConfig, 'id'>[] = []
  const errors: string[] = []

  for (const [rawName, entry] of entries) {
    const name = rawName.trim()
    if (!looksLikeServerEntry(entry)) {
      errors.push(`"${name || '(unnamed)'}" needs a "command" or a "url".`)
      continue
    }

    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    const transport = normalizeMcpTransport(entry.type ?? entry.transport, url.length > 0)

    if (transport === 'http') {
      if (!url) {
        errors.push(`"${name}" is a remote server but has no "url".`)
        continue
      }
      servers.push({
        name: name || url,
        transport,
        url,
        headers: sanitizeStringRecord(entry.headers),
        enabled: entry.disabled !== true && entry.enabled !== false
      })
      continue
    }

    const commandText = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (!commandText) {
      errors.push(`"${name}" has no "command".`)
      continue
    }
    // Some configs put the whole command line in "command" with no "args".
    const explicitArgs = sanitizeStringArray(entry.args)
    const [command, ...inlineArgs] = explicitArgs ? [commandText] : splitCommandLine(commandText)
    const args = explicitArgs ?? (inlineArgs.length > 0 ? inlineArgs : undefined)

    servers.push({
      name: name || command,
      transport,
      command,
      args,
      env: sanitizeStringRecord(entry.env),
      enabled: entry.disabled !== true && entry.enabled !== false
    })
  }

  if (servers.length === 0 && errors.length === 0 && !options.allowEmpty) {
    errors.push('No servers found in the pasted JSON.')
  }

  return { servers, errors }
}

// ─── JSON view ──────────────────────────────────────────────────────────────

/** Stands in for env and header values in the JSON view until the user reveals them. */
export const MCP_SECRET_MASK = '••••••••'

/**
 * Key each server gets in the JSON view. Names that collide (ignoring case,
 * the way Paste JSON matches) get " (2)", " (3)", so no server is lost.
 */
export function mcpServerJsonKeys(servers: McpServerConfig[]): string[] {
  const used = new Set<string>()
  return servers.map((server) => {
    let key = server.name
    for (let n = 2; used.has(key.toLowerCase()); n++) key = `${server.name} (${n})`
    used.add(key.toLowerCase())
    return key
  })
}

function maskValues(values: Record<string, string> | undefined, mask: boolean): Record<string, string> | undefined {
  if (!values || Object.keys(values).length === 0) return undefined
  if (!mask) return values
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ? MCP_SECRET_MASK : value]))
}

/**
 * The servers as `{ "mcpServers": { ... } }`, the shape Paste JSON and other
 * MCP clients read. With maskSecrets, env and header values are hidden.
 */
export function serializeMcpServersJson(servers: McpServerConfig[], options: { maskSecrets: boolean }): string {
  const keys = mcpServerJsonKeys(servers)
  const mcpServers: Record<string, Record<string, unknown>> = {}

  servers.forEach((server, index) => {
    const entry: Record<string, unknown> = server.transport === 'http'
      ? { type: 'http', url: server.url, headers: maskValues(server.headers, options.maskSecrets) }
      : {
        command: server.command,
        args: server.args?.length ? server.args : undefined,
        env: maskValues(server.env, options.maskSecrets)
      }
    if (!server.enabled) entry.disabled = true
    mcpServers[keys[index]] = entry
  })

  return JSON.stringify({ mcpServers }, null, 2)
}

export interface RestoredMcpServers {
  servers: Omit<McpServerConfig, 'id'>[]
  /** `"server": KEY` for masked values with no saved value behind them. */
  unresolved: string[]
}

function restoreRecord(
  values: Record<string, string> | undefined,
  saved: Record<string, string> | undefined,
  serverName: string,
  unresolved: string[]
): Record<string, string> | undefined {
  if (!values) return values
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== MCP_SECRET_MASK) {
      out[key] = value
      continue
    }
    const savedValue = saved?.[key]
      ?? Object.entries(saved ?? {}).find(([savedKey]) => savedKey.toLowerCase() === key.toLowerCase())?.[1]
    if (savedValue === undefined) unresolved.push(`"${serverName}": ${key}`)
    else out[key] = savedValue
  }
  return out
}

/**
 * Swap masks left in an edited JSON view back to the saved values, matching
 * servers by their JSON key and values by env/header name.
 */
export function restoreMaskedSecrets(
  parsed: Omit<McpServerConfig, 'id'>[],
  existing: McpServerConfig[]
): RestoredMcpServers {
  const keys = mcpServerJsonKeys(existing)
  const byKey = new Map(existing.map((server, index) => [keys[index].toLowerCase(), server]))
  const unresolved: string[] = []

  const servers = parsed.map((server) => {
    const saved = byKey.get(server.name.toLowerCase())
    return {
      ...server,
      ...(server.env ? { env: restoreRecord(server.env, saved?.env, server.name, unresolved) } : {}),
      ...(server.headers ? { headers: restoreRecord(server.headers, saved?.headers, server.name, unresolved) } : {})
    }
  })

  return { servers, unresolved }
}
