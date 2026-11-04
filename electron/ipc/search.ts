import { SearchService } from '../services/SearchService'
import type { Settings } from '../../src/types'

/**
 * The web search service the search and fetch tools use. The page has no
 * search channel of its own: searches run only as the assistant's tool calls.
 */

let service: SearchService

export function getSearchService(): SearchService {
  if (!service) {
    throw new Error('SearchService not initialized')
  }
  return service
}

export function initSearchService(getSettings: () => Settings): void {
  service = new SearchService(getSettings)
}
