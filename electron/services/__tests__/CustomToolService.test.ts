import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CustomToolService, MAX_CUSTOM_TOOL_RESULT_CHARS, toCustomToolResult } from '../CustomToolService'
import type { ToolEntry } from '../../lib/tools/registry'
import type { ApiRequestOptions, ApiResponse } from '../SearchService'

const LIBRARY = {
  name: 'Library',
  baseUrl: 'https://library.example.org/api',
  headers: { Authorization: 'Bearer ${env:LIBRARY_KEY}' },
  tools: [
    { name: 'search', description: 'Search the catalogue.', path: '/search', params: { q: { required: true } }, fixed: { format: 'md' } },
    { name: 'stats', description: 'Counts.', path: '/stats' }
  ]
}

let folder: string
let registry: Map<string, ToolEntry>
let requests: Array<{ url: string; options: ApiRequestOptions }>
let reserved: string[]
let response: ApiResponse

function makeService(env: Record<string, string | undefined> = { LIBRARY_KEY: 'secret' }) {
  const onStatusChange = vi.fn()
  const service = new CustomToolService({
    folder,
    registerTool: (entry) => { registry.set(entry.definition.function.name, entry) },
    unregisterTool: (name) => { registry.delete(name) },
    request: async (url, options) => {
      requests.push({ url, options })
      return response
    },
    getReservedPrefixes: () => reserved,
    onStatusChange,
    env
  })
  return { service, onStatusChange }
}

function writeTools(file: string, content: unknown): void {
  writeFileSync(join(folder, file), typeof content === 'string' ? content : JSON.stringify(content))
}

beforeEach(() => {
  folder = join(mkdtempSync(join(tmpdir(), 'rl-tools-')), 'tools')
  registry = new Map()
  requests = []
  reserved = []
  response = { url: 'https://library.example.org/api/search?q=x&format=md', status: 200, contentType: 'text/markdown', text: '# Results' }
})

afterEach(() => {
  rmSync(join(folder, '..'), { recursive: true, force: true })
})

describe('CustomToolService', () => {
  it('creates the folder and reports nothing when it is empty', () => {
    const { service, onStatusChange } = makeService()
    const status = service.reload()
    expect(existsSync(folder)).toBe(true)
    expect(status).toEqual({ folder, toolsets: [] })
    expect(onStatusChange).toHaveBeenCalledWith(status)
  })

  it('registers each tool of a file as a custom tool', () => {
    const { service } = makeService()
    service.ensureFolder()
    writeTools('library.json', LIBRARY)
    writeTools('notes.txt', 'not a tool file')

    const status = service.reload()
    expect(status.toolsets).toEqual([{
      file: 'library.json',
      name: 'Library',
      prefix: 'library',
      baseUrl: 'https://library.example.org/api',
      tools: [
        { name: 'search', description: 'Search the catalogue.' },
        { name: 'stats', description: 'Counts.' }
      ]
    }])
    expect([...registry.keys()]).toEqual(['library__search', 'library__stats'])
    const entry = registry.get('library__search')!
    expect(entry.source).toBe('custom')
    expect(entry.network).toBe(true)
    expect(entry.definition.function.parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q']
    })
  })

  it('sends the call with the toolset headers and returns the body', async () => {
    const { service } = makeService()
    service.ensureFolder()
    writeTools('library.json', LIBRARY)
    service.reload()

    const controller = new AbortController()
    const entry = registry.get('library__search')!
    const result = await entry.execute({ q: 'strike wave' }, { win: null, workspace: null as never, signal: controller.signal })

    expect(requests).toEqual([{
      url: 'https://library.example.org/api/search?q=strike+wave&format=md',
      options: { headers: { Authorization: 'Bearer secret' }, signal: controller.signal }
    }])
    expect(result).toEqual({
      url: response.url,
      status: 200,
      content_type: 'text/markdown',
      content: '# Results',
      total_chars: 9,
      truncated: false
    })
    expect(entry.formatForModel!(result)).toBe('# Results')
    await expect(entry.execute({}, { win: null, workspace: null as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('lets a local toolset reach its own host and work offline', async () => {
    const { service } = makeService()
    service.ensureFolder()
    writeTools('dev.json', { baseUrl: 'http://localhost:8000/api', allowLocal: true, tools: [{ name: 'ping', description: 'Ping.', path: '/ping' }] })
    const status = service.reload()

    expect(status.toolsets[0]).toMatchObject({ name: 'dev', prefix: 'dev', allowLocal: true })
    const entry = registry.get('dev__ping')!
    expect(entry.network).toBe(false)
    await entry.execute({}, { win: null, workspace: null as never })
    expect(requests[0]).toEqual({ url: 'http://localhost:8000/api/ping', options: { headers: {}, allowLocalHost: 'localhost' } })
  })

  it('reports a bad file and still loads the others', () => {
    const { service } = makeService({})
    service.ensureFolder()
    writeTools('a-broken.json', '{ not json')
    writeTools('b-library.json', LIBRARY)
    writeTools('c-stats.json', { name: 'Stats', baseUrl: 'https://stats.example.org', tools: [{ name: 'all', description: 'All.', path: '/all' }] })

    const { toolsets } = service.reload()
    expect(toolsets.map((toolset) => toolset.file)).toEqual(['a-broken.json', 'b-library.json', 'c-stats.json'])
    expect(toolsets[0]).toMatchObject({ name: 'a-broken', tools: [] })
    expect(toolsets[0].error).toMatch(/Not valid JSON/)
    // The key's environment variable is not set here.
    expect(toolsets[1].error).toMatch(/LIBRARY_KEY is not set/)
    expect(toolsets[2].error).toBeUndefined()
    expect([...registry.keys()]).toEqual(['stats__all'])
  })

  it('refuses a name another file or a connection already uses', () => {
    const { service } = makeService()
    service.ensureFolder()
    writeTools('a.json', LIBRARY)
    writeTools('b.json', { ...LIBRARY, tools: [LIBRARY.tools[1]] })
    writeTools('c.json', { name: 'Files', baseUrl: 'https://files.example.org', tools: [{ name: 'list', description: 'List.', path: '/list' }] })
    reserved = ['files']

    const { toolsets } = service.reload()
    expect(toolsets[0].error).toBeUndefined()
    expect(toolsets[1].error).toMatch(/"library__", which "a\.json" already uses/)
    expect(toolsets[2].error).toMatch(/"files__", which a connection in Settings already uses/)
    expect([...registry.keys()]).toEqual(['library__search', 'library__stats'])
  })

  it('drops the tools of a removed file and reloads when connections take a name', () => {
    const { service, onStatusChange } = makeService()
    service.ensureFolder()
    writeTools('library.json', LIBRARY)
    service.reload()
    expect(registry.size).toBe(2)

    // Nothing changed: no reload.
    onStatusChange.mockClear()
    service.syncReservedPrefixes()
    expect(onStatusChange).not.toHaveBeenCalled()

    reserved = ['library']
    service.syncReservedPrefixes()
    expect(onStatusChange).toHaveBeenCalledTimes(1)
    expect(registry.size).toBe(0)

    reserved = []
    rmSync(join(folder, 'library.json'))
    expect(service.reload().toolsets).toEqual([])
    expect(registry.size).toBe(0)
  })
})

describe('toCustomToolResult', () => {
  it('clips a long body and says so', () => {
    const text = 'x'.repeat(MAX_CUSTOM_TOOL_RESULT_CHARS + 50)
    const result = toCustomToolResult({ url: 'https://x.example/', status: 200, contentType: 'application/json', text })
    expect(result.content.length).toBe(MAX_CUSTOM_TOOL_RESULT_CHARS)
    expect(result.total_chars).toBe(text.length)
    expect(result.truncated).toBe(true)
  })
})
