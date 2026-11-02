import { registerTool } from './registry'
import { getSearchService } from '../../ipc/search'
import { numberArg, requireObjectArgs, requireStringArg } from './args'
import { formatSearchResponse } from '../../../src/lib/toolResultText'

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'wiki_search',
      description: 'Search Wikipedia for background on people, places, organizations, laws and history. '
        + 'Returns article titles, URLs and the opening summary of each; for the full article, call fetch_url on its URL. '
        + 'For recent events, use web_search.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The Wikipedia search query'
          },
          num_results: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'How many results to return (default 5).'
          }
        },
        required: ['query']
      }
    }
  },
  execute: async (args) => {
    const input = requireObjectArgs(args, 'wiki_search')
    const query = requireStringArg(input, 'query', 'wiki_search')
    const numResults = numberArg(input, 'num_results', 'wiki_search', {
      defaultValue: 5,
      min: 1,
      max: 10,
      integer: true
    })
    const search = getSearchService()
    return search.searchWikipedia(query, numResults)
  },
  formatForModel: formatSearchResponse
})
