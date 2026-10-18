import { describe, it, expect } from 'vitest'
import {
  buildMcpToolName,
  joinCommandLine,
  mcpServerPrefix,
  parseKeyValueLines,
  parseMcpServersJson,
  parseMcpToolName,
  splitCommandLine
} from '../../../src/lib/mcpConfig'

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
