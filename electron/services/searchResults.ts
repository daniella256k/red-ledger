import type { SearchResult } from '../../src/types'

/**
 * Turns raw results from any search backend into one shape, so the model
 * sees the same fields with the same limits whichever service answered.
 * Pure: no network, no Electron.
 */

/** Long enough to answer simple questions from the snippet; short enough that 5-10 results stay cheap. */
export const SNIPPET_MAX_CHARS = 600
/** Wikipedia's opening summary is the point of wiki_search, so it gets more room. */
export const WIKI_SNIPPET_MAX_CHARS = 800

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The text cut at a word break near maxChars, with an ellipsis when anything was cut. */
export function capSnippet(text: string, maxChars: number = SNIPPET_MAX_CHARS): string {
  const clean = collapseWhitespace(text)
  if (clean.length <= maxChars) return clean
  const cut = clean.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > maxChars * 0.7 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:]+$/, '')}…`
}

/**
 * A publish date as YYYY-MM-DD when it can be read; otherwise as given
 * ("3 days ago"), since the model knows the current date from <sent_at>.
 */
export function normalizePublished(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (!value) return undefined
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 40)

  // A date with a zone ("... GMT") is read in UTC; a bare one ("Oct 20, 2025") as written.
  if (/(?:\bGMT\b|\bUTC\b|Z$|[+-]\d{2}:?\d{2}$)/.test(value)) return date.toISOString().slice(0, 10)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** "www.nlrb.gov" → "nlrb.gov". */
export function displayDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

/**
 * The hostname in a site setting or domain filter, whether written as
 * "nlrb.gov", "site:nlrb.gov" or a full URL; null when there is none.
 */
export function normalizeSiteHost(input: string | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  const withoutPrefix = trimmed.replace(/^site:/i, '').trim()
  if (!withoutPrefix) return null

  const [firstToken] = withoutPrefix.split(/\s+/)
  if (!firstToken) return null

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(firstToken)
    ? firstToken
    : `https://${firstToken}`

  try {
    const parsed = new URL(candidate)
    return parsed.hostname.trim().toLowerCase() || null
  } catch {
    const fallbackHost = firstToken.split('/')[0]?.trim().toLowerCase()
    return fallbackHost || null
  }
}

/** One raw backend result as a SearchResult, or null when it has no usable http(s) URL. */
export function toSearchResult(
  raw: { title?: unknown; url?: unknown; snippet?: unknown; published?: unknown },
  snippetMaxChars: number = SNIPPET_MAX_CHARS
): SearchResult | null {
  if (typeof raw.url !== 'string') return null
  let url: URL
  try {
    url = new URL(raw.url.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const domain = displayDomain(url.hostname)
  const published = normalizePublished(raw.published)
  return {
    title: (typeof raw.title === 'string' ? collapseWhitespace(raw.title) : '') || domain,
    url: url.toString(),
    domain,
    ...(published ? { published } : {}),
    snippet: typeof raw.snippet === 'string' ? capSnippet(raw.snippet, snippetMaxChars) : ''
  }
}

/** Usable results, first copy of each URL only, at most count. */
export function finishResults(results: Array<SearchResult | null>, count: number): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const result of results) {
    if (!result) continue
    const key = result.url.replace(/#.*$/, '').replace(/\/$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(result)
    if (out.length >= count) break
  }
  return out
}
