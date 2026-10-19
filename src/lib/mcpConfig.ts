import type { McpOAuthConfig, McpServerConfig, McpTransport } from '../types'

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

// ─── Variables ──────────────────────────────────────────────────────────────

/** What `${...}` references in a server config can see. */
export interface McpVariableContext {
  workspaceFolder: string | null
  userHome: string
  pathSeparator: string
  env: Record<string, string | undefined>
}

export class McpVariableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpVariableError'
  }
}

/** Shown in help text; kept next to the code that implements them. */
export const MCP_VARIABLES_HELP = '${workspaceFolder} (the open workspace), ${userHome}, ${env:NAME} or ${NAME} (an environment variable); add :-fallback for a default, e.g. ${env:PORT:-8080}.'

const VARIABLE_PATTERN = /\$\{([^}]*)\}/g
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function lastPathPart(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? path
}

/**
 * Expand `${...}` references, using the names VS Code and Claude Code configs
 * use: `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`,
 * `${pathSeparator}` (or `${/}`), `${env:NAME}` and bare `${NAME}`. Any of them
 * takes `:-fallback`. Throws McpVariableError for anything that can't be filled.
 */
export function expandMcpVariables(text: string, context: McpVariableContext): string {
  return text.replace(VARIABLE_PATTERN, (match, body: string) => {
    const defaultIndex = body.indexOf(':-')
    const name = (defaultIndex >= 0 ? body.slice(0, defaultIndex) : body).trim()
    const fallback = defaultIndex >= 0 ? body.slice(defaultIndex + 2) : undefined

    switch (name) {
      case 'workspaceFolder':
      case 'workspaceFolderBasename':
        if (context.workspaceFolder) {
          return name === 'workspaceFolder' ? context.workspaceFolder : lastPathPart(context.workspaceFolder)
        }
        if (fallback !== undefined) return fallback
        throw new McpVariableError(`This connection uses ${match}, but no workspace folder is open.`)
      case 'userHome':
        return context.userHome
      case 'pathSeparator':
      case '/':
        return context.pathSeparator
    }

    const envName = name.startsWith('env:') ? name.slice(4).trim() : name
    if (!ENV_NAME_PATTERN.test(envName)) {
      throw new McpVariableError(`Unknown variable ${match}.`)
    }
    const value = context.env[envName]
    // Like the shell's :-, the fallback also covers a variable set to "".
    if (fallback !== undefined && !value) return fallback
    if (value !== undefined) return value
    throw new McpVariableError(`Environment variable ${envName} is not set (used as ${match}).`)
  })
}

function expandRecord(
  values: Record<string, string> | undefined,
  context: McpVariableContext
): Record<string, string> | undefined {
  if (!values) return undefined
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandMcpVariables(value, context)]))
}

/** The config with every `${...}` reference filled in, ready to launch or connect. */
export function resolveMcpServerConfig(config: McpServerConfig, context: McpVariableContext): McpServerConfig {
  const expand = (value: string | undefined) => (value === undefined ? undefined : expandMcpVariables(value, context))
  const resolved: McpServerConfig = {
    ...config,
    command: expand(config.command),
    args: config.args?.map((arg) => expandMcpVariables(arg, context)),
    env: expandRecord(config.env, context),
    cwd: expand(config.cwd),
    url: expand(config.url),
    headers: expandRecord(config.headers, context)
  }
  if (config.oauth) {
    resolved.oauth = {
      ...config.oauth,
      clientId: expand(config.oauth.clientId),
      clientSecret: expand(config.oauth.clientSecret),
      scope: expand(config.oauth.scope)
    }
  }
  // Drop keys that were never set so fingerprints match the stored shape.
  for (const key of Object.keys(resolved) as Array<keyof McpServerConfig>) {
    if (resolved[key] === undefined) delete resolved[key]
  }
  return resolved
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

/** OAuth options from settings or pasted JSON (camelCase or snake_case); undefined when none are set. */
export function sanitizeMcpOAuth(value: unknown): McpOAuthConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const text = (...keys: string[]) => {
    for (const key of keys) {
      const entry = raw[key]
      if (typeof entry === 'string' && entry.trim()) return entry.trim()
    }
    return undefined
  }
  const portValue = raw.callbackPort ?? raw.callback_port
  const port = typeof portValue === 'string' ? Number(portValue.trim()) : portValue
  const oauth: McpOAuthConfig = {
    clientId: text('clientId', 'client_id'),
    clientSecret: text('clientSecret', 'client_secret'),
    scope: text('scope', 'scopes'),
    callbackPort: typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
  }
  for (const key of Object.keys(oauth) as Array<keyof McpOAuthConfig>) {
    if (oauth[key] === undefined) delete oauth[key]
  }
  return Object.keys(oauth).length > 0 ? oauth : undefined
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
        oauth: sanitizeMcpOAuth(entry.oauth),
        disabledTools: sanitizeStringArray(entry.disabledTools),
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
      cwd: typeof entry.cwd === 'string' && entry.cwd.trim() ? entry.cwd.trim() : undefined,
      disabledTools: sanitizeStringArray(entry.disabledTools),
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

/**
 * Whether a value holds no secret of its own: only `${...}` references,
 * optionally after an auth scheme, e.g. "Bearer ${env:TOKEN}".
 */
function isOnlyVariableReferences(value: string): boolean {
  if (!value.includes('${')) return false
  return /^(?:bearer|basic|token)?$/i.test(value.replace(VARIABLE_PATTERN, '').trim())
}

function maskValue(value: string, mask: boolean): string {
  return mask && value && !isOnlyVariableReferences(value) ? MCP_SECRET_MASK : value
}

function maskValues(values: Record<string, string> | undefined, mask: boolean): Record<string, string> | undefined {
  if (!values || Object.keys(values).length === 0) return undefined
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, maskValue(value, mask)]))
}

/**
 * The servers as `{ "mcpServers": { ... } }`, the shape Paste JSON and other
 * MCP clients read. With maskSecrets, env and header values are hidden.
 */
export function serializeMcpServersJson(servers: McpServerConfig[], options: { maskSecrets: boolean }): string {
  const keys = mcpServerJsonKeys(servers)
  const mcpServers: Record<string, Record<string, unknown>> = {}

  servers.forEach((server, index) => {
    const oauth = server.oauth
      ? {
        ...server.oauth,
        ...(server.oauth.clientSecret ? { clientSecret: maskValue(server.oauth.clientSecret, options.maskSecrets) } : {})
      }
      : undefined
    const entry: Record<string, unknown> = server.transport === 'http'
      ? { type: 'http', url: server.url, headers: maskValues(server.headers, options.maskSecrets), oauth }
      : {
        command: server.command,
        args: server.args?.length ? server.args : undefined,
        env: maskValues(server.env, options.maskSecrets),
        cwd: server.cwd
      }
    if (server.disabledTools?.length) entry.disabledTools = server.disabledTools
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
    const restored = {
      ...server,
      ...(server.env ? { env: restoreRecord(server.env, saved?.env, server.name, unresolved) } : {}),
      ...(server.headers ? { headers: restoreRecord(server.headers, saved?.headers, server.name, unresolved) } : {})
    }
    if (server.oauth?.clientSecret === MCP_SECRET_MASK) {
      const secret = saved?.oauth?.clientSecret
      if (secret === undefined) unresolved.push(`"${server.name}": oauth.clientSecret`)
      restored.oauth = { ...server.oauth, clientSecret: secret }
    }
    return restored
  })

  return { servers, unresolved }
}
