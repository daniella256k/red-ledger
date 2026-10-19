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
      name: 'move_file',
      description: 'Move or rename a single file within the workspace. If destination is an existing directory, the file keeps its name inside it; otherwise destination is the new file path. Missing parent directories are created. Never overwrites: if the destination file exists the result is an error. Cannot move directories. In Strict Mode the user is asked first; if they decline, the result is an error with code USER_DENIED.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Relative path of the file to move'
          },
          destination: {
            type: 'string',
            description: 'Relative path of the new file location, or of an existing directory to move it into'
          }
        },
        required: ['source', 'destination']
      }
    }
  },
  execute: async (args, { win, workspace }) => {
    const input = requireObjectArgs(args, 'move_file')
    const source = requireStringArg(input, 'source', 'move_file')
    const destination = requireStringArg(input, 'destination', 'move_file')
    const moved = await workspace.moveFile(dialogForWindow(win), source, destination)
    return { success: true, ...moved }
  }
})
