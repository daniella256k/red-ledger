import { PathJailError } from '../../services/pathJail'
import { displayDomain, normalizeSiteHost } from '../../services/searchResults'
import { optionalEnumArg, optionalStringListArg } from './args'
import type { SearchFilters, SearchRecency, SearchResponse, SearchResult, SearchTopic } from '../../../src/types'

/**
 * What web_search, org_search and wiki_search share: the filter parameters,
 * their parsing, and the text the model reads for a result. Pure, so it can
 * be tested without Electron.
 */

export const SEARCH_RECENCY_VALUES: readonly SearchRecency[] = ['day', 'week', 'month', 'year']
export const SEARCH_TOPIC_VALUES: readonly SearchTopic[] = ['general', 'news']
export const MAX_SEARCH_DOMAINS = 5

/** JSON schema for the filters a search tool takes. */
export function searchFilterProperties(options: { domains: boolean }): Record<string, unknown> {
  return {
    recency: {
      type: 'string',
      enum: SEARCH_RECENCY_VALUES,
      description: 'Only results from the past day, week, month or year. Use for recent events.'
    },
    topic: {
      type: 'string',
      enum: SEARCH_TOPIC_VALUES,
      description: '"news" searches news coverage and includes publish dates (default "general").'
    },
    ...(options.domains
      ? {
        domains: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_SEARCH_DOMAINS,
          description: 'Only search these sites, e.g. ["nlrb.gov", "bls.gov"].'
        }
      }
      : {})
  }
}

export function parseSearchFilters(
  input: Record<string, unknown>,
  toolName: string,
  options: { domains: boolean }
): SearchFilters {
  const recency = optionalEnumArg(input, 'recency', toolName, SEARCH_RECENCY_VALUES)
  const topic = optionalEnumArg(input, 'topic', toolName, SEARCH_TOPIC_VALUES)
  const rawDomains = options.domains
    ? optionalStringListArg(input, 'domains', toolName, { maxItems: MAX_SEARCH_DOMAINS })
    : undefined

  const domains = rawDomains?.map((raw) => {
    const host = normalizeSiteHost(raw)
    if (!host || !host.includes('.')) {
      throw new PathJailError('INVALID_INPUT', `${toolName} "domains" has an entry that is not a site: "${raw}"`)
    }
    return displayDomain(host)
  })

  return {
    ...(recency ? { recency } : {}),
    ...(topic ? { topic } : {}),
    ...(domains?.length ? { domains: [...new Set(domains)] } : {})
  }
}

const RECENCY_LABELS: Record<SearchRecency, string> = {
  day: 'past day',
  week: 'past week',
  month: 'past month',
  year: 'past year'
}

const BACKEND_LABELS: Record<SearchResponse['backend'], string> = {
  tavily: 'Tavily',
  serpapi: 'Google via SerpAPI',
  wikipedia: 'Wikipedia'
}

function domainOf(result: Partial<SearchResult>): string {
  if (result.domain) return result.domain
  try {
    return displayDomain(new URL(String(result.url)).hostname)
  } catch {
    return ''
  }
}

/**
 * A search result as the model reads it: what was searched, then a numbered
 * list (title, URL, site and date, snippet) between <search_results> tags, so
 * snippet text is never mistaken for the conversation. Also reads results
 * saved before 1.8, which were a bare array.
 */
export function formatSearchResponse(result: unknown): string {
  const response: Partial<SearchResponse> = Array.isArray(result)
    ? { results: result as SearchResult[] }
    : (result ?? {}) as Partial<SearchResponse>
  if (!Array.isArray(response.results)) throw new Error('Not a search result')

  const filters = [
    response.recency ? RECENCY_LABELS[response.recency] : null,
    response.topic === 'news' ? 'news' : null,
    response.domains?.length ? `sites: ${response.domains.join(', ')}` : null
  ].filter((label): label is string => !!label)
  const scope = filters.length > 0 ? ` (${filters.join(', ')})` : ''
  const searched = typeof response.query === 'string' ? `"${response.query}"${scope}` : `this search${scope}`

  if (response.results.length === 0) {
    const broaden = response.recency ? 'a broader query or a longer time range' : 'a broader query'
    const lines = [`No results for ${searched}. Try ${broaden}.`]
    if (response.note) lines.push(`Note: ${response.note}`)
    return lines.join('\n\n')
  }

  const source = response.backend ? ` from ${BACKEND_LABELS[response.backend]}` : ''
  const items = response.results.map((item, index) => {
    const meta = [domainOf(item), item.published ? `published ${item.published}` : null]
      .filter((part): part is string => !!part)
      .join(' · ')
    return [
      `${index + 1}. ${item.title || domainOf(item) || 'Untitled'}`,
      `   ${item.url}`,
      ...(meta ? [`   ${meta}`] : []),
      ...(item.snippet ? [`   ${String(item.snippet).replace(/\s+/g, ' ').trim()}`] : [])
    ].join('\n')
  })

  const parts = [
    `${response.results.length} result${response.results.length === 1 ? '' : 's'} for ${searched}${source}:`,
    `<search_results>\n${items.join('\n\n')}\n</search_results>`
  ]
  if (response.note) parts.push(`Note: ${response.note}`)
  return parts.join('\n\n')
}
