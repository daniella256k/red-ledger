import { registerTool } from './registry'
import { getSearchService } from '../../ipc/search'
import { numberArg, requireObjectArgs, requireStringArg } from './args'
import { formatSearchResponse, parseSearchFilters, searchFilterProperties } from './searchShared'

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'org_search',
      description: 'Search the web with an optional organization site filter from settings. Returns titles, URLs and snippets; read the most relevant with fetch_url.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query'
          },
          num_results: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'How many results to return (default 5).'
          },
          ...searchFilterProperties({ domains: false })
        },
        required: ['query']
      }
    }
  },
  execute: async (args) => {
    const input = requireObjectArgs(args, 'org_search')
    const query = requireStringArg(input, 'query', 'org_search')
    const numResults = numberArg(input, 'num_results', 'org_search', {
      defaultValue: 5,
      min: 1,
      max: 10,
      integer: true
    })
    const filters = parseSearchFilters(input, 'org_search', { domains: false })
    const search = getSearchService()
    return search.orgSearch(query, numResults, filters)
  },
  formatForModel: formatSearchResponse
})
