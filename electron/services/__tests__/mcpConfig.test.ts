import { describe, it, expect } from 'vitest'
import {
  assignMcpServerPrefixes,
  buildMcpToolName,
  expandMcpVariables,
  findMcpServerByPrefix,
  joinCommandLine,
  MCP_SECRET_MASK,
  mcpServerPrefix,
  parseKeyValueLines,
  parseMcpServersJson,
  parseMcpToolName,
  resolveMcpServerConfig,
  restoreMaskedSecrets,
  sanitizeMcpOAuth,
  serializeMcpServersJson,
  splitCommandLine
} from '../../../src/lib/mcpConfig'
import type { McpServerConfig } from '../../../src/types'

describe('MCP tool names', () => {
  it('slugifies server names without ever producing the separator', () => {
    expect(mcpServerPrefix('My Files')).toBe('my-files')
    expect(mcpServerPrefix('a__b')).toBe('a_b')
    expect(mcpServerPrefix('  ')).toBe('mcp')
    expect(mcpServerPrefix('Ünïcode ✓')).toBe('n-code')
  })

  it('builds names within the 64 character limit', () => {
    const name = buildMcpToolName('server', `tool.${'x'.repeat(100)}`)
    expect(name.startsWith('server__tool_')).toBe(true)
    expect(name.length).toBe(64)
  })

  it('round-trips through parseMcpToolName', () => {
    expect(parseMcpToolName(buildMcpToolName('everything', 'echo'))).toEqual({ server: 'everything', tool: 'echo' })
    expect(parseMcpToolName('x___private')).toEqual({ server: 'x', tool: '_private' })
    expect(parseMcpToolName('read_file')).toBeNull()
    expect(parseMcpToolName('__x')).toBeNull()
  })
})

describe('command lines', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommandLine('npx -y @modelcontextprotocol/server-everything'))
      .toEqual(['npx', '-y', '@modelcontextprotocol/server-everything'])
    expect(splitCommandLine('node "C:\\My Tools\\server.js" --name \'a b\' ""'))
      .toEqual(['node', 'C:\\My Tools\\server.js', '--name', 'a b', ''])
    expect(splitCommandLine('   ')).toEqual([])
  })

  it('joins back to an equivalent command line', () => {
    const line = joinCommandLine('node', ['C:\\My Tools\\server.js', '--flag'])
    expect(line).toBe('node "C:\\My Tools\\server.js" --flag')
    expect(splitCommandLine(line)).toEqual(['node', 'C:\\My Tools\\server.js', '--flag'])
  })
})

describe('parseKeyValueLines', () => {
  it('parses env and header lines, skipping blanks and comments', () => {
    expect(parseKeyValueLines('A=1\n\n# note\nB = two=2\nbad', '=')).toEqual({ A: '1', B: 'two=2' })
    expect(parseKeyValueLines('Authorization: Bearer abc:def', ':')).toEqual({ Authorization: 'Bearer abc:def' })
  })
})

describe('parseMcpServersJson', () => {
  it('parses the common mcpServers config format', () => {
    const result = parseMcpServersJson(JSON.stringify({
      mcpServers: {
        everything: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
        remote: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-Key': 'k' } },
        off: { command: 'node', args: ['s.js'], env: { A: '1' }, disabled: true }
      }
    }))

    expect(result.errors).toEqual([])
    expect(result.servers).toEqual([
      { name: 'everything', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: undefined, enabled: true },
      { name: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { 'X-Key': 'k' }, enabled: true },
      { name: 'off', transport: 'stdio', command: 'node', args: ['s.js'], env: { A: '1' }, enabled: false }
    ])
  })

  it('accepts VS Code "servers", a bare map, and a single server object', () => {
    expect(parseMcpServersJson('{"servers":{"a":{"command":"node"}}}').servers[0].name).toBe('a')
    expect(parseMcpServersJson('{"b":{"url":"https://x"}}').servers[0].transport).toBe('http')
    expect(parseMcpServersJson('{"name":"c","command":"node","args":["x"]}').servers[0].name).toBe('c')
  })

  it('splits a whole command line given in "command"', () => {
    const [server] = parseMcpServersJson('{"mcpServers":{"a":{"command":"npx -y pkg"}}}').servers
    expect(server.command).toBe('npx')
    expect(server.args).toEqual(['-y', 'pkg'])
  })

  it('reports invalid JSON and unusable entries', () => {
    expect(parseMcpServersJson('{nope').errors[0]).toMatch(/Not valid JSON/)
    expect(parseMcpServersJson('[]').errors[0]).toMatch(/Expected a JSON object/)
    const result = parseMcpServersJson('{"mcpServers":{"a":{"args":[]},"b":{"type":"http","command":"x"}}}')
    expect(result.servers).toEqual([])
    expect(result.errors).toHaveLength(2)
    expect(parseMcpServersJson('{"mcpServers":{}}').errors[0]).toMatch(/No servers/)
  })
})

describe('server prefixes', () => {
  const servers: McpServerConfig[] = [
    { id: 'a', name: 'Files', transport: 'stdio', command: 'node', enabled: true },
    { id: 'b', name: 'off', transport: 'stdio', command: 'node', enabled: false },
    { id: 'c', name: 'files', transport: 'http', url: 'https://x', enabled: true }
  ]

  it('suffixes enabled servers whose names collide and skips disabled ones', () => {
    expect([...assignMcpServerPrefixes(servers)]).toEqual([['a', 'files'], ['c', 'files-2']])
  })

  it('finds the server behind a suffixed prefix', () => {
    expect(findMcpServerByPrefix(servers, 'files')?.id).toBe('a')
    expect(findMcpServerByPrefix(servers, 'files-2')?.id).toBe('c')
    // Disabled servers still resolve by name, for tool calls in older chats.
    expect(findMcpServerByPrefix(servers, 'off')?.id).toBe('b')
    expect(findMcpServerByPrefix(servers, 'nope')).toBeUndefined()
  })
})

describe('JSON view', () => {
  const servers: McpServerConfig[] = [
    { id: '1', name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: 'secret', EMPTY: '' }, enabled: true },
    { id: '2', name: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' }, enabled: false },
    { id: '3', name: 'Local', transport: 'stdio', command: 'node', enabled: true }
  ]

  it('serializes to the mcpServers shape, masking env and header values', () => {
    expect(JSON.parse(serializeMcpServersJson(servers, { maskSecrets: true }))).toEqual({
      mcpServers: {
        local: { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: MCP_SECRET_MASK, EMPTY: '' } },
        remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: MCP_SECRET_MASK }, disabled: true },
        'Local (2)': { command: 'node' }
      }
    })
  })

  it('round-trips unmasked JSON through Paste JSON parsing', () => {
    const parsed = parseMcpServersJson(serializeMcpServersJson(servers, { maskSecrets: false }))
    expect(parsed.errors).toEqual([])
    expect(parsed.servers.map(({ name, enabled }) => [name, enabled])).toEqual([['local', true], ['remote', false], ['Local (2)', true]])
    expect(parsed.servers[0].env).toEqual({ API_KEY: 'secret', EMPTY: '' })
    expect(parsed.servers[1].headers).toEqual({ Authorization: 'Bearer t' })
  })

  it('restores masked values and keeps edited ones', () => {
    const json = JSON.parse(serializeMcpServersJson(servers, { maskSecrets: true }))
    json.mcpServers.local.env.NEW = 'typed'
    json.mcpServers.remote.headers = { authorization: MCP_SECRET_MASK }
    const { servers: restored, unresolved } = restoreMaskedSecrets(parseMcpServersJson(JSON.stringify(json)).servers, servers)
    expect(unresolved).toEqual([])
    expect(restored[0].env).toEqual({ API_KEY: 'secret', EMPTY: '', NEW: 'typed' })
    expect(restored[1].headers).toEqual({ authorization: 'Bearer t' })
  })

  it('reports masks with no saved value behind them', () => {
    const json = { mcpServers: { renamed: { command: 'npx', env: { API_KEY: MCP_SECRET_MASK } } } }
    const { unresolved } = restoreMaskedSecrets(parseMcpServersJson(JSON.stringify(json)).servers, servers)
    expect(unresolved).toEqual(['"renamed": API_KEY'])
  })

  it('round-trips switched-off tools', () => {
    const json = serializeMcpServersJson([
      { id: '1', name: 'files', transport: 'stdio', command: 'npx', disabledTools: ['delete_file'], enabled: true }
    ], { maskSecrets: true })
    expect(JSON.parse(json).mcpServers.files.disabledTools).toEqual(['delete_file'])
    expect(parseMcpServersJson(json).servers[0].disabledTools).toEqual(['delete_file'])
  })

  it('allows an empty server list when asked', () => {
    expect(parseMcpServersJson('{"mcpServers":{}}', { allowEmpty: true })).toEqual({ servers: [], errors: [] })
  })
})

describe('expandMcpVariables', () => {
  const context = {
    workspaceFolder: '/work/my-project',
    userHome: '/home/me',
    pathSeparator: '/',
    env: { TOKEN: 'abc', EMPTY: '' } as Record<string, string | undefined>
  }

  it('fills in workspace, home, separator and environment variables', () => {
    expect(expandMcpVariables('${workspaceFolder}/src', context)).toBe('/work/my-project/src')
    expect(expandMcpVariables('${workspaceFolderBasename}', context)).toBe('my-project')
    expect(expandMcpVariables('${userHome}${/}x${pathSeparator}y', context)).toBe('/home/me/x/y')
    expect(expandMcpVariables('Bearer ${env:TOKEN}', context)).toBe('Bearer abc')
    expect(expandMcpVariables('${TOKEN}', context)).toBe('abc')
    expect(expandMcpVariables('no variables', context)).toBe('no variables')
  })

  it('uses :- fallbacks for missing or empty values', () => {
    expect(expandMcpVariables('${env:PORT:-8080}', context)).toBe('8080')
    expect(expandMcpVariables('${EMPTY:-x}', context)).toBe('x')
    expect(expandMcpVariables('[${EMPTY}]', context)).toBe('[]')
    expect(expandMcpVariables('${workspaceFolder:-/tmp}', { ...context, workspaceFolder: null })).toBe('/tmp')
  })

  it('explains what could not be filled in', () => {
    expect(() => expandMcpVariables('${workspaceFolder}', { ...context, workspaceFolder: null })).toThrow(/no workspace folder is open/)
    expect(() => expandMcpVariables('${env:MISSING}', context)).toThrow('Environment variable MISSING is not set (used as ${env:MISSING}).')
    expect(() => expandMcpVariables('${input:key}', context)).toThrow('Unknown variable ${input:key}.')
  })

  it('resolves every field of a server config', () => {
    const resolved = resolveMcpServerConfig({
      id: '1',
      name: 'x',
      transport: 'http',
      url: 'https://${env:TOKEN}.example.com/mcp',
      headers: { 'X-Key': '${TOKEN}' },
      oauth: { clientSecret: '${env:TOKEN}', callbackPort: 7777 },
      enabled: true
    }, context)
    expect(resolved).toEqual({
      id: '1',
      name: 'x',
      transport: 'http',
      url: 'https://abc.example.com/mcp',
      headers: { 'X-Key': 'abc' },
      oauth: { clientSecret: 'abc', callbackPort: 7777 },
      enabled: true
    })
  })
})

describe('OAuth and working folder config', () => {
  it('sanitizes OAuth options, accepting snake_case', () => {
    expect(sanitizeMcpOAuth({ client_id: ' id ', callback_port: '8123', scope: '' })).toEqual({ clientId: 'id', callbackPort: 8123 })
    expect(sanitizeMcpOAuth({ callbackPort: 70000 })).toBeUndefined()
    expect(sanitizeMcpOAuth('nope')).toBeUndefined()
  })

  it('reads cwd and oauth from pasted JSON', () => {
    const { servers } = parseMcpServersJson(JSON.stringify({
      mcpServers: {
        files: { command: 'npx', args: ['pkg'], cwd: '${workspaceFolder}' },
        gh: { type: 'http', url: 'https://x/mcp', oauth: { clientId: 'app', callbackPort: 9000 } }
      }
    }))
    expect(servers[0].cwd).toBe('${workspaceFolder}')
    expect(servers[1].oauth).toEqual({ clientId: 'app', callbackPort: 9000 })
  })

  it('masks the client secret but not values that only reference variables', () => {
    const servers: McpServerConfig[] = [
      { id: '1', name: 'gh', transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${env:GH_TOKEN}' }, oauth: { clientId: 'app', clientSecret: 'shh' }, enabled: true },
      { id: '2', name: 'files', transport: 'stdio', command: 'npx', env: { KEY: '${KEY}', RAW: 'raw' }, cwd: '~/code', enabled: true }
    ]
    const json = JSON.parse(serializeMcpServersJson(servers, { maskSecrets: true }))
    expect(json.mcpServers.gh.headers).toEqual({ Authorization: 'Bearer ${env:GH_TOKEN}' })
    expect(json.mcpServers.gh.oauth).toEqual({ clientId: 'app', clientSecret: MCP_SECRET_MASK })
    expect(json.mcpServers.files.env).toEqual({ KEY: '${KEY}', RAW: MCP_SECRET_MASK })
    expect(json.mcpServers.files.cwd).toBe('~/code')

    const { servers: restored, unresolved } = restoreMaskedSecrets(parseMcpServersJson(JSON.stringify(json)).servers, servers)
    expect(unresolved).toEqual([])
    expect(restored[0].oauth).toEqual({ clientId: 'app', clientSecret: 'shh' })
    expect(restored[1].env).toEqual({ KEY: '${KEY}', RAW: 'raw' })
  })
})
