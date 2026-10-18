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
      name: 'append_file',
      description: 'Append content to the end of a file in the user\'s workspace. Creates the file and any missing parent folders if needed. '
        + 'In Strict Mode the user is asked first; if they decline, the result is an error with code USER_DENIED.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file within the workspace'
          },
          content: {
            type: 'string',
            description: 'Content to append to the file'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  execute: async (args, win) => {
    const input = requireObjectArgs(args, 'append_file')
    const path = requireStringArg(input, 'path', 'append_file')
    const content = requireStringArg(input, 'content', 'append_file', {
      trim: false,
      allowEmpty: true
    })
    const workspace = getWorkspaceService()
    await workspace.writeFile(dialogForWindow(win), path, content, true)
    return { success: true, path }
  }
})
