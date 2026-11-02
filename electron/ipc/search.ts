import { handleIpc } from './typedIpc'
import { assertString, assertOptionalNumber } from './validate'
import { SearchService } from '../services/SearchService'
import type { Settings } from '../../src/types'

/**
 * Thin IPC adapter for web search.
 * All business logic lives in SearchService.
 */

let service: SearchService

export function getSearchService(): SearchService {
  if (!service) {
    throw new Error('SearchService not initialized')
  }
  return service
}

export function registerSearchHandlers(getSettings: () => Settings): void {
  service = new SearchService(getSettings)

  handleIpc('search:web', async (_e, query, numResults) => {
    assertString(query, 'query')
    assertOptionalNumber(numResults, 'numResults')
    return (await service.search(query, numResults)).results
  })
}
