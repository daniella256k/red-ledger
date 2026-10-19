import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import type { AddressInfo } from 'net'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpServerConfig } from '../../src/types'

/**
 * OAuth sign-in for remote MCP servers, without Electron imports:
 * a token store, the SDK's OAuthClientProvider, and the loopback page the
 * browser is sent back to (RFC 8252). McpService drives the flow.
 */

const CALLBACK_PATH = '/callback'
const LOOPBACK_HOST = '127.0.0.1'
/** Used before the first sign-in; never listened on. */
const PLACEHOLDER_REDIRECT_URL = `http://${LOOPBACK_HOST}${CALLBACK_PATH}`

// ─── Errors ─────────────────────────────────────────────────────────────────

/** The server wants a sign-in that only the user can start. */
export class McpSignInRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpSignInRequiredError'
  }
}

/** The user closed the sign-in, or it timed out. */
export class McpSignInCancelledError extends Error {
  constructor(message = 'Sign-in was cancelled.') {
    super(message)
    this.name = 'McpSignInCancelledError'
  }
}

// ─── Token store ────────────────────────────────────────────────────────────

/** Everything OAuth keeps for one server. */
export interface McpAuthRecord {
  /** URL and client id the record was made for; when either changes the record is stale. */
  binding: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  discoveryState?: OAuthDiscoveryState
  /** Callback address of the last sign-in, so a dynamically registered client still matches. */
  redirectUrl?: string
}

export interface McpAuthStore {
  get(serverId: string): McpAuthRecord | undefined
  set(serverId: string, record: McpAuthRecord): void
  delete(serverId: string): void
  ids(): string[]
}

/** Turns the store's JSON into what is written to disk and back (encryption in production). */
export interface McpAuthCodec {
  encrypted: boolean
  encode(json: string): string
  decode(data: string): string
}

export const PLAIN_TEXT_CODEC: McpAuthCodec = {
  encrypted: false,
  encode: (json) => json,
  decode: (data) => data
}

export function authBinding(config: Pick<McpServerConfig, 'url' | 'oauth'>): string {
  return JSON.stringify([config.url ?? '', config.oauth?.clientId ?? null])
}

export function createMemoryAuthStore(): McpAuthStore {
  const records = new Map<string, McpAuthRecord>()
  return {
    get: (id) => records.get(id),
    set: (id, record) => {
      records.set(id, record)
    },
    delete: (id) => {
      records.delete(id)
    },
    ids: () => [...records.keys()]
  }
}

/**
 * A store kept in one JSON file, read lazily and written on every change.
 * A file that can't be read or decrypted (e.g. copied from another machine)
 * starts empty, which only means signing in again.
 */
export function createFileAuthStore(path: string, getCodec: () => McpAuthCodec): McpAuthStore {
  let records: Record<string, McpAuthRecord> | null = null

  const load = (): Record<string, McpAuthRecord> => {
    if (records) return records
    records = {}
    try {
      if (existsSync(path)) {
        const file = JSON.parse(readFileSync(path, 'utf-8')) as { encrypted?: boolean; data?: string }
        if (typeof file.data === 'string') {
          const codec = file.encrypted ? getCodec() : PLAIN_TEXT_CODEC
          if (file.encrypted && !codec.encrypted) throw new Error('Encryption is not available')
          const parsed = JSON.parse(codec.decode(file.data)) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            records = parsed as Record<string, McpAuthRecord>
          }
        }
      }
    } catch (err) {
      console.warn('[mcp] Could not read saved sign-ins; starting fresh:', err)
    }
    return records
  }

  const save = () => {
    const current = load()
    if (Object.keys(current).length === 0) {
      rmSync(path, { force: true })
      return
    }
    const codec = getCodec()
    const content = JSON.stringify({ version: 1, encrypted: codec.encrypted, data: codec.encode(JSON.stringify(current)) })
    const tempPath = `${path}.tmp`
    writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tempPath, path)
  }

  return {
    get: (id) => load()[id],
    set: (id, record) => {
      load()[id] = record
      save()
    },
    delete: (id) => {
      if (!(id in load())) return
      delete load()[id]
      save()
    },
    ids: () => Object.keys(load())
  }
}

/** Saved tokens for a server, if they belong to its current URL and client. */
export function hasSavedTokens(store: McpAuthStore, serverId: string, config: Pick<McpServerConfig, 'url' | 'oauth'>): boolean {
  const record = store.get(serverId)
  return !!record && record.binding === authBinding(config) && !!record.tokens?.access_token
}

// ─── Provider ───────────────────────────────────────────────────────────────

export interface InteractiveSignIn {
  redirectUrl: string
  state: string
  openUrl: (url: string) => void | Promise<void>
}

/**
 * Only web pages may be opened from a server-supplied authorization URL;
 * anything else could launch another app on the user's machine.
 */
export function assertSafeAuthorizationUrl(url: URL): void {
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return
  throw new Error(`Refusing to open the sign-in address ${url.protocol}//${url.host}: it is not an https:// page.`)
}

/**
 * OAuthClientProvider for one server. Connections use it passively: saved
 * tokens are sent and refreshed, but when a browser sign-in is needed it
 * throws McpSignInRequiredError instead. The Sign in button creates one with
 * `interactive` set, which opens the browser.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private serverId: string
  private config: McpServerConfig
  private store: McpAuthStore
  private interactive: InteractiveSignIn | null
  private binding: string

  constructor(options: {
    serverId: string
    /** Config with variables already filled in. */
    config: McpServerConfig
    store: McpAuthStore
    interactive?: InteractiveSignIn
  }) {
    this.serverId = options.serverId
    this.config = options.config
    this.store = options.store
    this.interactive = options.interactive ?? null
    this.binding = authBinding(options.config)
  }

  private read(): McpAuthRecord {
    const record = this.store.get(this.serverId)
    return record && record.binding === this.binding ? record : { binding: this.binding }
  }

  private update(patch: Partial<McpAuthRecord>): void {
    this.store.set(this.serverId, { ...this.read(), ...patch, binding: this.binding })
  }

  get redirectUrl(): string {
    return this.interactive?.redirectUrl ?? this.read().redirectUrl ?? PLACEHOLDER_REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = this.config.oauth?.scope?.trim()
    return {
      client_name: 'Red Ledger',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.config.oauth?.clientSecret ? 'client_secret_post' : 'none',
      ...(scope ? { scope } : {})
    }
  }

  state(): string {
    return this.interactive?.state ?? ''
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const { clientId, clientSecret } = this.config.oauth ?? {}
    if (clientId) {
      return { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }
    }

    const info = this.read().clientInformation
    if (!this.interactive) {
      // Registering happens only when the user signs in, never on a background connect.
      if (!info) throw this.signInRequired()
      return info
    }
    // A client registered for another callback port can't finish this sign-in; register again.
    const registered = (info as { redirect_uris?: unknown } | undefined)?.redirect_uris
    if (Array.isArray(registered) && !registered.includes(this.interactive.redirectUrl)) return undefined
    return info
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    if (this.config.oauth?.clientId) return
    this.update({ clientInformation })
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.update({
      tokens,
      codeVerifier: undefined,
      ...(this.interactive ? { redirectUrl: this.interactive.redirectUrl } : {})
    })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) throw this.signInRequired()
    assertSafeAuthorizationUrl(authorizationUrl)
    await this.interactive.openUrl(authorizationUrl.toString())
  }

  saveCodeVerifier(codeVerifier: string): void {
    // A background reconnect must not overwrite the verifier of a sign-in in progress.
    if (this.interactive) this.update({ codeVerifier })
  }

  codeVerifier(): string {
    const verifier = this.read().codeVerifier
    if (!verifier) throw new Error('No sign-in is in progress for this server.')
    return verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      this.store.delete(this.serverId)
      return
    }
    const field = ({
      client: 'clientInformation',
      tokens: 'tokens',
      verifier: 'codeVerifier',
      discovery: 'discoveryState'
    } as const)[scope]
    this.update({ [field]: undefined })
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.update({ discoveryState: state })
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.read().discoveryState
  }

  private signInRequired(): McpSignInRequiredError {
    const offersOAuth = !!this.read().discoveryState?.authorizationServerMetadata
    return new McpSignInRequiredError(offersOAuth
      ? 'Sign in to use this server.'
      : 'The server asked for authorization. If it uses an API key, add it under Headers; otherwise try Sign in.')
  }
}

// ─── Loopback callback page ─────────────────────────────────────────────────

export interface OAuthCallbackServer {
  redirectUrl: string
  /** Resolves with the authorization code, or rejects on error, timeout or close(). */
  code: Promise<string>
  close(): void
}

export interface CallbackServerOptions {
  state: string
  /** Port to try first (the last sign-in's); falls back to any free port. */
  preferredPort?: number
  /** Port that must be used, for clients registered with a fixed redirect address. */
  requiredPort?: number
  timeoutMs: number
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function sendPage(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`
    + '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">'
    + `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`)
}

/** Listen on 127.0.0.1 for the browser's redirect back with ?code=...&state=... */
export async function startOAuthCallbackServer(options: CallbackServerOptions): Promise<OAuthCallbackServer> {
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | null = null
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // Rejections are handled by whoever awaits; don't let an unawaited close() crash.
  code.catch(() => {})

  const finish = (result: { code: string } | { error: Error }) => {
    if (!settle) return
    const current = settle
    settle = null
    if ('code' in result) current.resolve(result.code)
    else current.reject(result.error)
    setImmediate(stop)
  }

  const stop = () => {
    if (server.listening) server.close()
    server.closeAllConnections?.()
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`)
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end()
      return
    }
    if (url.searchParams.get('state') !== options.state) {
      sendPage(res, 400, 'Sign-in link not recognized', 'This page does not match the sign-in Red Ledger started. Start it again from Settings.')
      return
    }
    const error = url.searchParams.get('error')
    if (error) {
      const description = url.searchParams.get('error_description')
      sendPage(res, 400, 'Sign-in failed', description || error)
      finish({ error: new Error(`Sign-in failed: ${description || error}`) })
      return
    }
    const authorizationCode = url.searchParams.get('code')
    if (!authorizationCode) {
      sendPage(res, 400, 'Sign-in failed', 'The sign-in page did not return a code.')
      finish({ error: new Error('Sign-in failed: no authorization code was returned.') })
      return
    }
    sendPage(res, 200, 'Signed in', 'You can close this tab and return to Red Ledger.')
    finish({ code: authorizationCode })
  })

  const listen = (port: number) => new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, LOOPBACK_HOST)
  })

  let port: number
  if (options.requiredPort) {
    try {
      port = await listen(options.requiredPort)
    } catch (err) {
      throw new Error((err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `Port ${options.requiredPort} is in use, and this connection's sign-in needs it. Close whatever is using it and try again.`
        : `Could not open the sign-in callback on port ${options.requiredPort}: ${(err as Error).message}`, { cause: err })
    }
  } else {
    port = await (options.preferredPort ? listen(options.preferredPort).catch(() => listen(0)) : listen(0))
  }

  const timer = setTimeout(() => {
    finish({ error: new McpSignInCancelledError('Sign-in timed out. Try again when you are ready.') })
  }, options.timeoutMs)
  timer.unref?.()
  void code.finally(() => clearTimeout(timer)).catch(() => {})

  return {
    redirectUrl: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`,
    code,
    close: () => {
      finish({ error: new McpSignInCancelledError() })
      stop()
    }
  }
}
