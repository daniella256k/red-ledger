import { registerTool } from './registry'
import { optionalStringArg, requireObjectArgs } from './args'

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all files and directories in the user\'s workspace (or a subdirectory within it). Returns a tree structure. Always skips node_modules, .git, and files ignored by .gitignore. Dotfiles and dot-folders (e.g. .github, .env.example) are hidden unless include_hidden is true.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional relative subdirectory path. Omit to list the entire workspace root.'
          },
          include_hidden: {
            type: 'boolean',
            description: 'Include dotfiles and dot-folders. Default false.'
          }
        },
        required: []
      }
    }
  },
  execute: async (args, { workspace }) => {
    const input = args === undefined ? {} : requireObjectArgs(args, 'list_files')
    const path = optionalStringArg(input, 'path', 'list_files')
    return workspace.listFiles(path, { includeHidden: input.include_hidden === true })
  }
})
