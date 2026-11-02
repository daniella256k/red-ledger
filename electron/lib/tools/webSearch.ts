import { registerTool } from './registry'
import { getSearchService } from '../../ipc/search'
import { numberArg, requireObjectArgs, requireStringArg } from './args'
import { formatSearchResponse, parseSearchFilters, searchFilterProperties } from './searchShared'

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Returns a ranked list of results, each with a title, URL, site, publish date when known, and snippet. '
        + 'Start research here: snippets often answer simple questions; for detail, read the 1-3 most relevant results with fetch_url. '
        + 'Short, specific queries (names, places, dates) work best; run a few focused searches rather than one long one. '
        + 'For recent events set recency, and topic "news" for news coverage; set domains to search particular sites.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query, e.g. "Starbucks union contract 2026".'
          },
          num_results: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'How many results to return (default 5).'
          },
          ...searchFilterProperties({ domains: true })
        },
        required: ['query']
      }
    }
  },
  execute: async (args) => {
    const input = requireObjectArgs(args, 'web_search')
    const query = requireStringArg(input, 'query', 'web_search')
    const numResults = numberArg(input, 'num_results', 'web_search', {
      defaultValue: 5,
      min: 1,
      max: 10,
      integer: true
    })
    const filters = parseSearchFilters(input, 'web_search', { domains: true })
    const search = getSearchService()
    return search.search(query, numResults, filters)
  },
  formatForModel: formatSearchResponse
})
