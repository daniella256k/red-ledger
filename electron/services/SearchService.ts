import axios from 'axios'
import type {
  AddressFamily as AxiosAddressFamily,
  LookupAddress as AxiosLookupAddress,
  LookupAddressEntry as AxiosLookupAddressEntry
} from 'axios'
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { extractHtmlPage } from './webExtract'
import { extractPdfTextFromBuffer } from './PdfAttachmentService'
import { WIKI_SNIPPET_MAX_CHARS, finishResults, normalizeSiteHost, toSearchResult } from './searchResults'
import type {
  FetchUrlResult,
  SearchFilters,
  SearchResponse,
  SearchResult,
  Settings
} from '../../src/types'

interface RedirectableResponse {
  data: unknown
  headers?: Record<string, unknown>
  status?: number
}

interface LookupRequestOptions {
  all?: boolean
  family?: number
}

interface SafeLookupAddress extends AxiosLookupAddressEntry {
  family: Exclude<AxiosAddressFamily, undefined>
}

const FETCH_TIMEOUT_MS = 20_000
/** Room for long reports published as PDFs. */
const FETCH_MAX_BYTES = 25_000_000
const MAX_FETCH_REDIRECTS = 5
export const FETCH_DEFAULT_MAX_CHARS = 10_000
export const FETCH_MIN_MAX_CHARS = 1_000
export const FETCH_MAX_MAX_CHARS = 100_000
/** Fetched documents are kept briefly, so reading the next part doesn't download it again. */
const FETCH_CACHE_TTL_MS = 5 * 60_000
const FETCH_CACHE_MAX_ENTRIES = 20
/** Says plainly who is asking, so sites can decide; it doesn't pose as a browser. */
const USER_AGENT = 'RedLedger/1.0'
const SEARCH_TIMEOUT_MS = 15_000

export type SearchErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_HOST'
  | 'DNS_FAILED'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'TOO_MANY_REDIRECTS'
  | 'UNSUPPORTED_TYPE'
  | 'EXTRACTION_FAILED'
  | 'NETWORK_ERROR'
  | 'NO_SEARCH_KEY'

/**
 * A failed search or fetch. The tool executor passes code, retryable and
 * status on to the model, so it can tell a blocked site (try another source)
 * from a timeout (worth one retry).
 */
export class SearchError extends Error {
  readonly code: SearchErrorCode
  readonly retryable: boolean
  readonly status?: number

  constructor(code: SearchErrorCode, message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message)
    this.name = 'SearchError'
    this.code = code
    this.retryable = options.retryable ?? false
    if (options.status !== undefined) this.status = options.status
  }
}

const HTTP_STATUS_HINTS: Record<number, string> = {
  401: 'the page requires a login',
  403: 'the site refused the request (it may block automated access or require a login); try another source',
  404: 'the page was not found',
  410: 'the page has been removed',
  429: 'too many requests; try again later or use another source',
  451: 'the page is unavailable for legal reasons'
}

/** A failed request as a SearchError saying what happened and whether retrying could help. */
export function toSearchError(err: unknown, source: string, options: { api?: boolean } = {}): SearchError {
  if (err instanceof SearchError) return err

  const failure = (err ?? {}) as { code?: unknown; message?: unknown; response?: { status?: unknown } }
  const message = typeof failure.message === 'string' ? failure.message : String(err)
  const status = typeof failure.response?.status === 'number' ? failure.response.status : undefined

  if (status !== undefined) {
    const hint = options.api && (status === 401 || status === 403)
      ? 'the API key was rejected; check it in Settings'
      : HTTP_STATUS_HINTS[status] ?? (status >= 500 ? 'the server had an error' : 'the request failed')
    return new SearchError('HTTP_ERROR', `${source} returned HTTP ${status}: ${hint}.`, {
      status,
      retryable: status === 408 || status === 429 || status >= 500
    })
  }
  if (failure.code === 'ECONNABORTED' || failure.code === 'ETIMEDOUT' || /timeout/i.test(message)) {
    return new SearchError('TIMEOUT', `${source} did not respond in time.`, { retryable: true })
  }
  if (/maxContentLength/i.test(message)) {
    return new SearchError('TOO_LARGE', `${source} sent more than ${FETCH_MAX_BYTES / 1_000_000} MB, too much to read.`)
  }
  return new SearchError('NETWORK_ERROR', `Could not reach ${source}: ${message}`, { retryable: true })
}

/** The fetched document whole; fetchUrl hands it out one part at a time. */
interface FetchedDocument {
  meta: Omit<FetchUrlResult, 'content' | 'start_index' | 'end_index' | 'total_chars' | 'truncated' | 'next_start_index' | 'note'>
  text: string
}

/**
 * One part of a document: up to maxChars from start, ending at a paragraph,
 * line or word break when one falls in the last 30%, so parts don't split words.
 */
export function sliceDocument(
  text: string,
  start: number,
  maxChars: number
): Pick<FetchUrlResult, 'content' | 'start_index' | 'end_index' | 'total_chars' | 'truncated' | 'next_start_index' | 'note'> {
  const total = text.length
  if (start > 0 && start >= total) {
    return {
      content: '',
      start_index: start,
      end_index: start,
      total_chars: total,
      truncated: false,
      note: `start_index ${start} is past the end of the document (${total} characters).`
    }
  }

  let end = Math.min(start + maxChars, total)
  if (end < total) {
    const window = text.slice(start, end)
    const minCut = Math.floor(maxChars * 0.7)
    for (const separator of ['\n\n', '\n', ' ']) {
      const at = window.lastIndexOf(separator)
      if (at >= minCut) {
        end = start + at + separator.length
        break
      }
    }
  }

  return {
    content: text.slice(start, end).trimEnd(),
    start_index: start,
    end_index: end,
    total_chars: total,
    truncated: end < total,
    ...(end < total ? { next_start_index: end } : {})
  }
}

function toBytes(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  return Buffer.alloc(0)
}

function documentKind(contentType: string, bytes: Buffer): 'html' | 'pdf' | 'text' | null {
  if (contentType === 'application/pdf' || bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'html'
  if (
    contentType.startsWith('text/')
    || /^application\/(json|xml|javascript|csv)$/.test(contentType)
    || /\+(json|xml)$/.test(contentType)
  ) {
    return 'text'
  }
  // No content type sent: read it if it is plainly HTML.
  if (contentType === 'unknown' && /<(!doctype html|html)[\s>]/i.test(bytes.subarray(0, 1024).toString('latin1'))) {
    return 'html'
  }
  return null
}

/** The body as text, in the charset the server or the page itself declares (UTF-8 otherwise). */
function decodeBody(bytes: Buffer, contentTypeHeader: string): string {
  const declared = /charset=["']?([\w.:-]+)/i.exec(contentTypeHeader)?.[1]
    ?? /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1]
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** The query limited to the given sites, for search engines that take Google's site: operator. */
function withSiteOperators(query: string, domains: string[] | undefined): string {
  if (!domains?.length) return query
  const sites = domains.map((domain) => `site:${domain}`)
  return `${query} ${sites.length === 1 ? sites[0] : `(${sites.join(' OR ')})`}`
}

/** A readable title for a document without one: its file name, else its host. */
function titleFromUrl(url: URL): string {
  const raw = url.pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(raw) || url.hostname
  } catch {
    return raw || url.hostname
  }
}

const BLOCKED_IPV4_SUBNETS: Array<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]

const ALL_IPV6_BITS = (1n << 128n) - 1n

const BLOCKED_IPV6_SUBNETS = [
  { network: parseIpv6Literal('::'), prefix: 128 },
  { network: parseIpv6Literal('::1'), prefix: 128 },
  { network: parseIpv6Literal('fc00::'), prefix: 7 },
  { network: parseIpv6Literal('fe80::'), prefix: 10 },
  { network: parseIpv6Literal('fec0::'), prefix: 10 },
  { network: parseIpv6Literal('ff00::'), prefix: 8 },
  { network: parseIpv6Literal('2001:db8::'), prefix: 32 }
]

function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
}

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null

  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const value = Number.parseInt(part, 10)
    if (!Number.isInteger(value) || value < 0 || value > 255) return null
    octets.push(value)
  }

  return octets
}

function ipv4ToInt(address: string): number | null {
  const octets = parseIpv4Octets(address)
  if (!octets) return null

  return (
    ((octets[0] << 24) >>> 0) |
    (octets[1] << 16) |
    (octets[2] << 8) |
    octets[3]
  ) >>> 0
}

function ipv4Mask(prefix: number): number {
  if (prefix <= 0) return 0
  if (prefix >= 32) return 0xFFFFFFFF
  return (0xFFFFFFFF << (32 - prefix)) >>> 0
}

function isInIpv4Subnet(address: string, network: string, prefix: number): boolean {
  const ip = ipv4ToInt(address)
  const subnet = ipv4ToInt(network)
  if (ip === null || subnet === null) return false

  const mask = ipv4Mask(prefix)
  return (ip & mask) === (subnet & mask)
}

function parseIpv6Literal(address: string): bigint {
  const normalized = normalizeHost(address)
  const mappedPrefix = '::ffff:'

  if (normalized.startsWith(mappedPrefix) && normalized.includes('.')) {
    const mapped = normalized.slice(mappedPrefix.length)
    const octets = parseIpv4Octets(mapped)
    if (!octets) {
      throw new Error(`Invalid IPv6 literal: ${address}`)
    }

    return (0xFFFFn << 32n) |
      (BigInt(octets[0]) << 24n) |
      (BigInt(octets[1]) << 16n) |
      (BigInt(octets[2]) << 8n) |
      BigInt(octets[3])
  }

  let candidate = normalized
  if (candidate.includes('.')) {
    const lastColon = candidate.lastIndexOf(':')
    if (lastColon === -1) {
      throw new Error(`Invalid IPv6 literal: ${address}`)
    }

    const ipv4Tail = candidate.slice(lastColon + 1)
    const octets = parseIpv4Octets(ipv4Tail)
    if (!octets) {
      throw new Error(`Invalid IPv6 literal: ${address}`)
    }

    const upper = ((octets[0] << 8) | octets[1]).toString(16)
    const lower = ((octets[2] << 8) | octets[3]).toString(16)
    const prefix = candidate.slice(0, lastColon)
    candidate = prefix.endsWith(':')
      ? `${prefix}${upper}:${lower}`
      : `${prefix}:${upper}:${lower}`
  }

  const doubleColonParts = candidate.split('::')
  if (doubleColonParts.length > 2) {
    throw new Error(`Invalid IPv6 literal: ${address}`)
  }

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(':').filter(Boolean)
    : []
  const right = doubleColonParts[1]
    ? doubleColonParts[1].split(':').filter(Boolean)
    : []

  const groups = doubleColonParts.length === 2
    ? (() => {
      const missingGroups = 8 - (left.length + right.length)
      if (missingGroups < 1) {
        throw new Error(`Invalid IPv6 literal: ${address}`)
      }
      return [...left, ...Array(missingGroups).fill('0'), ...right]
    })()
    : candidate.split(':')

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    throw new Error(`Invalid IPv6 literal: ${address}`)
  }

  return groups.reduce((value, group) => (
    (value << 16n) + BigInt(Number.parseInt(group, 16))
  ), 0n)
}

function ipv6Mask(prefix: number): bigint {
  if (prefix <= 0) return 0n
  if (prefix >= 128) return ALL_IPV6_BITS
  return (ALL_IPV6_BITS << BigInt(128 - prefix)) & ALL_IPV6_BITS
}

function isInIpv6Subnet(address: string, network: bigint, prefix: number): boolean {
  let parsed: bigint
  try {
    parsed = parseIpv6Literal(address)
  } catch {
    return false
  }

  const mask = ipv6Mask(prefix)
  return (parsed & mask) === (network & mask)
}

function isBlockedIpv4(address: string): boolean {
  return BLOCKED_IPV4_SUBNETS.some(([network, prefix]) => isInIpv4Subnet(address, network, prefix))
}

/** Prefixes whose last 32 bits are an IPv4 address: IPv4-mapped and NAT64. */
const IPV4_EMBEDDING_IPV6_SUBNETS = [
  parseIpv6Literal('::ffff:0:0'),
  parseIpv6Literal('64:ff9b::')
]

function isBlockedIpv6(address: string): boolean {
  const normalized = normalizeHost(address)
  const mappedPrefix = '::ffff:'
  if (normalized.startsWith(mappedPrefix) && normalized.includes('.')) {
    return isBlockedIpv4(normalized.slice(mappedPrefix.length))
  }

  // URL parsing writes [::ffff:127.0.0.1] as ::ffff:7f00:1, so check the
  // embedded IPv4 address whichever way it is written.
  if (IPV4_EMBEDDING_IPV6_SUBNETS.some((network) => isInIpv6Subnet(normalized, network, 96))) {
    const low = Number(parseIpv6Literal(normalized) & 0xffffffffn)
    return isBlockedIpv4([low >>> 24, (low >>> 16) & 255, (low >>> 8) & 255, low & 255].join('.'))
  }

  return BLOCKED_IPV6_SUBNETS.some(({ network, prefix }) => isInIpv6Subnet(normalized, network, prefix))
}

function isBlockedIpAddress(address: string): boolean {
  const normalized = normalizeHost(address)
  const family = isIP(normalized)
  if (family === 4) return isBlockedIpv4(normalized)
  if (family === 6) return isBlockedIpv6(normalized)
  return false
}

/**
 * Domain service for web search.
 * Supports Tavily (preferred) and SerpAPI (fallback), plus org-scoped and Wikipedia search.
 * No Electron imports.
 */
export class SearchService {
  private getSettings: () => Settings
  /** Recently fetched documents by requested URL, oldest first. */
  private fetchCache = new Map<string, { doc: FetchedDocument; expiresAt: number }>()

  constructor(getSettings: () => Settings) {
    this.getSettings = getSettings
  }

  async search(query: string, numResults: number = 5, filters: SearchFilters = {}): Promise<SearchResponse> {
    const settings = this.getSettings()
    const count = Math.max(1, Math.min(10, numResults))
    const applied: SearchFilters = {
      ...(filters.recency ? { recency: filters.recency } : {}),
      ...(filters.topic && filters.topic !== 'general' ? { topic: filters.topic } : {}),
      ...(filters.domains?.length ? { domains: filters.domains } : {})
    }
    let tavilyError: SearchError | null = null

    // Try Tavily first (preferred)
    if (settings.tavilyApiKey) {
      try {
        const results = await this.searchTavily(query, count, settings.tavilyApiKey, applied)
        return { query, backend: 'tavily', ...applied, results }
      } catch (err) {
        tavilyError = toSearchError(err, 'Tavily', { api: true })
        if (!settings.serpApiKey) {
          throw new SearchError(
            tavilyError.code,
            `Tavily search failed: ${tavilyError.message} No SerpAPI key is configured to fall back on.`,
            { retryable: tavilyError.retryable, status: tavilyError.status }
          )
        }
      }
    }

    // Fall back to SerpAPI
    if (settings.serpApiKey) {
      try {
        const results = await this.searchSerpApi(query, count, settings.serpApiKey, applied)
        return {
          query,
          backend: 'serpapi',
          ...applied,
          results,
          ...(tavilyError ? { note: `Tavily failed (${tavilyError.message}); these results are from SerpAPI.` } : {})
        }
      } catch (err) {
        const serpError = toSearchError(err, 'SerpAPI', { api: true })
        if (!tavilyError) throw serpError
        throw new SearchError(
          serpError.code,
          `Both search services failed. Tavily: ${tavilyError.message} SerpAPI: ${serpError.message}`,
          { retryable: tavilyError.retryable || serpError.retryable }
        )
      }
    }

    throw new SearchError(
      'NO_SEARCH_KEY',
      'No search API key configured. Add a Tavily or SerpAPI key in Settings.'
    )
  }

  /** A web search limited to the organization site from settings. */
  async orgSearch(
    query: string,
    numResults: number = 5,
    filters: Omit<SearchFilters, 'domains'> = {}
  ): Promise<SearchResponse> {
    const settings = this.getSettings()
    const scopedQuery = this.applySiteOperator(query, settings.orgSite)
    return this.search(scopedQuery, numResults, { recency: filters.recency, topic: filters.topic })
  }

  async searchWikipedia(query: string, numResults: number = 5): Promise<SearchResponse> {
    try {
      return { query, backend: 'wikipedia', results: await this.queryWikipedia(query, numResults) }
    } catch (err) {
      throw toSearchError(err, 'Wikipedia', { api: true })
    }
  }

  private async queryWikipedia(query: string, numResults: number): Promise<SearchResult[]> {
    const count = Math.max(1, Math.min(10, numResults))
    const timeout = SEARCH_TIMEOUT_MS

    const searchResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: count,
        format: 'json',
        origin: '*'
      },
      headers: {
        'User-Agent': USER_AGENT
      },
      timeout
    })

    const searchItems: Array<{ pageid: number; title: string; snippet?: string }> =
      searchResponse.data?.query?.search || []

    if (searchItems.length === 0) return []

    const pageIds = searchItems.map((item) => item.pageid).join('|')

    const extractResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        prop: 'extracts',
        exintro: true,
        explaintext: true,
        pageids: pageIds,
        format: 'json',
        origin: '*'
      },
      headers: {
        'User-Agent': USER_AGENT
      },
      timeout
    })

    const pages = (extractResponse.data?.query?.pages || {}) as Record<string, { extract?: string }>

    return finishResults(searchItems.map((item) => {
      const cleanSnippet = (item.snippet || '').replace(/<[^>]*>/g, '')
      const extract = pages[String(item.pageid)]?.extract || ''
      const titleSlug = encodeURIComponent(item.title.replace(/ /g, '_'))

      return toSearchResult({
        title: item.title,
        url: `https://en.wikipedia.org/wiki/${titleSlug}`,
        snippet: extract || cleanSnippet
      }, WIKI_SNIPPET_MAX_CHARS)
    }), count)
  }

  /**
   * One part of the document at a URL: a web page's main content as Markdown,
   * a PDF's text, or a text format as sent. Pass start_index from the previous
   * part's next_start_index to read on; the document is cached briefly, so
   * paging doesn't download it again.
   */
  async fetchUrl(
    url: string,
    maxChars: number = FETCH_DEFAULT_MAX_CHARS,
    startIndex: number = 0
  ): Promise<FetchUrlResult> {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new SearchError('INVALID_URL', 'Invalid URL')
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new SearchError('INVALID_URL', 'Only http:// and https:// URLs are supported')
    }
    parsedUrl.hash = ''

    const boundedMaxChars = Math.max(FETCH_MIN_MAX_CHARS, Math.min(FETCH_MAX_MAX_CHARS, Math.floor(maxChars)))
    const start = Math.max(0, Math.floor(Number.isFinite(startIndex) ? startIndex : 0))
    const doc = await this.loadDocument(parsedUrl)
    return { ...doc.meta, ...sliceDocument(doc.text, start, boundedMaxChars) }
  }

  private async loadDocument(url: URL): Promise<FetchedDocument> {
    const key = url.toString()
    const cached = this.fetchCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.doc
    this.fetchCache.delete(key)

    const doc = await this.downloadDocument(url)
    this.fetchCache.set(key, { doc, expiresAt: Date.now() + FETCH_CACHE_TTL_MS })
    for (const oldest of this.fetchCache.keys()) {
      if (this.fetchCache.size <= FETCH_CACHE_MAX_ENTRIES) break
      this.fetchCache.delete(oldest)
    }
    return doc
  }

  private async downloadDocument(url: URL): Promise<FetchedDocument> {
    let fetched: { response: RedirectableResponse; finalUrl: URL }
    try {
      fetched = await this.fetchUrlWithRedirects(url)
    } catch (err) {
      throw toSearchError(err, url.hostname)
    }

    const { response, finalUrl } = fetched
    const bytes = toBytes(response.data)
    const contentTypeHeader = this.readHeaderValue(response.headers, 'content-type') ?? ''
    const contentType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() || 'unknown'
    const kind = documentKind(contentType, bytes)
    if (!kind) {
      throw new SearchError(
        'UNSUPPORTED_TYPE',
        `Unsupported content type: ${contentType}. fetch_url reads web pages, PDFs and text formats (plain text, JSON, XML, CSV).`
      )
    }

    const base = { url: finalUrl.toString(), content_type: contentType }

    if (kind === 'pdf') {
      let text: string
      try {
        text = await extractPdfTextFromBuffer(bytes)
      } catch (err) {
        throw new SearchError('EXTRACTION_FAILED', `Could not read the PDF: ${err instanceof Error ? err.message : String(err)}`)
      }
      return {
        meta: { ...base, title: titleFromUrl(finalUrl), extraction: 'pdf' },
        text: text || '[No extractable text found in this PDF; it may be a scanned image.]'
      }
    }

    const decoded = decodeBody(bytes, contentTypeHeader)
    if (kind === 'html') {
      const page = extractHtmlPage(decoded, finalUrl.toString())
      return {
        meta: {
          ...base,
          title: page.title || titleFromUrl(finalUrl),
          ...(page.site_name ? { site_name: page.site_name } : {}),
          ...(page.byline ? { byline: page.byline } : {}),
          ...(page.published ? { published: page.published } : {}),
          extraction: page.extraction
        },
        text: page.markdown
      }
    }

    return { meta: { ...base, title: titleFromUrl(finalUrl), extraction: 'text' }, text: decoded.trim() }
  }

  private applySiteOperator(query: string, orgSite: string | undefined): string {
    const trimmedQuery = query.trim()
    const normalizedSite = normalizeSiteHost(orgSite)
    if (!normalizedSite || /\bsite:/i.test(trimmedQuery)) {
      return trimmedQuery
    }
    if (!trimmedQuery) {
      return `site:${normalizedSite}`
    }
    return `${trimmedQuery} site:${normalizedSite}`
  }

  private async fetchUrlWithRedirects(initialUrl: URL): Promise<{
    response: RedirectableResponse
    finalUrl: URL
  }> {
    let currentUrl = initialUrl

    for (let redirectCount = 0; redirectCount <= MAX_FETCH_REDIRECTS; redirectCount++) {
      const safeAddresses = await this.resolveSafeFetchAddresses(currentUrl)

      const response = await axios.get<ArrayBuffer>(currentUrl.toString(), {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: FETCH_MAX_BYTES,
        maxBodyLength: FETCH_MAX_BYTES,
        maxRedirects: 0,
        validateStatus: (status) => (status >= 200 && status < 300) || this.isRedirectStatus(status),
        lookup: this.createPinnedLookup(currentUrl.hostname, safeAddresses),
        headers: {
          'User-Agent': USER_AGENT
        }
      }) as RedirectableResponse

      const status = typeof response.status === 'number' ? response.status : 200
      if (!this.isRedirectStatus(status)) {
        return { response, finalUrl: currentUrl }
      }

      const location = this.readHeaderValue(response.headers, 'location')
      if (!location) {
        throw new SearchError('HTTP_ERROR', 'URL redirected without a valid location header', { status })
      }

      // Each hop is checked like the first: http(s) only, and (next time
      // round) never a local or private address.
      currentUrl = new URL(location, currentUrl)
      if (!['http:', 'https:'].includes(currentUrl.protocol)) {
        throw new SearchError('INVALID_URL', `URL redirected to an unsupported address (${currentUrl.protocol}); only http:// and https:// are read`)
      }
      currentUrl.hash = ''
    }

    throw new SearchError('TOO_MANY_REDIRECTS', `Too many redirects (maximum ${MAX_FETCH_REDIRECTS})`)
  }

  private isRedirectStatus(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
  }

  private readHeaderValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
    if (!headers) return undefined

    const getter = (headers as { get?: (key: string) => unknown }).get
    if (typeof getter === 'function') {
      const viaGetter = getter.call(headers, name)
      if (typeof viaGetter === 'string' && viaGetter.trim()) {
        return viaGetter.trim()
      }
    }

    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== name.toLowerCase()) continue
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (Array.isArray(value)) {
        const firstString = value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        if (firstString) return firstString.trim()
      }
    }

    return undefined
  }

  private createPinnedLookup(hostname: string, safeAddresses: SafeLookupAddress[]) {
    const normalizedHostname = normalizeHost(hostname)

    return (
      requestedHost: string,
      options: LookupRequestOptions,
      callback: (
        err: Error | null,
        address: AxiosLookupAddress | AxiosLookupAddress[],
        family?: AxiosAddressFamily
      ) => void
    ): void => {
      if (normalizeHost(requestedHost) !== normalizedHostname) {
        callback(new Error('Refusing to resolve an unexpected host'), '')
        return
      }

      const requestedFamily = options?.family
      const filteredAddresses = typeof requestedFamily === 'number' && (requestedFamily === 4 || requestedFamily === 6)
        ? safeAddresses.filter((entry) => entry.family === requestedFamily)
        : safeAddresses

      if (filteredAddresses.length === 0) {
        callback(new Error(`No safe IP addresses available for ${requestedHost}`), '')
        return
      }

      if (options?.all) {
        callback(null, filteredAddresses)
        return
      }

      const [first] = filteredAddresses
      callback(null, first.address, first.family)
    }
  }

  private async resolveSafeFetchAddresses(targetUrl: URL): Promise<SafeLookupAddress[]> {
    const hostname = normalizeHost(targetUrl.hostname)
    if (!hostname) {
      throw new SearchError('INVALID_URL', 'Invalid URL host')
    }

    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new SearchError('BLOCKED_HOST', 'Refusing to fetch local or private network resources')
    }

    if (isBlockedIpAddress(hostname)) {
      throw new SearchError('BLOCKED_HOST', 'Refusing to fetch local or private network resources')
    }

    const ipFamily = isIP(hostname)
    if (ipFamily !== 0) {
      return [{
        address: hostname,
        family: ipFamily as SafeLookupAddress['family']
      }]
    }

    let records: LookupAddress[]
    try {
      records = await lookup(hostname, { all: true, verbatim: true }) as LookupAddress[]
    } catch {
      throw new SearchError('DNS_FAILED', `Unable to resolve host: ${hostname}`)
    }

    if (records.length === 0) {
      throw new SearchError('DNS_FAILED', `Unable to resolve host: ${hostname}`)
    }

    if (records.some((record) => isBlockedIpAddress(record.address))) {
      throw new SearchError('BLOCKED_HOST', 'Refusing to fetch local or private network resources')
    }

    return records.map((record) => ({
      address: record.address,
      family: record.family === 6 ? 6 : 4
    }))
  }

  private async searchTavily(
    query: string,
    numResults: number,
    apiKey: string,
    filters: SearchFilters
  ): Promise<SearchResult[]> {
    const response = await axios.post(
      'https://api.tavily.com/search',
      {
        query,
        max_results: numResults,
        search_depth: 'basic',
        topic: filters.topic ?? 'general',
        ...(filters.recency ? { time_range: filters.recency } : {}),
        ...(filters.domains ? { include_domains: filters.domains } : {})
      },
      { timeout: SEARCH_TIMEOUT_MS, headers: { Authorization: `Bearer ${apiKey}` } }
    )

    const raw: Array<{ title?: unknown; url?: unknown; content?: unknown; published_date?: unknown }> =
      Array.isArray(response.data?.results) ? response.data.results : []
    return finishResults(
      raw.map((r) => toSearchResult({ title: r.title, url: r.url, snippet: r.content, published: r.published_date })),
      numResults
    )
  }

  private async searchSerpApi(
    query: string,
    numResults: number,
    apiKey: string,
    filters: SearchFilters
  ): Promise<SearchResult[]> {
    const news = filters.topic === 'news'
    const response = await axios.get('https://serpapi.com/search', {
      params: {
        q: withSiteOperators(query, filters.domains),
        api_key: apiKey,
        num: numResults,
        engine: 'google',
        ...(news ? { tbm: 'nws' } : {}),
        // Google's "past day/week/month/year": qdr:d, qdr:w, qdr:m, qdr:y.
        ...(filters.recency ? { tbs: `qdr:${filters.recency[0]}` } : {})
      },
      timeout: SEARCH_TIMEOUT_MS
    })

    const listed = news ? response.data?.news_results : response.data?.organic_results
    const raw: Array<{ title?: unknown; link?: unknown; snippet?: unknown; date?: unknown }> =
      Array.isArray(listed) ? listed : []
    return finishResults(
      raw.map((r) => toSearchResult({ title: r.title, url: r.link, snippet: r.snippet, published: r.date })),
      numResults
    )
  }
}
