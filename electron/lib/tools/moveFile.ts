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
      name: 'move_file',
      description: 'Move or rename a file within the user\'s workspace. Both paths are relative to the workspace root. Creates intermediate directories on the destination side as needed. Prompts for confirmation when overwriting an existing file.',
      parameters: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description: 'Relative source path of the file to move'
          },
          to: {
            type: 'string',
            description: 'Relative destination path (the new name and/or location)'
          }
        },
        required: ['from', 'to']
      }
    }
  },
  execute: async (args, win) => {
    const input = requireObjectArgs(args, 'move_file')
    const from = requireStringArg(input, 'from', 'move_file')
    const to = requireStringArg(input, 'to', 'move_file')

    const workspace = getWorkspaceService()
    await workspace.moveFile(dialogForWindow(win), from, to)
    return { success: true, from, to }
  }
})
