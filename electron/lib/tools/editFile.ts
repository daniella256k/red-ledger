import { dialog, BrowserWindow } from 'electron'
import { registerTool } from './registry'
import { getWorkspaceService } from '../../ipc/fs'
import type { DialogAdapter } from '../../services/WorkspaceService'
import { requireObjectArgs, requireStringArg } from './args'

function dialogForWindow(win: BrowserWindow | null): DialogAdapter | null {
  if (!win) return null
  return { showMessageBox: (options) => dialog.showMessageBox(win, options) }
}

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Perform an exact-match string replacement in an existing file. Searches for old_string as a literal substring and replaces it with new_string. Fails if the string is not found or appears more than once — provide more surrounding context to disambiguate. Use this to iteratively refine a file without rewriting the whole thing.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file within the workspace'
          },
          old_string: {
            type: 'string',
            description: 'Exact literal string to find and replace. Must match character-for-character including whitespace. Must be unique within the file.'
          },
          new_string: {
            type: 'string',
            description: 'Replacement string to substitute in place of old_string. May be empty to delete the matched region.'
          }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  execute: async (args, win) => {
    const input = requireObjectArgs(args, 'edit_file')
    const path = requireStringArg(input, 'path', 'edit_file')
    const oldString = requireStringArg(input, 'old_string', 'edit_file', {
      trim: false,
      allowEmpty: false
    })
    const newString = requireStringArg(input, 'new_string', 'edit_file', {
      trim: false,
      allowEmpty: true
    })

    if (oldString === newString) {
      return {
        error: 'old_string and new_string are identical — no change to apply.',
        path
      }
    }

    const workspace = getWorkspaceService()
    const adapter = dialogForWindow(win)

    // Read without a dialog adapter: edit_file is one logical operation, so we
    // only want to prompt once (in editFile) when strict mode is on, not twice.
    const content = await workspace.readFile(null, path)

    const index = content.indexOf(oldString)
    if (index === -1) {
      return {
        error: `old_string not found in "${path}". The file content may differ from what you expected — re-read the file before retrying.`,
        path
      }
    }

    const secondMatch = content.indexOf(oldString, index + oldString.length)
    if (secondMatch !== -1) {
      return {
        error: `old_string matches multiple locations in "${path}". Include more surrounding context so it uniquely identifies the target region.`,
        path
      }
    }

    const updated = content.slice(0, index) + newString + content.slice(index + oldString.length)
    await workspace.editFile(adapter, path, updated)

    return { success: true, path }
  }
})
