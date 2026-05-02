import { registerTool } from './registry'
import { getWorkspaceService } from '../../ipc/fs'
import {
  numberArg,
  optionalStringArg,
  requireObjectArgs,
  requireStringArg
} from './args'

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'grep_files',
      description: 'Search file contents in the workspace for a literal substring or regex. Returns matching file paths with line numbers and the matching line text. Respects .gitignore, skips binary files and dotfiles, and is capped to a few hundred matches — narrow your pattern or path scope if you hit the cap.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Text or regex to search for'
          },
          is_regex: {
            type: 'boolean',
            description: 'Treat pattern as a JS regular expression. Default false (literal substring).'
          },
          case_sensitive: {
            type: 'boolean',
            description: 'Match case exactly. Default true.'
          },
          path: {
            type: 'string',
            description: 'Optional relative subdirectory to restrict the search. Omit to search the whole workspace.'
          },
          glob: {
            type: 'string',
            description: 'Optional filename glob filter (e.g. "*.ts", "**/test/*.py"). Supports * and ?.'
          },
          max_results: {
            type: 'number',
            description: 'Cap on total matches returned (1-1000, default 200).'
          }
        },
        required: ['pattern']
      }
    }
  },
  execute: async (args) => {
    const input = requireObjectArgs(args, 'grep_files')
    const pattern = requireStringArg(input, 'pattern', 'grep_files', { trim: false, allowEmpty: false })
    const path = optionalStringArg(input, 'path', 'grep_files')
    const glob = optionalStringArg(input, 'glob', 'grep_files')

    const isRegex = input.is_regex === true
    const caseSensitive = input.case_sensitive !== false
    const maxResults = input.max_results === undefined
      ? 200
      : numberArg(input, 'max_results', 'grep_files', { integer: true, min: 1, max: 1000 })

    const workspace = getWorkspaceService()
    const matches = workspace.grepFiles({
      pattern,
      isRegex,
      caseSensitive,
      path,
      glob,
      maxResults
    })

    return {
      pattern,
      count: matches.length,
      truncated: matches.length >= maxResults,
      matches
    }
  }
})
