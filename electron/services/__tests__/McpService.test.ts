import { describe, it, expect, vi, afterEach } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  McpService,
  flattenMcpToolResult,
  resolveStdioLaunch,
  MAX_MCP_RESULT_CHARS
} from '../McpService'
import type { ToolEntry } from '../../lib/tools/registry'
import type { DialogAdapter } from '../WorkspaceService'
import type { McpServerConfig, McpServerStatus, Settings } from '../../../src/types'

// ─── Fakes ──────────────────────────────────────────────────────────────────

const ECHO_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'Text to echo' },
    options: {
      type: 'object',
      properties: { loud: { type: 'boolean' } },
      additionalProperties: false
    }
  },
  required: ['message'],
  additionalProperties: false,
  $defs: { unused: { type: 'number' } }
}

interface FakeServer {
  server: Server
  tools: Tool[]
  calls: Array<{ name: string; args: unknown }>
}

/**
 * A real MCP server over an in-memory transport pair. Each connect gets a
 * fresh server, like spawning a new process would.
 */
function createFakeServerFactory(initialTools?: Tool[]) {
  const servers: FakeServer[] = []
  const transports: InMemoryTransport[] = []

  const createTransport = vi.fn((config: McpServerConfig) => {
    if (config.command === 'fail') throw new Error('spawn fail ENOENT')

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const fake: FakeServer = {
      server: new Server(
        { name: `fake-${config.name}`, version: '1.0.0' },
        { capabilities: { tools: { listChanged: true } } }
      ),
      tools: initialTools ?? [
        { name: 'echo', description: 'Echo a message', inputSchema: ECHO_SCHEMA as Tool['inputSchema'] },
        { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } }
      ],
      calls: []
    }

    fake.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: fake.tools }))
    fake.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      fake.calls.push({ name: request.params.name, args: request.params.arguments })
      if (request.params.name === 'fail') {
        return { isError: true, content: [{ type: 'text', text: 'Something broke' }] }
      }
      return { content: [{ type: 'text', text: `echo: ${String(request.params.arguments?.message)}` }] }
    })
    void fake.server.connect(serverTransport)

    servers.push(fake)
    transports.push(clientTransport)
    return clientTransport
  })

  return { createTransport, servers, transports }
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { strictMode: false, mcpServers: [], ...overrides } as Settings
}

function stdioServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv-1',
    name: 'Everything',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    enabled: true,
    ...overrides
  }
}

function setup(options: { settings?: Partial<Settings>; dialog?: DialogAdapter | null; tools?: Tool[] } = {}) {
  const registry = new Map<string, ToolEntry>()
  const statuses: McpServerStatus[][] = []
  const settings = makeSettings(options.settings)
  const factory = createFakeServerFactory(options.tools)
  const getDialog = vi.fn(() => (options.dialog === undefined ? null : options.dialog))

  const service = new McpService({
    getSettings: () => settings,
    getDialog,
    registerTool: (entry) => registry.set(entry.definition.function.name, entry),
    unregisterTool: (name) => registry.delete(name),
    onStatusChange: (next) => statuses.push(next),
    createTransport: factory.createTransport
  })

  return { service, registry, statuses, settings, factory, getDialog }
}

async function waitForState(service: McpService, id: string, state: McpServerStatus['state']) {
  await vi.waitFor(() => {
    expect(service.getStatuses().find((s) => s.id === id)?.state).toBe(state)
  })
}

let activeService: McpService | null = null
afterEach(async () => {
  await activeService?.closeAll()
  activeService = null
})

// ─── Connections ────────────────────────────────────────────────────────────

describe('McpService connections', () => {
  it('connects enabled servers and registers <server>__<tool> names', async () => {
    const { service, registry } = setup()
    activeService = service
    service.applyServers([stdioServer()])

    expect(service.getStatuses()).toEqual([{ id: 'srv-1', state: 'connecting', toolCount: 0 }])
    await waitForState(service, 'srv-1', 'connected')

    expect([...registry.keys()].sort()).toEqual(['everything__echo', 'everything__fail'])
    expect(service.getStatuses()).toEqual([{ id: 'srv-1', state: 'connected', toolCount: 2 }])
  })

  it('passes the server JSON Schema through unchanged', async () => {
    const { service, registry } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')

    const definition = registry.get('everything__echo')!.definition
    expect(definition.type).toBe('function')
    expect(definition.function.description).toBe('Echo a message')
    expect(definition.function.parameters).toEqual(ECHO_SCHEMA)
    // Schemas without properties still get an (empty) properties object.
    expect(registry.get('everything__fail')!.definition.function.parameters)
      .toEqual({ type: 'object', properties: {} })
  })

  it('does not connect disabled servers', () => {
    const { service, factory, registry } = setup()
    activeService = service
    service.applyServers([stdioServer({ enabled: false })])

    expect(factory.createTransport).not.toHaveBeenCalled()
    expect(registry.size).toBe(0)
    expect(service.getStatuses()).toEqual([{ id: 'srv-1', state: 'disabled', toolCount: 0 }])
  })

  it('leaves unchanged servers alone when settings are re-applied', async () => {
    const { service, factory } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')

    service.applyServers([stdioServer()])
    service.applyServers([stdioServer()])
    expect(factory.createTransport).toHaveBeenCalledTimes(1)
  })

  it('reconnects when launch settings change', async () => {
    const { service, factory } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')

    service.applyServers([stdioServer({ args: ['-y', 'other-package'] })])
    await waitForState(service, 'srv-1', 'connected')
    expect(factory.createTransport).toHaveBeenCalledTimes(2)
  })

  it('re-registers tools under the new prefix on rename without reconnecting', async () => {
    const { service, registry, factory } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')

    service.applyServers([stdioServer({ name: 'My Tools' })])
    expect([...registry.keys()].sort()).toEqual(['my-tools__echo', 'my-tools__fail'])
    expect(factory.createTransport).toHaveBeenCalledTimes(1)
  })

  it('unregisters tools and closes the transport when a server is disabled or removed', async () => {
    const { service, registry, factory } = setup()
    activeService = service
    service.applyServers([stdioServer(), stdioServer({ id: 'srv-2', name: 'Second' })])
    await waitForState(service, 'srv-1', 'connected')
    await waitForState(service, 'srv-2', 'connected')
    const closeSpy = vi.spyOn(factory.transports[0], 'close')

    service.applyServers([stdioServer({ enabled: false }), stdioServer({ id: 'srv-2', name: 'Second' })])
    expect([...registry.keys()].sort()).toEqual(['second__echo', 'second__fail'])
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled())

    service.applyServers([])
    expect(registry.size).toBe(0)
    expect(service.getStatuses()).toEqual([])
  })

  it('gives servers with the same name unique prefixes', async () => {
    const { service, registry } = setup()
    activeService = service
    service.applyServers([stdioServer(), stdioServer({ id: 'srv-2' })])
    await waitForState(service, 'srv-1', 'connected')
    await waitForState(service, 'srv-2', 'connected')

    expect([...registry.keys()].sort()).toEqual([
      'everything-2__echo', 'everything-2__fail', 'everything__echo', 'everything__fail'
    ])
  })

  it('reports connection failures as an error status', async () => {
    const { service, registry } = setup()
    activeService = service
    service.applyServers([stdioServer({ command: 'fail' })])

    await waitForState(service, 'srv-1', 'error')
    expect(service.getStatuses()[0].error).toMatch(/spawn fail/)
    expect(registry.size).toBe(0)
  })

  it('marks the server as errored when the connection drops', async () => {
    const { service, registry, factory } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')

    await factory.servers[0].server.close()
    await waitForState(service, 'srv-1', 'error')
    expect(service.getStatuses()[0].error).toMatch(/Connection closed/)
    expect(registry.size).toBe(0)
  })

  it('reconnect() opens a fresh connection', async () => {
    const { service, factory } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')
    await factory.servers[0].server.close()
    await waitForState(service, 'srv-1', 'error')

    await service.reconnect('srv-1')
    await waitForState(service, 'srv-1', 'connected')
    expect(factory.createTransport).toHaveBeenCalledTimes(2)
  })

  it('refreshes tools when the server sends tools/list_changed', async () => {
    const { service, registry, factory } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')

    factory.servers[0].tools = [{ name: 'new_tool', inputSchema: { type: 'object' } }]
    await factory.servers[0].server.sendToolListChanged()

    await vi.waitFor(() => expect([...registry.keys()]).toEqual(['everything__new_tool']))
    expect(service.getStatuses()[0].toolCount).toBe(1)
    expect(registry.get('everything__new_tool')!.definition.function.description)
      .toBe('Tool "new_tool" from the "Everything" connection.')
  })

  it('pushes status changes', async () => {
    const { service, statuses } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')

    const states = statuses.map((list) => list[0]?.state)
    expect(states).toContain('connecting')
    expect(states[states.length - 1]).toBe('connected')
  })

  it('closeAll() closes every transport and unregisters every tool', async () => {
    const { service, registry, factory } = setup()
    service.applyServers([stdioServer(), stdioServer({ id: 'srv-2', name: 'Two' })])
    await waitForState(service, 'srv-1', 'connected')
    await waitForState(service, 'srv-2', 'connected')
    const spies = factory.transports.map((transport) => vi.spyOn(transport, 'close'))

    await service.closeAll()
    expect(registry.size).toBe(0)
    for (const spy of spies) expect(spy).toHaveBeenCalled()
  })
})

// ─── Tool calls ─────────────────────────────────────────────────────────────

describe('McpService tool calls', () => {
  it('calls the original tool name and flattens text results', async () => {
    const { service, registry, factory } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')

    const result = await registry.get('everything__echo')!.execute({ message: 'hi' }, null)
    expect(result).toEqual({ content: 'echo: hi' })
    expect(factory.servers[0].calls).toEqual([{ name: 'echo', args: { message: 'hi' } }])
  })

  it('returns { error, code } when the tool reports isError', async () => {
    const { service, registry } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')

    const result = await registry.get('everything__fail')!.execute({}, null)
    expect(result).toEqual({ error: 'Something broke', code: 'MCP_ERROR' })
  })

  it('throws MCP_ERROR when the connection is gone', async () => {
    const { service, registry, factory } = setup()
    activeService = service
    service.applyServers([stdioServer()])
    await waitForState(service, 'srv-1', 'connected')
    const entry = registry.get('everything__echo')!

    await factory.servers[0].server.close()
    await waitForState(service, 'srv-1', 'error')
    await expect(entry.execute({ message: 'x' }, null)).rejects.toMatchObject({ code: 'MCP_ERROR' })
  })

  describe('Strict Mode', () => {
    function dialogAnswering(response: number) {
      return { showMessageBox: vi.fn(async () => ({ response })) }
    }

    it('asks before every call and runs the tool when allowed', async () => {
      const dialog = dialogAnswering(1)
      const { service, registry, factory } = setup({ settings: { strictMode: true }, dialog })
      activeService = service
      service.applyServers([stdioServer()])
      await waitForState(service, 'srv-1', 'connected')

      const win = { id: 'window' }
      await registry.get('everything__echo')!.execute({ message: 'a' }, win as never)
      await registry.get('everything__echo')!.execute({ message: 'b' }, win as never)

      expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
      const options = (dialog.showMessageBox.mock.calls[0] as unknown[])[0] as Record<string, unknown>
      expect(options.buttons).toEqual(['Deny', 'Allow'])
      expect(options.message).toBe('The assistant wants to use "echo" from Everything')
      expect(String(options.detail)).toContain('"message": "a"')
      expect(factory.servers[0].calls).toHaveLength(2)
    })

    it('returns USER_DENIED without calling the server when denied', async () => {
      const dialog = dialogAnswering(0)
      const { service, registry, factory } = setup({ settings: { strictMode: true }, dialog })
      activeService = service
      service.applyServers([stdioServer()])
      await waitForState(service, 'srv-1', 'connected')

      await expect(registry.get('everything__echo')!.execute({ message: 'a' }, null))
        .rejects.toMatchObject({ code: 'USER_DENIED' })
      expect(factory.servers[0].calls).toHaveLength(0)
    })

    it('denies when no window is available to ask', async () => {
      const { service, registry, factory } = setup({ settings: { strictMode: true }, dialog: null })
      activeService = service
      service.applyServers([stdioServer()])
      await waitForState(service, 'srv-1', 'connected')

      await expect(registry.get('everything__echo')!.execute({ message: 'a' }, null))
        .rejects.toMatchObject({ code: 'USER_DENIED' })
      expect(factory.servers[0].calls).toHaveLength(0)
    })

    it('does not ask when Strict Mode is off', async () => {
      const dialog = dialogAnswering(0)
      const { service, registry } = setup({ settings: { strictMode: false }, dialog })
      activeService = service
      service.applyServers([stdioServer()])
      await waitForState(service, 'srv-1', 'connected')

      await registry.get('everything__echo')!.execute({ message: 'a' }, null)
      expect(dialog.showMessageBox).not.toHaveBeenCalled()
    })
  })
})

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('flattenMcpToolResult', () => {
  it('joins text blocks and summarizes non-text content', () => {
    const result = flattenMcpToolResult({
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a.txt', text: 'file body' } },
        { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAA', mimeType: 'application/octet-stream' } },
        { type: 'resource_link', uri: 'file:///c', name: 'c' }
      ]
    })
    expect(result).toEqual({
      content: [
        'first',
        '[image (image/png) not shown]',
        '[resource file:///a.txt]\nfile body',
        '[binary resource file:///b.bin (application/octet-stream) not shown]',
        '[resource link: c file:///c]'
      ].join('\n\n')
    })
  })

  it('falls back to structuredContent only when there is no text', () => {
    expect(flattenMcpToolResult({ content: [], structuredContent: { a: 1 } })).toEqual({ content: '{"a":1}' })
    expect(flattenMcpToolResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 } }))
      .toEqual({ content: 'x' })
  })

  it('maps isError to { error, code }', () => {
    expect(flattenMcpToolResult({ isError: true, content: [] }))
      .toEqual({ error: 'The tool reported an error.', code: 'MCP_ERROR' })
  })

  it('supports legacy toolResult and clips huge output', () => {
    expect(flattenMcpToolResult({ toolResult: { ok: true } })).toEqual({ content: '{"ok":true}' })
    const big = flattenMcpToolResult({ content: [{ type: 'text', text: 'x'.repeat(MAX_MCP_RESULT_CHARS + 10) }] })
    expect(String(big.content)).toMatch(/\[truncated: 10 more characters\]$/)
  })
})

describe('resolveStdioLaunch', () => {
  it('uses the .cmd shim for npx on Windows and keeps PATHEXT', () => {
    const launch = resolveStdioLaunch(
      { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: 'k' } },
      'win32',
      { PATHEXT: '.COM;.EXE;.CMD' }
    )
    expect(launch.command).toBe('npx.cmd')
    expect(launch.args).toEqual(['-y', 'pkg'])
    expect(launch.env.API_KEY).toBe('k')
    expect(launch.env.PATHEXT).toBe('.COM;.EXE;.CMD')
  })

  it('leaves other commands and explicit extensions alone', () => {
    expect(resolveStdioLaunch({ command: 'node' }, 'win32').command).toBe('node')
    expect(resolveStdioLaunch({ command: 'npx.cmd' }, 'win32').command).toBe('npx.cmd')
    expect(resolveStdioLaunch({ command: 'npx' }, 'darwin').command).toBe('npx')
  })

  it('adds common install locations to PATH on macOS/Linux', () => {
    const launch = resolveStdioLaunch({ command: 'npx' }, 'darwin')
    expect(launch.env.PATH.split(':')).toContain('/opt/homebrew/bin')
  })

  it('lets the server env override the defaults', () => {
    expect(resolveStdioLaunch({ command: 'x', env: { PATH: '/custom' } }, 'linux').env.PATH).toBe('/custom')
  })
})
