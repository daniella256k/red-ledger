import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'
import { lookup } from 'node:dns/promises'
import { SearchService, SearchError, sliceDocument } from '../SearchService'
import { extractPdfTextFromBuffer } from '../PdfAttachmentService'

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}))

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn()
}))

vi.mock('../PdfAttachmentService', () => ({
  extractPdfTextFromBuffer: vi.fn()
}))

const mockedAxios = vi.mocked(axios, true)
const mockedLookup = vi.mocked(lookup)
const mockedPdfText = vi.mocked(extractPdfTextFromBuffer)

const PARAGRAPH = 'Workers at the plant voted to join the union after a long campaign over pay, scheduling and safety. '
  + 'Organizers knocked on doors for months and held meetings in break rooms and parking lots. '

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8') {
  return { data: Buffer.from(html, 'utf8'), headers: { 'content-type': contentType }, status: 200 }
}

/** The error a fetchUrl call rejects with. */
async function fetchError(service: SearchService, url: string): Promise<SearchError> {
  const err = await service.fetchUrl(url).then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(SearchError)
  return err as SearchError
}

describe('SearchService.fetchUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)
  })

  it('returns the main content as Markdown with absolute links, without the site navigation', async () => {
    mockedAxios.get.mockResolvedValueOnce(htmlResponse(`<!doctype html>
      <html>
        <head>
          <title>Union Wins Vote | Daily News</title>
          <meta property="og:title" content="Union Wins Vote">
          <meta property="og:site_name" content="Daily News">
          <meta property="article:published_time" content="2026-10-20T09:00:00Z">
        </head>
        <body>
          <nav><a href="/">Home</a> <a href="/sports">Sports desk</a></nav>
          <header><p>Subscribe today for full access</p></header>
          <article>
            <h1>Union Wins Vote</h1>
            <p>${PARAGRAPH}</p>
            <h2>What comes next</h2>
            <p>${PARAGRAPH} Read the <a href="/stories/contract#terms">contract talks story</a> for more.</p>
            <p>${PARAGRAPH}</p>
          </article>
          <footer><p>Copyright Daily News corporate footer</p></footer>
        </body>
      </html>`))

    const service = new SearchService(() => ({} as never))
    const result = await service.fetchUrl('https://news.example.org/story', 20_000)

    expect(result).toMatchObject({
      url: 'https://news.example.org/story',
      title: 'Union Wins Vote',
      site_name: 'Daily News',
      published: '2026-10-20T09:00:00Z',
      content_type: 'text/html',
      extraction: 'article',
      start_index: 0,
      truncated: false
    })
    expect(result.content).toContain('## What comes next')
    expect(result.content).toContain('[contract talks story](https://news.example.org/stories/contract)')
    expect(result.content).not.toContain('Sports desk')
    expect(result.content).not.toContain('corporate footer')
    expect(result).not.toHaveProperty('links')
    expect(result).not.toHaveProperty('next_start_index')

    const requestConfig = mockedAxios.get.mock.calls[0]?.[1] as {
      responseType?: string
      headers?: Record<string, string>
      lookup?: (
        hostname: string,
        options: { all?: boolean },
        cb: (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void
      ) => void
    } | undefined

    expect(requestConfig?.responseType).toBe('arraybuffer')
    expect(requestConfig?.headers?.['User-Agent']).toMatch(/^RedLedger\//)
    expect(typeof requestConfig?.lookup).toBe('function')

    const pinnedResult = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      requestConfig?.lookup?.('news.example.org', {}, (err, address, family) => {
        if (err) {
          reject(err)
          return
        }
        if (typeof address !== 'string' || typeof family !== 'number') {
          reject(new Error('Expected a single pinned lookup result'))
          return
        }
        resolve({ address, family })
      })
    })

    expect(pinnedResult).toEqual({
      address: '93.184.216.34',
      family: 4
    })
  })

  it('reads a page with no article as the whole page minus navigation, keeping its links', async () => {
    mockedAxios.get.mockResolvedValueOnce(htmlResponse(`<!doctype html>
      <html>
        <head><title>Local 12</title></head>
        <body>
          <nav><a href="/about">About the site menu</a></nav>
          <main>
            <h2><a href="/campaigns/one">Campaign One</a></h2>
            <p><a href="https://example.com/stories/two">Frontpage Two</a></p>
            <p><a href="/stories/query?a=1&amp;b=2">Frontpage Query</a></p>
            <p><a href="#top">Jump Link</a></p>
            <p><a href="javascript:void(0)">Script Link</a></p>
            <p><a href="mailto:tips@example.com">Send Tip</a></p>
            <p>Meetings every Thursday at the hall. Bring a coworker and your questions about the contract.</p>
            <p>Valid copyright: &#169; Invalid entity: &#9999999999999;</p>
          </main>
        </body>
      </html>`))

    const service = new SearchService(() => ({} as never))
    const result = await service.fetchUrl('https://local12.example.org/')

    expect(result.extraction).toBe('page')
    expect(result.title).toBe('Local 12')
    expect(result.content).toContain('## [Campaign One](https://local12.example.org/campaigns/one)')
    expect(result.content).toContain('[Frontpage Two](https://example.com/stories/two)')
    expect(result.content).toContain('[Frontpage Query](https://local12.example.org/stories/query?a=1&b=2)')
    expect(result.content).toContain('[Send Tip](mailto:tips@example.com)')
    expect(result.content).toContain('Jump Link')
    expect(result.content).not.toContain('#top')
    expect(result.content).toContain('Script Link')
    expect(result.content).not.toContain('javascript:')
    expect(result.content).toContain('Valid copyright: ©')
    expect(result.content).not.toContain('About the site menu')
  })

  it('turns data tables into Markdown tables', async () => {
    mockedAxios.get.mockResolvedValueOnce(htmlResponse(`<html><body><main>
      <p>Union membership rates by year, from the annual release. Figures are percentages of wage and salary workers.</p>
      <table>
        <thead><tr><th>Year</th><th>Rate</th></tr></thead>
        <tbody>
          <tr><td>2024</td><td>9.9</td></tr>
          <tr><td>2025</td><td>10.1</td></tr>
        </tbody>
      </table>
    </main></body></html>`))

    const service = new SearchService(() => ({} as never))
    const result = await service.fetchUrl('https://stats.example.gov/union')

    expect(result.content).toContain('| Year | Rate |\n| --- | --- |\n| 2024 | 9.9 |\n| 2025 | 10.1 |')
  })

  it('reads long documents one part at a time without downloading them again', async () => {
    const text = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: ${'word '.repeat(10).trim()}`).join('\n')
    mockedAxios.get.mockResolvedValueOnce(htmlResponse(text, 'text/plain'))

    const service = new SearchService(() => ({} as never))
    const first = await service.fetchUrl('https://example.com/notes.txt', 1_000)

    expect(first.extraction).toBe('text')
    expect(first.title).toBe('notes.txt')
    expect(first.truncated).toBe(true)
    expect(first.total_chars).toBe(text.length)
    expect(first.content.length).toBeLessThanOrEqual(1_000)
    expect(first.content.endsWith('word')).toBe(true)
    expect(first.next_start_index).toBe(first.end_index)

    const second = await service.fetchUrl('https://example.com/notes.txt#part', 1_000, first.next_start_index)

    expect(mockedAxios.get).toHaveBeenCalledTimes(1)
    expect(second.start_index).toBe(first.next_start_index)
    expect(second.content.startsWith('Line ')).toBe(true)
    expect(second.content).toBe(text.slice(first.end_index, second.end_index).trimEnd())
  })

  it('reads PDFs, even when the server labels them as generic binary data', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from('%PDF-1.7\n...binary...', 'latin1'),
      headers: { 'content-type': 'application/octet-stream' },
      status: 200
    })
    mockedPdfText.mockResolvedValueOnce('Collective Bargaining Agreement\n\nArticle 1. Recognition')

    const service = new SearchService(() => ({} as never))
    const result = await service.fetchUrl('https://union.example.org/files/2025%20CBA.pdf')

    expect(mockedPdfText).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      title: '2025 CBA.pdf',
      extraction: 'pdf',
      content: 'Collective Bargaining Agreement\n\nArticle 1. Recognition'
    })
  })

  it('decodes text in the charset the server declares', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      headers: { 'content-type': 'text/plain; charset=windows-1252' },
      status: 200
    })

    const service = new SearchService(() => ({} as never))
    const result = await service.fetchUrl('https://example.com/menu.txt')

    expect(result.content).toBe('café')
  })

  it('rejects content it cannot read with an UNSUPPORTED_TYPE code', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      headers: { 'content-type': 'image/png' },
      status: 200
    })

    const err = await fetchError(new SearchService(() => ({} as never)), 'https://example.com/chart.png')

    expect(err.code).toBe('UNSUPPORTED_TYPE')
    expect(err.message).toContain('image/png')
  })

  it('reports a refused request with its HTTP status and that retrying will not help', async () => {
    mockedAxios.get.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 403'), {
      code: 'ERR_BAD_REQUEST',
      response: { status: 403 }
    }))

    const err = await fetchError(new SearchService(() => ({} as never)), 'https://paywalled.example.com/story')

    expect(err).toMatchObject({ code: 'HTTP_ERROR', status: 403, retryable: false })
    expect(err.message).toContain('paywalled.example.com returned HTTP 403')
    expect(err.message).toContain('try another source')
  })

  it('reports a timeout as retryable', async () => {
    mockedAxios.get.mockRejectedValueOnce(Object.assign(new Error('timeout of 20000ms exceeded'), {
      code: 'ECONNABORTED'
    }))

    const err = await fetchError(new SearchService(() => ({} as never)), 'https://slow.example.com/')

    expect(err).toMatchObject({ code: 'TIMEOUT', retryable: true })
  })

  it('rejects localhost fetches before making a request', async () => {
    const service = new SearchService(() => ({} as never))

    const err = await fetchError(service, 'http://localhost:11434/api/tags')

    expect(err.code).toBe('BLOCKED_HOST')
    expect(err.message).toBe('Refusing to fetch local or private network resources')
    expect(mockedAxios.get).not.toHaveBeenCalled()
    expect(mockedLookup).not.toHaveBeenCalled()
  })

  it('rejects IPv4-mapped IPv6 loopback in either notation', async () => {
    const service = new SearchService(() => ({} as never))

    for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[64:ff9b::a00:1]/']) {
      const err = await fetchError(service, url)
      expect(err.code).toBe('BLOCKED_HOST')
    }
    expect(mockedAxios.get).not.toHaveBeenCalled()
  })

  it('rejects domains that resolve to private IP ranges', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.25', family: 4 }] as never)

    const service = new SearchService(() => ({} as never))

    await expect(service.fetchUrl('https://intranet.example.com/')).rejects.toThrow(
      'Refusing to fetch local or private network resources'
    )
    expect(mockedAxios.get).not.toHaveBeenCalled()
  })

  it('revalidates redirects and blocks redirects into private hosts', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 302,
      headers: {
        location: 'http://127.0.0.1:8080/admin'
      },
      data: ''
    })

    const service = new SearchService(() => ({} as never))

    await expect(service.fetchUrl('https://example.com/redirect')).rejects.toThrow(
      'Refusing to fetch local or private network resources'
    )
    expect(mockedAxios.get).toHaveBeenCalledTimes(1)
  })

  it('refuses redirects to anything but http(s)', async () => {
    for (const location of ['file:///etc/passwd', 'data:text/plain,hello', 'ftp://example.com/file']) {
      mockedAxios.get.mockReset()
      mockedAxios.get.mockResolvedValueOnce({ status: 301, headers: { location }, data: '' })
      const service = new SearchService(() => ({} as never))

      await expect(service.fetchUrl('https://example.com/moved')).rejects.toMatchObject({ code: 'INVALID_URL' })
      expect(mockedAxios.get).toHaveBeenCalledTimes(1)
    }
  })
})

describe('sliceDocument', () => {
  it('returns a short document whole', () => {
    expect(sliceDocument('Short text.', 0, 1_000)).toEqual({
      content: 'Short text.',
      start_index: 0,
      end_index: 11,
      total_chars: 11,
      truncated: false
    })
  })

  it('ends a part at a paragraph break when one falls near the limit', () => {
    const text = `${'a'.repeat(800)}\n\n${'b'.repeat(400)}`
    const part = sliceDocument(text, 0, 1_000)

    expect(part.content).toBe('a'.repeat(800))
    expect(part.next_start_index).toBe(802)
    expect(sliceDocument(text, 802, 1_000).content).toBe('b'.repeat(400))
  })

  it('says when start_index is past the end', () => {
    expect(sliceDocument('abc', 10, 1_000)).toMatchObject({
      content: '',
      truncated: false,
      note: 'start_index 10 is past the end of the document (3 characters).'
    })
  })
})

describe('SearchService.search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('searches Tavily with the key in an Authorization header and returns one result shape', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        results: [
          { title: 'Strike Ends', url: 'https://www.news.example.com/strike?x=1', content: 'Workers   returned\nafter a deal.', published_date: 'Mon, 20 Oct 2025 14:00:00 GMT' },
          { title: 'Duplicate', url: 'https://www.news.example.com/strike?x=1', content: 'Same page again.' },
          { title: 'Not a page', url: 'javascript:alert(1)', content: 'Dropped.' },
          { title: '', url: 'https://local12.example.org/', content: 'Hall meeting Thursday.' }
        ]
      }
    })

    const service = new SearchService(() => ({ tavilyApiKey: 'tvly-test', serpApiKey: '' } as never))
    const response = await service.search('strike deal', 5)

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      { query: 'strike deal', max_results: 5, search_depth: 'basic', topic: 'general' },
      { timeout: 15_000, headers: { Authorization: 'Bearer tvly-test' } }
    )
    expect(response).toEqual({
      query: 'strike deal',
      backend: 'tavily',
      results: [
        {
          title: 'Strike Ends',
          url: 'https://www.news.example.com/strike?x=1',
          domain: 'news.example.com',
          published: '2025-10-20',
          snippet: 'Workers returned after a deal.'
        },
        { title: 'local12.example.org', url: 'https://local12.example.org/', domain: 'local12.example.org', snippet: 'Hall meeting Thursday.' }
      ]
    })
  })

  it('passes recency, news and site filters to Tavily', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { results: [] } })

    const service = new SearchService(() => ({ tavilyApiKey: 'tvly-test', serpApiKey: '' } as never))
    const response = await service.search('nurses strike', 3, { recency: 'week', topic: 'news', domains: ['apnews.com', 'reuters.com'] })

    expect(mockedAxios.post.mock.calls[0]?.[1]).toEqual({
      query: 'nurses strike',
      max_results: 3,
      search_depth: 'basic',
      topic: 'news',
      time_range: 'week',
      include_domains: ['apnews.com', 'reuters.com']
    })
    expect(response).toEqual({
      query: 'nurses strike',
      backend: 'tavily',
      recency: 'week',
      topic: 'news',
      domains: ['apnews.com', 'reuters.com'],
      results: []
    })
  })

  it('maps the same filters onto SerpAPI news search, date range and site operators', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        news_results: [
          { title: 'Nurses walk out', link: 'https://apnews.com/article/nurses', snippet: 'Thousands of nurses...', date: '10/20/2025, 07:00 AM, +0000 UTC' },
          { title: 'Picket lines grow', link: 'https://reuters.com/world/pickets', snippet: 'Day two.', date: '3 days ago' }
        ]
      }
    })

    const service = new SearchService(() => ({ tavilyApiKey: '', serpApiKey: 'serp-test' } as never))
    const response = await service.search('nurses strike', 3, { recency: 'month', topic: 'news', domains: ['apnews.com', 'reuters.com'] })

    expect(mockedAxios.get).toHaveBeenCalledWith('https://serpapi.com/search', {
      params: {
        q: 'nurses strike (site:apnews.com OR site:reuters.com)',
        api_key: 'serp-test',
        num: 3,
        engine: 'google',
        tbm: 'nws',
        tbs: 'qdr:m'
      },
      timeout: 15_000
    })
    expect(response.backend).toBe('serpapi')
    expect(response.results).toEqual([
      { title: 'Nurses walk out', url: 'https://apnews.com/article/nurses', domain: 'apnews.com', published: '2025-10-20', snippet: 'Thousands of nurses...' },
      { title: 'Picket lines grow', url: 'https://reuters.com/world/pickets', domain: 'reuters.com', published: '3 days ago', snippet: 'Day two.' }
    ])
  })

  it('falls back to SerpAPI when Tavily fails, and notes why', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Tavily down'))
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        organic_results: [
          { title: 'Result One', link: 'https://example.com/one', snippet: 'Snippet one', date: 'Oct 20, 2025' },
          { title: 'Result Two', link: 'https://example.com/two', snippet: 'Snippet two' }
        ]
      }
    })

    const service = new SearchService(() => ({
      tavilyApiKey: 'tvly-test',
      serpApiKey: 'serp-test'
    } as never))

    const response = await service.search('hello world', 2)

    expect(response.results).toEqual([
      { title: 'Result One', url: 'https://example.com/one', domain: 'example.com', published: '2025-10-20', snippet: 'Snippet one' },
      { title: 'Result Two', url: 'https://example.com/two', domain: 'example.com', snippet: 'Snippet two' }
    ])
    expect(response.note).toBe('Tavily failed (Could not reach Tavily: Tavily down); these results are from SerpAPI.')
  })

  it('caps long snippets at a word break', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { results: [{ title: 'Long', url: 'https://example.com/long', content: 'organize '.repeat(200) }] }
    })

    const service = new SearchService(() => ({ tavilyApiKey: 'tvly-test', serpApiKey: '' } as never))
    const [result] = (await service.search('long', 1)).results

    expect(result.snippet.length).toBeLessThanOrEqual(603)
    expect(result.snippet.endsWith('organize...')).toBe(true)
  })

  it('says why Tavily failed when there is no SerpAPI key to fall back on', async () => {
    mockedAxios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 401'), {
      response: { status: 401 }
    }))

    const service = new SearchService(() => ({ tavilyApiKey: 'tvly-bad', serpApiKey: '' } as never))
    const err = await service.search('strike fund').then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(SearchError)
    expect(err).toMatchObject({ code: 'HTTP_ERROR', status: 401, retryable: false })
    expect((err as Error).message).toBe(
      'Tavily search failed: Tavily returned HTTP 401: the API key was rejected; check it in Settings. '
      + 'No SerpAPI key is configured to fall back on.'
    )
  })

  it('reports both failures when Tavily and SerpAPI both fail', async () => {
    mockedAxios.post.mockRejectedValueOnce(Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }))
    mockedAxios.get.mockRejectedValueOnce(Object.assign(new Error('Request failed'), { response: { status: 503 } }))

    const service = new SearchService(() => ({ tavilyApiKey: 'tvly', serpApiKey: 'serp' } as never))
    const err = await service.search('strike fund').then(() => null, (e: unknown) => e)

    expect(err).toMatchObject({ code: 'HTTP_ERROR', retryable: true })
    expect((err as Error).message).toContain('Tavily: Tavily did not respond in time.')
    expect((err as Error).message).toContain('SerpAPI: SerpAPI returned HTTP 503')
  })

  it('uses a NO_SEARCH_KEY code when no search key is set', async () => {
    const service = new SearchService(() => ({ tavilyApiKey: '', serpApiKey: '' } as never))

    await expect(service.search('strike fund')).rejects.toMatchObject({ code: 'NO_SEARCH_KEY' })
  })

  it('appends org site operator for orgSearch queries, keeping recency and topic', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        results: [
          { title: 'Org Result', url: 'https://docs.example.com/one', content: 'Scoped snippet' }
        ]
      }
    })

    const service = new SearchService(() => ({
      tavilyApiKey: 'tvly-test',
      serpApiKey: '',
      orgSite: 'docs.example.com'
    } as never))

    const response = await service.orgSearch('release notes', 1, { recency: 'year', topic: 'news' })

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        query: 'release notes site:docs.example.com',
        max_results: 1,
        topic: 'news',
        time_range: 'year'
      }),
      expect.objectContaining({ timeout: 15_000 })
    )
    expect(response.query).toBe('release notes site:docs.example.com')
    expect(response.results).toEqual([
      { title: 'Org Result', url: 'https://docs.example.com/one', domain: 'docs.example.com', snippet: 'Scoped snippet' }
    ])
  })

  it('normalizes orgSite URLs to a hostname before applying site operator', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { results: [] } })

    const service = new SearchService(() => ({
      tavilyApiKey: 'tvly-test',
      serpApiKey: '',
      orgSite: 'https://docs.example.com/reference/path?x=1'
    } as never))

    await service.orgSearch('release notes', 1)

    expect(mockedAxios.post.mock.calls[0]?.[1]).toMatchObject({ query: 'release notes site:docs.example.com' })
  })

  it('uses only the site operator when orgSearch query is blank', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { results: [] } })

    const service = new SearchService(() => ({
      tavilyApiKey: 'tvly-test',
      serpApiKey: '',
      orgSite: 'docs.example.com'
    } as never))

    await service.orgSearch('   ', 1)

    expect(mockedAxios.post.mock.calls[0]?.[1]).toMatchObject({ query: 'site:docs.example.com' })
  })

  it('does not duplicate site operator when orgSearch query already includes one', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { results: [] } })

    const service = new SearchService(() => ({
      tavilyApiKey: 'tvly-test',
      serpApiKey: '',
      orgSite: 'docs.example.com'
    } as never))

    await service.orgSearch('release notes site:example.com', 1)

    expect(mockedAxios.post.mock.calls[0]?.[1]).toMatchObject({ query: 'release notes site:example.com' })
  })
})

describe('SearchService.searchWikipedia', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns article intros in the shared result shape', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { query: { search: [{ pageid: 7, title: 'Taft–Hartley Act', snippet: '<span>labor</span> law' }] } } })
      .mockResolvedValueOnce({ data: { query: { pages: { 7: { extract: `The Labor Management Relations Act of 1947. ${'More history. '.repeat(80)}` } } } } })

    const service = new SearchService(() => ({} as never))
    const response = await service.searchWikipedia('taft hartley', 3)

    expect(response.query).toBe('taft hartley')
    expect(response.backend).toBe('wikipedia')
    expect(response.results).toHaveLength(1)
    expect(response.results[0]).toMatchObject({
      title: 'Taft–Hartley Act',
      url: 'https://en.wikipedia.org/wiki/Taft%E2%80%93Hartley_Act',
      domain: 'en.wikipedia.org'
    })
    expect(response.results[0].snippet.startsWith('The Labor Management Relations Act of 1947.')).toBe(true)
    expect(response.results[0].snippet.length).toBeLessThanOrEqual(803)
  })
})
