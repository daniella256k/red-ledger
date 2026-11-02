import { registerTool } from './registry'
import { getSearchService } from '../../ipc/search'
import { numberArg, requireObjectArgs, requireStringArg } from './args'
import {
  FETCH_DEFAULT_MAX_CHARS,
  FETCH_MAX_MAX_CHARS,
  FETCH_MIN_MAX_CHARS
} from '../../services/SearchService'
import { formatFetchUrlResult } from '../../../src/lib/toolResultText'

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Read a web page, PDF or text file (JSON, XML, CSV) at a URL. '
        + 'Returns the main content as Markdown with links as [text](url), plus the title and publish date when known. '
        + 'Long documents come back one part at a time: when there is more, the result gives next_start_index; call again with start_index set to it to read on. '
        + 'Read the 1-3 most relevant search results rather than every one. '
        + 'If a site refuses the request (HTTP 403), use another source instead of retrying.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The http(s) URL to read.'
          },
          start_index: {
            type: 'integer',
            minimum: 0,
            description: 'Character offset to start from, to read the next part of a long document (default 0).'
          },
          max_chars: {
            type: 'integer',
            minimum: FETCH_MIN_MAX_CHARS,
            maximum: FETCH_MAX_MAX_CHARS,
            description: `Most characters to return in this part (default ${FETCH_DEFAULT_MAX_CHARS}).`
          }
        },
        required: ['url']
      }
    }
  },
  execute: async (args) => {
    const input = requireObjectArgs(args, 'fetch_url')
    const url = requireStringArg(input, 'url', 'fetch_url')
    const maxChars = numberArg(input, 'max_chars', 'fetch_url', {
      defaultValue: FETCH_DEFAULT_MAX_CHARS,
      min: FETCH_MIN_MAX_CHARS,
      max: FETCH_MAX_MAX_CHARS,
      integer: true
    })
    const startIndex = numberArg(input, 'start_index', 'fetch_url', {
      defaultValue: 0,
      min: 0,
      integer: true
    })
    const search = getSearchService()
    return search.fetchUrl(url, maxChars, startIndex)
  },
  formatForModel: formatFetchUrlResult
})
