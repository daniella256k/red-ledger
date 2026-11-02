import { PathJailError } from '../../services/pathJail'
import { normalizeSiteHost } from '../../services/searchResults'
import { displayDomain } from '../../../src/lib/toolResultText'
import { optionalEnumArg, optionalStringListArg } from './args'
import type { SearchFilters, SearchRecency, SearchTopic } from '../../../src/types'

/**
 * The filter parameters web_search and org_search share, and their parsing.
 * The text the model reads for a result is in src/lib/toolResultText.
 * Pure, so it can be tested without Electron.
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
