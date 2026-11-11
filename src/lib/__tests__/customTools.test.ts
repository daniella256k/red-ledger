import { describe, it, expect } from 'vitest'
import {
  buildCustomToolUrl,
  CustomToolArgumentError,
  CustomToolsetError,
  customToolParameters,
  formatCustomToolResult,
  isCustomToolResult,
  isLoopbackHost,
  parseToolsetJson,
  toolsetNeedsNetwork
} from '../customTools'

const FILE = {
  name: 'Library API',
  baseUrl: 'https://library.example.org/api/v1/',
  headers: { Authorization: 'Bearer ${env:LIBRARY_KEY}' },
  tools: [
    {
      name: 'search',
      description: 'Search the catalogue.',
      path: '/search',
      params: {
        q: { type: 'string', description: 'Search text', required: true },
        source: { type: 'array', description: 'Collections' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        newest: { type: 'boolean' }
      },
      fixed: { format: 'md' }
    },
    {
      name: 'get_book',
      description: 'One book.',
      path: '/books/{id}/pages/{page}',
      params: { id: {}, page: { type: 'integer' }, lang: { type: 'string' } }
    }
  ]
}

function parse(file: unknown = FILE, expand?: (text: string) => string) {
  return parseToolsetJson(JSON.stringify(file), { fallbackName: 'fallback', expand })
}

function errorOf(file: unknown): string {
  try {
    parse(file)
  } catch (err) {
    expect(err).toBeInstanceOf(CustomToolsetError)
    return (err as Error).message
  }
  throw new Error('expected the file to be rejected')
}

describe('parseToolsetJson', () => {
  it('reads a toolset, names its tools and trims the base URL', () => {
    const toolset = parse(FILE, (text) => text.replace('${env:LIBRARY_KEY}', 'secret'))
    expect(toolset.name).toBe('Library API')
    expect(toolset.prefix).toBe('library-api')
    expect(toolset.baseUrl).toBe('https://library.example.org/api/v1')
    expect(toolset.headers).toEqual({ Authorization: 'Bearer secret' })
    expect(toolset.allowLocal).toBe(false)
    expect(toolset.tools.map((tool) => tool.qualifiedName)).toEqual(['library-api__search', 'library-api__get_book'])
    expect(toolset.tools[0].fixed).toEqual({ format: 'md' })
  })

  it('uses the file name when the toolset has no name', () => {
    expect(parse({ ...FILE, name: undefined }).prefix).toBe('fallback')
  })

  it('marks path params as required and keeps the schema for the model', () => {
    const [search, getBook] = parse().tools
    expect(customToolParameters(search)).toEqual({
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search text' },
        source: { type: 'array', description: 'Collections', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        newest: { type: 'boolean' }
      },
      required: ['q']
    })
    expect(customToolParameters(getBook).required).toEqual(['id', 'page'])
    expect(getBook.params.map((param) => param.in)).toEqual(['path', 'path', 'query'])
  })

  it('says what is wrong with a bad file', () => {
    expect(errorOf('nope')).toMatch(/Expected a JSON object/)
    expect(() => parseToolsetJson('{ not json', { fallbackName: 'x' })).toThrow(/Not valid JSON/)
    expect(errorOf({ ...FILE, baseUrl: 'ftp://example.org' })).toMatch(/http:\/\/ or https:\/\//)
    expect(errorOf({ ...FILE, baseUrl: 'https://example.org/api?key=1' })).toMatch(/can't contain/)
    expect(errorOf({ ...FILE, tools: [] })).toMatch(/at least one tool/)
    expect(errorOf({ ...FILE, allowLocal: 'yes' })).toMatch(/allowLocal/)
    expect(errorOf({ ...FILE, headers: { A: 1 } })).toMatch(/Header "A"/)
    expect(errorOf({ ...FILE, tools: [{ name: 'a b', description: 'x', path: '/x' }] })).toMatch(/letters, digits/)
    expect(errorOf({ ...FILE, tools: [{ name: 'a__b', description: 'x', path: '/x' }] })).toMatch(/without "__"/)
    expect(errorOf({ ...FILE, tools: [{ name: 'a', path: '/x' }] })).toMatch(/description/)
    expect(errorOf({ ...FILE, tools: [{ name: 'a', description: 'x', path: 'x' }] })).toMatch(/start with "\/"/)
    expect(errorOf({ ...FILE, tools: [{ name: 'a', description: 'x', path: '/x/{id}' }] })).toMatch(/no such param/)
    expect(errorOf({ ...FILE, tools: [{ name: 'a', description: 'x', path: '/x', params: { p: { type: 'date' } } }] })).toMatch(/type must be/)
    expect(errorOf({ ...FILE, tools: [{ name: 'a', description: 'x', path: '/x', params: { p: {} }, fixed: { p: 1 } }] })).toMatch(/both a param and a fixed/)
    expect(errorOf({ ...FILE, tools: [FILE.tools[0], FILE.tools[0]] })).toMatch(/Two tools are named "search"/)
    expect(errorOf({ ...FILE, tools: [{ name: 'x'.repeat(60), description: 'x', path: '/x' }] })).toMatch(/longer than 64/)
  })

  it('reports a variable that can not be filled', () => {
    expect(() => parse(FILE, () => { throw new Error('Environment variable LIBRARY_KEY is not set.') }))
      .toThrow(/LIBRARY_KEY is not set/)
  })
})

describe('buildCustomToolUrl', () => {
  const toolset = parse(FILE, (text) => text)
  const [search, getBook] = toolset.tools

  it('puts params in the query string, lists comma-separated, fixed values last', () => {
    expect(buildCustomToolUrl(toolset, search, { q: 'general strike 1926', source: ['A', 'B'], limit: 5, newest: true }))
      .toBe('https://library.example.org/api/v1/search?q=general+strike+1926&source=A%2CB&limit=5&newest=true&format=md')
  })

  it('leaves out empty and unknown arguments', () => {
    expect(buildCustomToolUrl(toolset, search, { q: 'x', source: [], limit: null, extra: 'ignored' }))
      .toBe('https://library.example.org/api/v1/search?q=x&format=md')
  })

  it('fills path placeholders, encoded', () => {
    expect(buildCustomToolUrl(toolset, getBook, { id: 'das kapital/1', page: 3, lang: 'de' }))
      .toBe('https://library.example.org/api/v1/books/das%20kapital%2F1/pages/3?lang=de')
  })

  it('rejects missing and malformed arguments', () => {
    expect(() => buildCustomToolUrl(toolset, search, {})).toThrow(CustomToolArgumentError)
    expect(() => buildCustomToolUrl(toolset, search, { q: '' })).toThrow(/requires a "q" argument/)
    expect(() => buildCustomToolUrl(toolset, search, { q: ['a'] })).toThrow(/one value, not a list/)
    expect(() => buildCustomToolUrl(toolset, search, { q: { a: 1 } })).toThrow(/must be a string/)
    expect(() => buildCustomToolUrl(toolset, getBook, { id: 'x' })).toThrow(/requires a "page" argument/)
  })
})

describe('offline and local helpers', () => {
  it('recognizes loopback hosts', () => {
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '127.1.2.3', '[::1]', 'LOCALHOST.']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
    for (const host of ['example.org', '192.168.1.5', '10.0.0.1', 'localhost.example.org']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })

  it('needs the network unless the toolset is local and allowed to be', () => {
    expect(toolsetNeedsNetwork(parse())).toBe(true)
    expect(toolsetNeedsNetwork(parse({ ...FILE, baseUrl: 'http://localhost:8000/api' }))).toBe(true)
    expect(toolsetNeedsNetwork(parse({ ...FILE, baseUrl: 'http://localhost:8000/api', allowLocal: true }))).toBe(false)
    expect(toolsetNeedsNetwork(parse({ ...FILE, baseUrl: 'http://192.168.1.5/api', allowLocal: true }))).toBe(true)
  })
})

describe('custom tool results', () => {
  const result = { url: 'https://x.example/a', status: 200, content_type: 'application/json', content: '{"a":1}', total_chars: 7, truncated: false }

  it('tells its own results from MCP ones', () => {
    expect(isCustomToolResult(result)).toBe(true)
    expect(isCustomToolResult({ content: 'text' })).toBe(false)
    expect(isCustomToolResult({ error: 'x', code: 'HTTP_ERROR' })).toBe(false)
  })

  it('gives the model the body, with a note when cut short', () => {
    expect(formatCustomToolResult(result)).toBe('{"a":1}')
    expect(formatCustomToolResult({ ...result, content: '', total_chars: 0 })).toBe('(empty response)')
    expect(formatCustomToolResult({ ...result, content: 'abc', total_chars: 10, truncated: true }))
      .toMatch(/^abc\n\n\[Cut off after 3 of 10 characters/)
    expect(() => formatCustomToolResult({ content: 'x' })).toThrow()
  })
})
