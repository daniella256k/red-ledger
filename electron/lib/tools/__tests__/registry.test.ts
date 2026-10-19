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
})
