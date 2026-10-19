import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { statSync } from 'fs'
import { homedir } from 'os'
import { extname, isAbsolute, join, sep } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDefinition, ToolParametersSchema } from '../lib/providers/base'
import type { ToolEntry } from '../lib/tools/registry'
import type { DialogAdapter } from './WorkspaceService'
import {
  assignMcpServerPrefixes,
  buildMcpToolName,
  mcpServerPrefix,
  MAX_TOOL_NAME_LENGTH,
  resolveMcpServerConfig,
  type McpVariableContext
} from '../../src/lib/mcpConfig'
import {
  hasSavedTokens,
  McpOAuthProvider,
  McpSignInCancelledError,
  McpSignInRequiredError,
  startOAuthCallbackServer,
  type CallbackServerOptions,
  type McpAuthStore,
  type OAuthCallbackServer
} from './mcpOAuth'
import type { McpServerConfig, McpServerStatus, McpSignInResult, Settings } from '../../src/types'

/** Window handle the tool registry passes through to executors (BrowserWindow in production). */
type ToolWindow = Parameters<ToolEntry['execute']>[1]['win']

const CLIENT_INFO = { name: 'red-ledger', version: '1.0.0' }
/** Per-call timeout; progress notifications from the server reset it. */
const TOOL_CALL_TIMEOUT_MS = 120_000
/** Results larger than this are clipped so one tool can't flood the context. */
export const MAX_MCP_RESULT_CHARS = 100_000
const MAX_STDERR_LINES = 20
const MAX_CONFIRM_ARGS_CHARS = 1_500
/** Tool descriptions sent to the settings UI are clipped; the model still gets the full text. */
const MAX_STATUS_DESCRIPTION_CHARS = 300
const SHUTDOWN_TIMEOUT_MS = 4_000
/** How long the browser sign-in may take before the callback page closes. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/** Bare commands that are .cmd shims on Windows and can't be spawned directly. */
const WINDOWS_CMD_SHIMS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'yarnpkg'])
/** Extra variables (beyond the SDK's safe defaults) that npx and friends need on Windows. */
const WINDOWS_EXTRA_ENV_VARS = ['PATHEXT', 'COMSPEC', 'WINDIR', 'PROGRAMDATA', 'PROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS']
/** Common install locations GUI-launched apps on macOS/Linux miss from PATH. */
const POSIX_EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', `${homedir()}/.local/bin`]

export class McpToolError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'McpToolError'
    this.code = code
  }
}

/** A server's working folder: the configured one (`~` = home), or the home folder. */
export function resolveWorkingFolder(cwd: string | undefined, home: string = homedir()): string {
  const trimmed = (cwd ?? '').trim()
  if (!trimmed) return home
  if (trimmed === '~') return home
  if (/^~[\\/]/.test(trimmed)) return join(home, trimmed.slice(2))
  return trimmed
}

/** Throws a readable error unless `cwd` is an existing folder given as a full path. */
export function checkWorkingFolder(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw new Error(`Working folder "${cwd}" must be a full path.`)
  }
  let isDirectory = false
  try {
    isDirectory = statSync(cwd).isDirectory()
  } catch {
    // Missing; reported below
  }
  if (!isDirectory) throw new Error(`Working folder "${cwd}" does not exist.`)
}

/**
 * Command, args, env and working folder actually used to launch a stdio server.
 * Windows can't spawn .cmd shims like `npx` directly, so they get their
 * extension (cross-spawn inside the SDK then runs them through cmd.exe).
 */
export function resolveStdioLaunch(
  config: Pick<McpServerConfig, 'command' | 'args' | 'env' | 'cwd'>,
  platform: NodeJS.Platform = process.platform,
  baseEnv: Record<string, string | undefined> = process.env
): { command: string; args: string[]; env: Record<string, string>; cwd: string } {
  let command = (config.command ?? '').trim()
  if (platform === 'win32' && WINDOWS_CMD_SHIMS.has(command.toLowerCase()) && !extname(command)) {
    command = `${command}.cmd`
  }

  const env: Record<string, string> = { ...getDefaultEnvironment() }
  if (platform === 'win32') {
    for (const key of WINDOWS_EXTRA_ENV_VARS) {
      const value = baseEnv[key]
      if (value !== undefined && env[key] === undefined) env[key] = value
    }
  } else {
    const pathEntries = (env.PATH ?? '').split(':').filter(Boolean)
    for (const extra of POSIX_EXTRA_PATHS) {
      if (!pathEntries.includes(extra)) pathEntries.push(extra)
    }
    env.PATH = pathEntries.join(':')
  }

  return { command, args: config.args ?? [], env: { ...env, ...config.env }, cwd: resolveWorkingFolder(config.cwd) }
}

/** Kill a process and everything it started (npx → node). Windows needs taskkill for the tree. */
function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  return new Promise((resolve) => {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('exit', () => resolve())
      killer.once('error', () => resolve())
    } catch {
      resolve()
    }
  })
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} more characters]`
}

/**
 * Flatten an MCP tool result into the shape built-in tools return:
 * `{ content }` on success, `{ error, code }` when the server reports isError.
 * Non-text content is summarized since it can't be passed through as text.
 */
export function flattenMcpToolResult(result: unknown): Record<string, unknown> {
  const raw = (result && typeof result === 'object' ? result : {}) as {
    content?: unknown
    structuredContent?: unknown
    isError?: unknown
    toolResult?: unknown
  }

  const parts: string[] = []
  if (Array.isArray(raw.content)) {
    for (const item of raw.content as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object') continue
      switch (item.type) {
        case 'text':
          if (typeof item.text === 'string') parts.push(item.text)
          break
        case 'image':
        case 'audio':
          parts.push(`[${item.type} (${String(item.mimeType ?? 'unknown type')}) not shown]`)
          break
        case 'resource': {
          const resource = (item.resource ?? {}) as Record<string, unknown>
          const uri = String(resource.uri ?? '')
          parts.push(typeof resource.text === 'string'
            ? `[resource ${uri}]\n${resource.text}`
            : `[binary resource ${uri} (${String(resource.mimeType ?? 'unknown type')}) not shown]`)
          break
        }
        case 'resource_link':
          parts.push(`[resource link: ${String(item.name ?? '')} ${String(item.uri ?? '')}]`.replace(/\s+]/, ']'))
          break
      }
    }
  } else if (raw.toolResult !== undefined) {
    // Pre-2024-11 servers return { toolResult } instead of content blocks.
    parts.push(typeof raw.toolResult === 'string' ? raw.toolResult : JSON.stringify(raw.toolResult))
  }

  const text = clipText(parts.join('\n\n'), MAX_MCP_RESULT_CHARS)

  if (raw.isError === true) {
    return { error: text || 'The tool reported an error.', code: 'MCP_ERROR' }
  }

  // Servers are asked to mirror structuredContent as text; only send it when they didn't.
  if (!text && raw.structuredContent !== undefined) {
    return { content: clipText(JSON.stringify(raw.structuredContent), MAX_MCP_RESULT_CHARS) }
  }

  return { content: text }
}

/** Turn an MCP tool's inputSchema into our ToolDefinition, keeping the schema as-is. */
export function toToolDefinition(qualifiedName: string, tool: Tool, serverName: string): ToolDefinition {
  const schema = (tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {}) as Record<string, unknown>
  const parameters: ToolParametersSchema = {
    ...schema,
    type: 'object',
    properties: (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, unknown>
  }
  const description = (tool.description ?? tool.title ?? '').trim()

  return {
    type: 'function',
    function: {
      name: qualifiedName,
      description: description || `Tool "${tool.name}" from the "${serverName}" connection.`,
      parameters
    }
  }
}

/**
 * Whether a failed Streamable HTTP connect looks like a server that only
 * speaks the older HTTP+SSE transport. Those reject the initialize POST with
 * a 4xx (usually 404 or 405). Auth failures are real errors, not a hint to
 * switch transports.
 */
export function shouldFallBackToSse(err: unknown): boolean {
  if (!(err instanceof StreamableHTTPError) || typeof err.code !== 'number') return false
  return err.code >= 400 && err.code < 500 && err.code !== 401 && err.code !== 403
}

/** The server wants the user to sign in (no saved tokens, or they stopped working). */
function isSignInRequired(err: unknown): boolean {
  return err instanceof McpSignInRequiredError || err instanceof UnauthorizedError
}

function hasStaticAuthorization(config: McpServerConfig): boolean {
  return Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
}

function describeConnectError(err: unknown, config: McpServerConfig, stderrTail: string[]): string {
  const error = err as NodeJS.ErrnoException | undefined
  let message = error instanceof Error ? error.message : String(err)

  if (error?.code === 'ENOENT' && config.transport === 'stdio') {
    message = `Could not start "${config.command}". Is it installed and on your PATH?`
  } else if (/ECONNREFUSED|fetch failed/i.test(message) && config.transport === 'http') {
    message = `Could not reach ${config.url}. Is the server running?`
  } else if (/Connection closed/i.test(message) && config.transport === 'stdio') {
    message = 'The server stopped while connecting.'
  }

  const lastStderr = stderrTail.filter((line) => line.trim()).slice(-3).join('\n')
  return lastStderr ? `${message}\n${lastStderr}` : message
}

interface Connection {
  config: McpServerConfig
  /** Config with `${...}` variables filled in; null when one couldn't be. */
  resolved: McpServerConfig | null
  fingerprint: string
  prefix: string
  state: McpServerStatus['state']
  error?: string
  client: Client | null
  transport: Transport | null
  /** Tools the server reported, in its order. */
  tools: Tool[]
  /** Registered model-facing names → original tool names. */
  registered: Map<string, string>
  stderrTail: string[]
  /** Set once this connection was replaced or shut down; late async results are dropped. */
  retired: boolean
}

export interface McpServiceDeps {
  getSettings: () => Settings
  /** Dialog for Strict Mode confirmations; null when no window is available. */
  getDialog: (win: ToolWindow) => DialogAdapter | null
  registerTool: (entry: ToolEntry) => void
  unregisterTool: (name: string) => void
  onStatusChange?: (statuses: McpServerStatus[]) => void
  /** Saved OAuth sign-ins. Without one, remote servers can't sign in. */
  authStore?: McpAuthStore
  /** Opens a sign-in page in the user's browser. */
  openUrl?: (url: string) => void | Promise<void>
  /** Override for tests; defaults to a loopback page on 127.0.0.1. */
  startCallbackServer?: (options: CallbackServerOptions) => Promise<OAuthCallbackServer>
  /** Override for tests; defaults to this process's environment and home folder. */
  variableContext?: () => Omit<McpVariableContext, 'workspaceFolder'>
  /**
   * Override for tests; defaults to the real stdio / Streamable HTTP transports.
   * `config` has variables filled in. `legacySse` is set on the retry for
   * remote servers that only speak HTTP+SSE; `authProvider` is set for remote
   * servers that may use OAuth.
   */
  createTransport?: (
    config: McpServerConfig,
    onStderr: (chunk: string) => void,
    options: { legacySse: boolean; authProvider?: OAuthClientProvider }
  ) => Transport
}

/**
 * Domain service for MCP (Model Context Protocol) connections.
 * Keeps one client per enabled server, registers each server's tools in the
 * shared tool registry as `<server>__<tool>`, and unregisters them when the
 * server goes away. No Electron imports — dialogs and the registry are injected.
 */
export class McpService {
  private deps: McpServiceDeps
  private connections = new Map<string, Connection>()
  private order: string[] = []
  private configs = new Map<string, McpServerConfig>()
  private workspaceFolder: string | null = null
  /** Browser sign-ins in progress, by server id. */
  private signIns = new Map<string, OAuthCallbackServer>()

  constructor(deps: McpServiceDeps) {
    this.deps = deps
  }

  /**
   * Bring connections in line with the configured servers. Unchanged servers
   * are left alone, so this is cheap to call on every settings save. Servers
   * that use `${workspaceFolder}` restart when the workspace folder changes.
   */
  applyServers(servers: McpServerConfig[], workspaceFolder: string | null = this.workspaceFolder): void {
    this.workspaceFolder = workspaceFolder
    for (const [id, connection] of this.connections) {
      const next = servers.find((server) => server.id === id)
      if (!next?.enabled || this.fingerprint(next) !== connection.fingerprint) {
        void this.retire(connection)
        this.connections.delete(id)
      }
    }

    this.order = servers.map((server) => server.id)
    this.configs = new Map(servers.map((server) => [server.id, server]))
    const prefixes = assignMcpServerPrefixes(servers)

    // Forget sign-ins for servers that were removed.
    const store = this.deps.authStore
    if (store) {
      for (const id of store.ids()) {
        if (!this.configs.has(id)) store.delete(id)
      }
    }

    for (const server of servers) {
      if (!server.enabled) continue
      const existing = this.connections.get(server.id)
      const prefix = prefixes.get(server.id) ?? mcpServerPrefix(server.name)
      if (existing) {
        // Same launch settings: keep the connection, but a rename changes tool
        // names and switching tools on or off changes which are registered.
        const renamed = existing.prefix !== prefix || existing.config.name !== server.name
        const toolsChanged = JSON.stringify(existing.config.disabledTools ?? []) !== JSON.stringify(server.disabledTools ?? [])
        existing.config = server
        existing.prefix = prefix
        if ((renamed || toolsChanged) && existing.state === 'connected') this.registerTools(existing)
        continue
      }
      this.connect(server, prefix)
    }

    this.emitStatus()
  }

  /** Drop and re-open one server's connection (the Retry button). */
  async reconnect(serverId: string): Promise<void> {
    const config = this.configs.get(serverId)
    if (!config?.enabled) return
    const existing = this.connections.get(serverId)
    const prefix = existing?.prefix ?? assignMcpServerPrefixes([...this.configs.values()]).get(serverId) ?? mcpServerPrefix(config.name)
    if (existing) {
      this.connections.delete(serverId)
      await this.retire(existing)
    }
    await this.connect(config, prefix)
  }

  getStatuses(): McpServerStatus[] {
    const store = this.deps.authStore
    return this.order.map((id) => {
      const connection = this.connections.get(id)
      if (!connection) return { id, state: 'disabled' as const, toolCount: 0 }
      const resolved = connection.resolved
      const signedIn = !!store && resolved?.transport === 'http' && hasSavedTokens(store, id, resolved)
      return {
        id,
        state: connection.state,
        toolCount: connection.registered.size,
        ...(connection.error ? { error: connection.error } : {}),
        ...(signedIn ? { signedIn } : {}),
        ...(this.signIns.has(id) ? { signingIn: true } : {}),
        ...(connection.state === 'connected'
          ? {
            tools: connection.tools.map((tool) => {
              const description = (tool.description ?? tool.title ?? '').trim()
              return {
                name: tool.name,
                ...(description ? { description: clipText(description, MAX_STATUS_DESCRIPTION_CHARS) } : {})
              }
            })
          }
          : {})
      }
    })
  }

  // ─── OAuth sign-in ────────────────────────────────────────────────────────

  /**
   * Sign in to a remote server in the browser: open the provider's page,
   * wait for it to redirect back to a loopback address, save the tokens and
   * reconnect. Saved tokens are refreshed automatically after that.
   */
  async signIn(serverId: string): Promise<McpSignInResult> {
    const config = this.configs.get(serverId)
    const store = this.deps.authStore
    const openUrl = this.deps.openUrl
    if (!config?.enabled || config.transport !== 'http') {
      return { ok: false, error: 'Only enabled remote connections can sign in.' }
    }
    if (!store || !openUrl) return { ok: false, error: 'Sign-in is not available.' }
    if (this.signIns.has(serverId)) return { ok: false, error: 'A sign-in is already in progress for this connection.' }

    const resolution = this.resolve(config)
    if ('error' in resolution) return { ok: false, error: resolution.error }
    const resolved = resolution.resolved
    if (!resolved.url) return { ok: false, error: 'No URL set for this connection.' }

    const state = randomBytes(16).toString('hex')
    const previousRedirect = store.get(serverId)?.redirectUrl
    let callback: OAuthCallbackServer
    try {
      callback = await (this.deps.startCallbackServer ?? startOAuthCallbackServer)({
        state,
        preferredPort: previousRedirect ? Number(new URL(previousRedirect).port) || undefined : undefined,
        requiredPort: resolved.oauth?.callbackPort,
        timeoutMs: SIGN_IN_TIMEOUT_MS
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.signIns.set(serverId, callback)
    this.emitStatus()

    try {
      const provider = new McpOAuthProvider({
        serverId,
        config: resolved,
        store,
        interactive: { redirectUrl: callback.redirectUrl, state, openUrl }
      })
      const options = { serverUrl: resolved.url, ...(resolved.oauth?.scope ? { scope: resolved.oauth.scope } : {}) }
      if (await auth(provider, options) === 'REDIRECT') {
        const code = await callback.code
        await auth(provider, { ...options, authorizationCode: code })
      }
    } catch (err) {
      if (err instanceof McpSignInCancelledError) return { ok: false, cancelled: true, error: err.message }
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: /^sign-in/i.test(message) ? message : `Sign-in failed: ${message}` }
    } finally {
      callback.close()
      if (this.signIns.get(serverId) === callback) this.signIns.delete(serverId)
      this.emitStatus()
    }

    await this.reconnect(serverId)
    return { ok: true }
  }

  /** Stop waiting for the browser (the Cancel button). */
  cancelSignIn(serverId: string): void {
    this.signIns.get(serverId)?.close()
  }

  /** Forget a server's tokens and registration, then reconnect (it will ask to sign in again). */
  async signOut(serverId: string): Promise<void> {
    this.cancelSignIn(serverId)
    this.deps.authStore?.delete(serverId)
    await this.reconnect(serverId)
    this.emitStatus()
  }

  /** Close every connection and its child process. Resolves within a few seconds even if a server hangs. */
  async closeAll(): Promise<void> {
    for (const callback of this.signIns.values()) callback.close()
    this.signIns.clear()
    const connections = [...this.connections.values()]
    this.connections.clear()
    if (connections.length === 0) return
    await Promise.race([
      Promise.allSettled(connections.map((connection) => this.retire(connection))),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref?.())
    ])
  }

  // ─── Connection lifecycle ─────────────────────────────────────────────────

  private variableContext(): McpVariableContext {
    const base = this.deps.variableContext?.() ?? { userHome: homedir(), pathSeparator: sep, env: process.env }
    return { ...base, workspaceFolder: this.workspaceFolder }
  }

  private resolve(config: McpServerConfig): { resolved: McpServerConfig } | { error: string } {
    try {
      return { resolved: resolveMcpServerConfig(config, this.variableContext()) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** What a connection was opened with; any change means reconnecting. Uses filled-in variables. */
  private fingerprint(config: McpServerConfig): string {
    const resolution = this.resolve(config)
    const c = 'resolved' in resolution ? resolution.resolved : config
    return JSON.stringify([
      c.transport, c.command, c.args, c.env, c.cwd, c.url, c.headers, c.oauth,
      'error' in resolution ? resolution.error : null
    ])
  }

  private createTransport(
    connection: Connection,
    config: McpServerConfig,
    onStderr: (chunk: string) => void,
    legacySse: boolean
  ): Transport {
    // A fixed Authorization header means the user handles auth; otherwise OAuth kicks in on a 401.
    const authProvider = config.transport === 'http' && this.deps.authStore && !hasStaticAuthorization(config)
      ? new McpOAuthProvider({ serverId: connection.config.id, config, store: this.deps.authStore })
      : undefined
    if (this.deps.createTransport) return this.deps.createTransport(config, onStderr, { legacySse, authProvider })

    if (config.transport === 'http') {
      if (!config.url) throw new Error('No URL set for this connection.')
      // The SSE transport sends requestInit headers on both the event stream and its POSTs.
      const options = { requestInit: config.headers ? { headers: config.headers } : undefined, authProvider }
      return legacySse
        ? new SSEClientTransport(new URL(config.url), options)
        : new StreamableHTTPClientTransport(new URL(config.url), options)
    }

    if (!config.command) throw new Error('No command set for this connection.')
    const launch = resolveStdioLaunch(config)
    const transport = new StdioClientTransport({ ...launch, stderr: 'pipe' })
    transport.stderr?.on('data', (chunk: Buffer | string) => onStderr(chunk.toString()))
    return transport
  }

  private async connect(config: McpServerConfig, prefix: string): Promise<void> {
    const resolution = this.resolve(config)
    const connection: Connection = {
      config,
      resolved: 'resolved' in resolution ? resolution.resolved : null,
      fingerprint: this.fingerprint(config),
      prefix,
      state: 'connecting',
      client: null,
      transport: null,
      tools: [],
      registered: new Map(),
      stderrTail: [],
      retired: false
    }
    this.connections.set(config.id, connection)
    this.emitStatus()

    const onStderr = (chunk: string) => {
      connection.stderrTail.push(...chunk.split(/\r?\n/).filter((line) => line.trim()))
      if (connection.stderrTail.length > MAX_STDERR_LINES) {
        connection.stderrTail.splice(0, connection.stderrTail.length - MAX_STDERR_LINES)
      }
    }

    try {
      if ('error' in resolution) throw new Error(resolution.error)
      if (resolution.resolved.transport === 'stdio') {
        checkWorkingFolder(resolveWorkingFolder(resolution.resolved.cwd))
      }

      let client: Client
      try {
        client = await this.openClient(connection, onStderr, false)
      } catch (err) {
        if (connection.retired || config.transport !== 'http' || !shouldFallBackToSse(err)) throw err
        // Older remote servers only speak HTTP+SSE; try that before giving up.
        await this.closeTransport(connection)
        if (connection.retired) return
        try {
          client = await this.openClient(connection, onStderr, true)
        } catch (sseErr) {
          const first = err instanceof Error ? err.message : String(err)
          const second = sseErr instanceof Error ? sseErr.message : String(sseErr)
          throw new Error(`${first}\nLegacy SSE also failed: ${second}`, { cause: sseErr })
        }
      }
      if (connection.retired) return

      connection.tools = await this.listAllTools(client)
      if (connection.retired) return

      connection.state = 'connected'
      connection.error = undefined
      this.registerTools(connection)
    } catch (err) {
      if (connection.retired) return
      if (isSignInRequired(err)) {
        connection.state = 'needs_auth'
        connection.error = err instanceof McpSignInRequiredError ? err.message : 'Sign in to use this server.'
      } else {
        connection.state = 'error'
        connection.error = describeConnectError(err, connection.resolved ?? config, connection.stderrTail)
      }
      this.unregisterTools(connection)
      void this.closeTransport(connection)
    }
    this.emitStatus()
  }

  /** Create a transport + client for one connection attempt and run the initialize handshake. */
  private async openClient(
    connection: Connection,
    onStderr: (chunk: string) => void,
    legacySse: boolean
  ): Promise<Client> {
    // connect() only gets here once variables resolved.
    const transport = this.createTransport(connection, connection.resolved ?? connection.config, onStderr, legacySse)
    connection.transport = transport
    const client = new Client(CLIENT_INFO, {
      capabilities: {},
      listChanged: {
        tools: {
          autoRefresh: false,
          onChanged: () => {
            void this.refreshTools(connection)
          }
        }
      }
    })
    connection.client = client
    // A failed first attempt closes later; only the current client's close counts.
    client.onclose = () => {
      if (connection.client === client) this.handleUnexpectedClose(connection)
    }

    await client.connect(transport)
    return client
  }

  private async listAllTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  private async refreshTools(connection: Connection): Promise<void> {
    if (connection.retired || connection.state !== 'connected' || !connection.client) return
    try {
      const tools = await this.listAllTools(connection.client)
      if (connection.retired) return
      connection.tools = tools
      this.registerTools(connection)
      this.emitStatus()
    } catch {
      // Keep the previous tool list; the server may still be usable.
    }
  }

  private handleUnexpectedClose(connection: Connection): void {
    if (connection.retired) return
    this.unregisterTools(connection)
    // During connect the catch block reports the failure with more detail.
    if (connection.state !== 'connected') return
    connection.state = 'error'
    const lastStderr = connection.stderrTail.slice(-3).join('\n')
    connection.error = lastStderr ? `Connection closed.\n${lastStderr}` : 'Connection closed.'
    this.emitStatus()
  }

  private async retire(connection: Connection): Promise<void> {
    connection.retired = true
    this.unregisterTools(connection)
    await this.closeTransport(connection)
  }

  private async closeTransport(connection: Connection): Promise<void> {
    const transport = connection.transport
    const pid = transport instanceof StdioClientTransport ? transport.pid : null
    try {
      if (pid) await terminateProcessTree(pid)
      if (connection.client) await connection.client.close()
      else await transport?.close()
    } catch {
      // Already closed
    }
  }

  // ─── Tool registration ────────────────────────────────────────────────────

  private registerTools(connection: Connection): void {
    this.unregisterTools(connection)
    const disabled = new Set(connection.config.disabledTools ?? [])
    for (const tool of connection.tools) {
      if (disabled.has(tool.name)) continue
      let name = buildMcpToolName(connection.prefix, tool.name)
      for (let n = 2; connection.registered.has(name); n++) {
        const suffix = `_${n}`
        name = `${buildMcpToolName(connection.prefix, tool.name).slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`
      }
      connection.registered.set(name, tool.name)
      this.deps.registerTool({
        definition: toToolDefinition(name, tool, connection.config.name),
        execute: (args, { win }) => this.callTool(connection, tool.name, args, win)
      })
    }
  }

  private unregisterTools(connection: Connection): void {
    for (const name of connection.registered.keys()) {
      this.deps.unregisterTool(name)
    }
    connection.registered.clear()
  }

  // ─── Tool calls ───────────────────────────────────────────────────────────

  private async confirmToolCall(
    connection: Connection,
    toolName: string,
    args: Record<string, unknown>,
    win: ToolWindow
  ): Promise<void> {
    if (!this.deps.getSettings().strictMode) return

    const dialog = this.deps.getDialog(win)
    if (!dialog) {
      throw new McpToolError('USER_DENIED', 'Strict Mode is on and no window is available to confirm this tool call')
    }

    const argsText = clipText(JSON.stringify(args ?? {}, null, 2), MAX_CONFIRM_ARGS_CHARS)
    const confirmed = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Deny', 'Allow'],
      defaultId: 0,
      title: 'Tool Call Request',
      message: `The assistant wants to use "${toolName}" from ${connection.config.name}`,
      detail: `Arguments:\n${argsText}\n\nDo you want to allow this tool call?`
    })
    if (confirmed.response === 0) {
      throw new McpToolError('USER_DENIED', 'User denied tool call')
    }
  }

  private async callTool(
    connection: Connection,
    toolName: string,
    args: Record<string, unknown>,
    win: ToolWindow
  ): Promise<unknown> {
    if (connection.retired || connection.state !== 'connected' || !connection.client) {
      throw new McpToolError('MCP_ERROR', `The "${connection.config.name}" connection is not available right now.`)
    }

    await this.confirmToolCall(connection, toolName, args, win)

    try {
      const result = await connection.client.callTool(
        { name: toolName, arguments: args ?? {} },
        undefined,
        { timeout: TOOL_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true }
      )
      return flattenMcpToolResult(result)
    } catch (err) {
      if (isSignInRequired(err) && !connection.retired) {
        // Tokens expired and couldn't be refreshed: drop the tools until the user signs in again.
        this.unregisterTools(connection)
        connection.state = 'needs_auth'
        connection.error = 'Your sign-in expired. Sign in again to use this server.'
        this.emitStatus()
        throw new McpToolError('MCP_ERROR', `The "${connection.config.name}" connection needs the user to sign in again (Settings → Connections).`)
      }
      throw new McpToolError('MCP_ERROR', err instanceof Error ? err.message : String(err))
    }
  }

  private emitStatus(): void {
    this.deps.onStatusChange?.(this.getStatuses())
  }
}
