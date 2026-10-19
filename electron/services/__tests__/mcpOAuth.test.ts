import { describe, it, expect, vi, afterEach } from 'vitest'
import { createServer, type Server as HttpServer } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  McpOAuthProvider,
  McpSignInCancelledError,
  McpSignInRequiredError,
  assertSafeAuthorizationUrl,
  authBinding,
  createFileAuthStore,
  createMemoryAuthStore,
  hasSavedTokens,
  startOAuthCallbackServer,
  PLAIN_TEXT_CODEC,
  type McpAuthCodec
} from '../mcpOAuth'
import { McpService } from '../McpService'
import type { McpServerConfig, McpServerStatus } from '../../../src/types'

function remote(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id: 'r1', name: 'Remote', transport: 'http', url: 'https://mcp.example.com/mcp', enabled: true, ...overrides }
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

// ─── Provider ───────────────────────────────────────────────────────────────

describe('McpOAuthProvider', () => {
  it('never registers or opens a browser on a background connect', async () => {
    const store = createMemoryAuthStore()
    const provider = new McpOAuthProvider({ serverId: 'r1', config: remote(), store })
    expect(() => provider.clientInformation()).toThrow(McpSignInRequiredError)
    await expect(provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))).rejects.toThrow(McpSignInRequiredError)

    provider.saveCodeVerifier('verifier')
    expect(store.get('r1')).toBeUndefined()
  })

  it('says whether the server offers OAuth when asking to sign in', () => {
    const store = createMemoryAuthStore()
    const provider = new McpOAuthProvider({ serverId: 'r1', config: remote(), store })
    expect(() => provider.clientInformation()).toThrow(/API key/)

    provider.saveDiscoveryState({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: { issuer: 'https://auth.example.com' } as never
    })
    expect(() => provider.clientInformation()).toThrow('Sign in to use this server.')
  })

  it('keeps tokens per URL and client id', () => {
    const store = createMemoryAuthStore()
    const provider = new McpOAuthProvider({ serverId: 'r1', config: remote(), store })
    provider.saveTokens({ access_token: 'a', token_type: 'Bearer' })
    expect(provider.tokens()?.access_token).toBe('a')
    expect(hasSavedTokens(store, 'r1', remote())).toBe(true)

    const moved = new McpOAuthProvider({ serverId: 'r1', config: remote({ url: 'https://other.example.com/mcp' }), store })
    expect(moved.tokens()).toBeUndefined()
    expect(hasSavedTokens(store, 'r1', remote({ url: 'https://other.example.com/mcp' }))).toBe(false)
  })

  it('uses a pre-registered client and re-registers dynamic clients for a new callback port', () => {
    const store = createMemoryAuthStore()
    const preRegistered = new McpOAuthProvider({
      serverId: 'r1',
      config: remote({ oauth: { clientId: 'my-app', clientSecret: 's3cret' } }),
      store
    })
    expect(preRegistered.clientInformation()).toEqual({ client_id: 'my-app', client_secret: 's3cret' })
    expect(preRegistered.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post')

    store.set('r1', {
      binding: authBinding(remote()),
      clientInformation: { client_id: 'dyn', redirect_uris: ['http://127.0.0.1:5000/callback'] }
    })
    const interactive = (redirectUrl: string) => new McpOAuthProvider({
      serverId: 'r1',
      config: remote(),
      store,
      interactive: { redirectUrl, state: 's', openUrl: () => {} }
    })
    expect(interactive('http://127.0.0.1:5000/callback').clientInformation()?.client_id).toBe('dyn')
    expect(interactive('http://127.0.0.1:6000/callback').clientInformation()).toBeUndefined()
  })

  it('invalidates the requested part of the record', () => {
    const store = createMemoryAuthStore()
    const provider = new McpOAuthProvider({ serverId: 'r1', config: remote(), store })
    provider.saveClientInformation({ client_id: 'c' })
    provider.saveTokens({ access_token: 'a', token_type: 'Bearer' })
    provider.invalidateCredentials('tokens')
    expect(provider.tokens()).toBeUndefined()
    expect(store.get('r1')?.clientInformation).toEqual({ client_id: 'c' })
    provider.invalidateCredentials('all')
    expect(store.get('r1')).toBeUndefined()
  })
})

describe('assertSafeAuthorizationUrl', () => {
  it('only allows https pages and loopback http', () => {
    expect(() => assertSafeAuthorizationUrl(new URL('https://auth.example.com/x'))).not.toThrow()
    expect(() => assertSafeAuthorizationUrl(new URL('http://127.0.0.1:9000/x'))).not.toThrow()
    expect(() => assertSafeAuthorizationUrl(new URL('http://auth.example.com/x'))).toThrow()
    expect(() => assertSafeAuthorizationUrl(new URL('file:///C:/Windows/notepad.exe'))).toThrow()
    expect(() => assertSafeAuthorizationUrl(new URL('ms-settings:privacy'))).toThrow()
  })
})

// ─── Store ──────────────────────────────────────────────────────────────────

describe('createFileAuthStore', () => {
  function tempFile() {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-auth-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return join(dir, 'mcp-auth.json')
  }

  const reversing: McpAuthCodec = {
    encrypted: true,
    encode: (json) => Buffer.from([...json].reverse().join('')).toString('base64'),
    decode: (data) => [...Buffer.from(data, 'base64').toString()].reverse().join('')
  }

  it('round-trips records through the codec and never writes them in the clear', () => {
    const path = tempFile()
    const store = createFileAuthStore(path, () => reversing)
    store.set('r1', { binding: 'b', tokens: { access_token: 'secret-token', token_type: 'Bearer' } })

    expect(readFileSync(path, 'utf-8')).not.toContain('secret-token')
    const reopened = createFileAuthStore(path, () => reversing)
    expect(reopened.get('r1')?.tokens?.access_token).toBe('secret-token')

    reopened.delete('r1')
    expect(createFileAuthStore(path, () => reversing).ids()).toEqual([])
  })

  it('starts empty when the file cannot be decrypted', () => {
    const path = tempFile()
    createFileAuthStore(path, () => reversing).set('r1', { binding: 'b' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())

    expect(createFileAuthStore(path, () => PLAIN_TEXT_CODEC).get('r1')).toBeUndefined()
    writeFileSync(path, '{not json')
    expect(createFileAuthStore(path, () => reversing).ids()).toEqual([])
  })
})

// ─── Callback page ──────────────────────────────────────────────────────────

describe('startOAuthCallbackServer', () => {
  it('resolves with the code when the state matches', async () => {
    const callback = await startOAuthCallbackServer({ state: 'abc', timeoutMs: 5_000 })
    cleanups.push(() => callback.close())

    const wrong = await fetch(`${callback.redirectUrl}?code=x&state=nope`)
    expect(wrong.status).toBe(400)

    const ok = await fetch(`${callback.redirectUrl}?code=the-code&state=abc`)
    expect(ok.status).toBe(200)
    await expect(callback.code).resolves.toBe('the-code')
  })

  it('rejects when the provider reports an error, or on close', async () => {
    const failing = await startOAuthCallbackServer({ state: 's', timeoutMs: 5_000 })
    cleanups.push(() => failing.close())
    await fetch(`${failing.redirectUrl}?state=s&error=access_denied&error_description=User+said+no`)
    await expect(failing.code).rejects.toThrow('Sign-in failed: User said no')

    const closed = await startOAuthCallbackServer({ state: 's', timeoutMs: 5_000 })
    closed.close()
    await expect(closed.code).rejects.toBeInstanceOf(McpSignInCancelledError)
  })

  it('explains when a required port is taken', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())))
    const port = (blocker.address() as AddressInfo).port

    await expect(startOAuthCallbackServer({ state: 's', requiredPort: port, timeoutMs: 5_000 }))
      .rejects.toThrow(`Port ${port} is in use`)
  })
})

// ─── Full sign-in ───────────────────────────────────────────────────────────

/**
 * A minimal OAuth 2.1 provider for an MCP server: protected resource metadata,
 * authorization server metadata, dynamic registration, an authorize endpoint
 * that approves at once, and a token endpoint.
 */
async function startFakeAuthServer() {
  const requests: string[] = []
  let base = ''
  const server: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base)
    requests.push(`${req.method} ${url.pathname}`)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base] })
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none']
        })
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        return json(201, { ...JSON.parse(body), client_id: 'registered-client' })
      }
      if (url.pathname === '/authorize') {
        const redirect = new URL(url.searchParams.get('redirect_uri')!)
        redirect.searchParams.set('code', 'auth-code')
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
        res.writeHead(302, { Location: redirect.toString() })
        return res.end()
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(body)
        if (params.get('code') !== 'auth-code' || !params.get('code_verifier')) {
          return json(400, { error: 'invalid_grant' })
        }
        return json(200, { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 })
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { base, requests }
}

describe('McpService.signIn', () => {
  it('registers, opens the browser, exchanges the code and reconnects', async () => {
    const auth = await startFakeAuthServer()
    const store = createMemoryAuthStore()
    const opened: string[] = []
    const statuses: McpServerStatus[][] = []
    const createTransport = vi.fn(() => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
      void server.connect(serverTransport)
      return clientTransport
    })

    const service = new McpService({
      getSettings: () => ({ strictMode: false }) as never,
      getDialog: () => null,
      registerTool: () => {},
      unregisterTool: () => {},
      onStatusChange: (next) => statuses.push(next),
      authStore: store,
      // Stands in for the browser: follow the authorize redirect back to the callback page.
      openUrl: async (url) => {
        opened.push(url)
        await fetch(url)
      },
      createTransport
    })
    cleanups.push(() => service.closeAll())
    const config = remote({ url: `${auth.base}/mcp` })
    service.applyServers([config])

    const result = await service.signIn('r1')
    expect(result).toEqual({ ok: true })
    expect(opened).toHaveLength(1)
    expect(new URL(opened[0]).searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.requests).toContain('POST /register')
    expect(auth.requests).toContain('POST /token')

    const record = store.get('r1')!
    expect(record.tokens?.access_token).toBe('access-1')
    expect(record.codeVerifier).toBeUndefined()
    expect(record.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(statuses.some((list) => list[0]?.signingIn)).toBe(true)

    await vi.waitFor(() => expect(service.getStatuses()[0]).toMatchObject({ state: 'connected', signedIn: true }))

    await service.signOut('r1')
    expect(store.get('r1')).toBeUndefined()
    expect(service.getStatuses()[0].signedIn).toBeUndefined()
  })

  it('reports a cancelled sign-in without an error toast', async () => {
    const auth = await startFakeAuthServer()
    let service: McpService | null = null
    service = new McpService({
      getSettings: () => ({ strictMode: false }) as never,
      getDialog: () => null,
      registerTool: () => {},
      unregisterTool: () => {},
      authStore: createMemoryAuthStore(),
      // The user closes the browser tab: nothing comes back, then Cancel is pressed.
      openUrl: () => {
        setTimeout(() => service?.cancelSignIn('r1'), 10)
      },
      createTransport: () => InMemoryTransport.createLinkedPair()[0]
    })
    cleanups.push(() => service!.closeAll())
    service.applyServers([remote({ url: `${auth.base}/mcp` })])

    const result = await service.signIn('r1')
    expect(result).toMatchObject({ ok: false, cancelled: true })
    expect(service.getStatuses()[0].signingIn).toBeUndefined()
  })
})
