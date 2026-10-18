import { dialog, BrowserWindow } from 'electron'
import { registerTool } from './registry'
import { getWorkspaceService } from '../../ipc/fs'
import type { DialogAdapter } from '../../services/WorkspaceService'
import { numberArg, requireObjectArgs, requireStringArg } from './args'
import { READ_FILE_MAX_LINES, sliceFileContent } from './fileSlice'

function dialogForWindow(win: BrowserWindow | null): DialogAdapter | null {
  if (!win) return null
  return { showMessageBox: (options) => dialog.showMessageBox(win, options) }
}

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file in the user\'s workspace. For PDF and Word files, returns the extracted text; for spreadsheets (.xlsx, .xls, .ods, ...), returns each sheet as CSV with its cell range (hyperlinked cells as [text](url)), followed by its formulas. '
        + `Small files come back whole. Files over ${READ_FILE_MAX_LINES} lines come back one page at a time with truncated: true and next_offset; call again with that offset to continue. `
        + 'Pass offset/limit to read a specific range: those lines are prefixed with "N | " (the prefix is not part of the file, so leave it out of edit_file strings). total_lines is always included. In Strict Mode the user is asked first; if they decline, the result is an error with code USER_DENIED.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file within the workspace (e.g. "src/index.ts")'
          },
          offset: {
            type: 'number',
            description: 'Optional 1-based line number to start reading from.'
          },
          limit: {
            type: 'number',
            description: `Optional number of lines to read (max ${READ_FILE_MAX_LINES}).`
          }
        },
        required: ['path']
      }
    }
  },
  execute: async (args, win) => {
    const input = requireObjectArgs(args, 'read_file')
    const path = requireStringArg(input, 'path', 'read_file')
    const offset = input.offset === undefined || input.offset === null
      ? undefined
      : numberArg(input, 'offset', 'read_file', { integer: true, min: 1 })
    const limit = input.limit === undefined || input.limit === null
      ? undefined
      : numberArg(input, 'limit', 'read_file', { integer: true, min: 1, max: READ_FILE_MAX_LINES })
    const workspace = getWorkspaceService()
    const content = await workspace.readFile(dialogForWindow(win), path)
    return { path, ...sliceFileContent(content, { offset, limit }) }
  }
})
