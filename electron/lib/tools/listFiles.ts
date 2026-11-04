import { registerTool } from './registry'
import { optionalStringArg, requireObjectArgs } from './args'

/** Most entries one list_files call returns, so a large workspace can't flood the model's context. */
export const LIST_FILES_MAX_ENTRIES = 1000

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the files and directories in the user\'s workspace (or a subdirectory within it). Returns a tree structure. Always skips node_modules, .git, and files ignored by .gitignore. Dotfiles and dot-folders (e.g. .github, .env.example) are hidden unless include_hidden is true. '
        + `Lists at most ${LIST_FILES_MAX_ENTRIES} entries, top levels first. When there are more, the result is { entries, truncated: true, note } and folders with more inside are marked truncated: true; call list_files with such a folder's path to see its contents.`,
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
    const tree = workspace.listFileTree(path, {
      includeHidden: input.include_hidden === true,
      maxEntries: LIST_FILES_MAX_ENTRIES
    })
    // The plain tree when everything fit, as before; otherwise say what was left out.
    if (!tree.truncated) return tree.nodes
    return {
      entries: tree.nodes,
      truncated: true,
      note: `Listed the first ${tree.entries} entries, top levels first. Folders marked truncated: true have more inside: call list_files with their path.`
    }
  }
})
