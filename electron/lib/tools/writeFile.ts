import { dialog, BrowserWindow } from 'electron'
import { registerTool } from './registry'
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
      name: 'write_file',
      description: 'Write content to a file in the user\'s workspace. Creates the file and any missing parent folders, or replaces the file if it exists. '
        + 'Replacing an existing file always asks the user first (in Strict Mode, creating a new file asks too). '
        + 'If the user declines, the result is an error with code USER_DENIED: do not retry, tell the user instead.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file within the workspace'
          },
          content: {
            type: 'string',
            description: 'The full content to write to the file'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  execute: async (args, { win, workspace }) => {
    const input = requireObjectArgs(args, 'write_file')
    const path = requireStringArg(input, 'path', 'write_file')
    const content = requireStringArg(input, 'content', 'write_file', {
      trim: false,
      allowEmpty: true
    })
    await workspace.writeFile(dialogForWindow(win), path, content, false)
    return { success: true, path }
  }
})
