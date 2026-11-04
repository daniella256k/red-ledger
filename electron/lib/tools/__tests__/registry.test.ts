import { describe, it, expect, beforeEach } from 'vitest'

// We test the registry in isolation — don't import the self-registering tool files
// since they depend on Electron. Instead, test the registry API directly.

// Reset module state for each test by re-importing
let registerTool: typeof import('../registry').registerTool
let getToolDefinitions: typeof import('../registry').getToolDefinitions
let dispatchTool: typeof import('../registry').dispatchTool

beforeEach(async () => {
  // Clear the module cache so the registry starts empty
  const mod = await import('../registry')
  registerTool = mod.registerTool
  getToolDefinitions = mod.getToolDefinitions
  dispatchTool = mod.dispatchTool
})

describe('tool registry', () => {
  it('getToolDefinitions returns registered tool definitions', () => {
    registerTool({
      definition: {
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      },
      execute: async () => ({ ok: true })
    })

    const defs = getToolDefinitions()
    const names = defs.map((d) => d.function.name)
    expect(names).toContain('test_tool')
  })

  it('dispatchTool calls the registered executor', async () => {
    registerTool({
      definition: {
        type: 'function',
        function: {
          name: 'echo',
          description: 'Echo args',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      },
      execute: async (args) => ({ echoed: args })
    })

    const result = await dispatchTool(
      { id: 'tc1', name: 'echo', arguments: { msg: 'hello' } },
      { win: null, workspace: null as never }
    )
    expect(result).toEqual({ echoed: { msg: 'hello' } })
  })

  it('dispatchTool throws for unknown tool', async () => {
    await expect(
      dispatchTool({ id: 'tc1', name: 'nonexistent', arguments: {} }, { win: null, workspace: null as never })
    ).rejects.toThrow('Unknown tool: nonexistent')
  })

  it('formats results with the tool\'s own formatter, falling back to JSON', async () => {
    const { formatToolResultForModel } = await import('../registry')
    registerTool({
      definition: {
        type: 'function',
        function: { name: 'shouty', description: 'Formats loudly', parameters: { type: 'object', properties: {} } }
      },
      execute: async () => ({}),
      formatForModel: (result) => {
        const { word } = result as { word?: string }
        if (!word) throw new Error('unexpected shape')
        return word.toUpperCase()
      }
    })

    expect(formatToolResultForModel('shouty', { word: 'strike' })).toBe('STRIKE')
    // Errors stay JSON so every tool reports them alike.
    expect(formatToolResultForModel('shouty', { error: 'boom', code: 'UNKNOWN' })).toBe('{"error":"boom","code":"UNKNOWN"}')
    // A shape the formatter can't read (e.g. saved by an older version) falls back to JSON.
    expect(formatToolResultForModel('shouty', { other: 1 })).toBe('{"other":1}')
    expect(formatToolResultForModel('no_formatter', { a: 1 })).toBe('{"a":1}')
    expect(formatToolResultForModel('no_formatter', undefined)).toBe('null')
  })
})

describe('tool order', () => {
  it('keeps built-in tools first and MCP tools sorted, however they were registered', async () => {
    const { registerTool: register, unregisterTool, getToolDefinitions: definitions } = await import('../registry')
    const tool = (name: string) => ({
      definition: { type: 'function' as const, function: { name, description: name, parameters: { type: 'object' as const } } },
      execute: async () => ({})
    })
    register(tool('zeta_server__search'))
    register(tool('order_builtin'))
    register(tool('alpha_server__read'))
    const before = definitions().map((d) => d.function.name).filter((n) => ['zeta_server__search', 'order_builtin', 'alpha_server__read'].includes(n))
    expect(before).toEqual(['order_builtin', 'alpha_server__read', 'zeta_server__search'])

    // A reconnecting server re-registers its tools; the order stays the same.
    unregisterTool('alpha_server__read')
    register(tool('alpha_server__read'))
    const after = definitions().map((d) => d.function.name).filter((n) => before.includes(n))
    expect(after).toEqual(before)
  })
})
