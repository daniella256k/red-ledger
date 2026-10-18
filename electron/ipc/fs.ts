import { dialog, shell, BrowserWindow } from 'electron'
import { handleIpc } from './typedIpc'
import { assertString, assertOptionalString, assertOptionalBoolean } from './validate'
import { WorkspaceService, type DialogAdapter } from '../services/WorkspaceService'
import type { Settings } from '../../src/types'

/**
 * Thin IPC adapter for workspace/file operations.
 * All business logic lives in WorkspaceService.
 */

let service: WorkspaceService

export function getWorkspaceService(): WorkspaceService {
  if (!service) {
    throw new Error('WorkspaceService not initialized')
  }
  return service
}

/**
 * Create a DialogAdapter backed by a BrowserWindow.
 * Returns null if no window is available.
 */
export function dialogForWindow(win: BrowserWindow | null): DialogAdapter | null {
  if (!win) return null
  return {
    showMessageBox: (options) => dialog.showMessageBox(win, options)
  }
}

export function registerFsHandlers(getSettings: () => Settings): void {
  service = new WorkspaceService(getSettings)

  handleIpc('fs:selectWorkspace', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || null
    const result = win
      ? await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select Workspace Directory'
      })
      : await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Workspace Directory'
      })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    service.setWorkspacePath(result.filePaths[0])
    return result.filePaths[0]
  })

  handleIpc('fs:readFile', async (event, relativePath) => {
    assertString(relativePath, 'relativePath')
    const win = BrowserWindow.fromWebContents(event.sender) || null
    return service.readFile(dialogForWindow(win), relativePath)
  })

  handleIpc('fs:writeFile', async (event, relativePath, content, append) => {
    assertString(relativePath, 'relativePath')
    assertString(content, 'content')
    assertOptionalBoolean(append, 'append')
    const win = BrowserWindow.fromWebContents(event.sender) || null
    return service.writeFile(dialogForWindow(win), relativePath, content, append ?? false)
  })

  handleIpc('fs:listFiles', (_e, relativePath) => {
    assertOptionalString(relativePath, 'relativePath')
    return service.listFiles(relativePath)
  })

  handleIpc('fs:showInFolder', (_e, relativePath) => {
    assertString(relativePath, 'relativePath')
    shell.showItemInFolder(service.resolveExistingPath(relativePath))
  })
}
