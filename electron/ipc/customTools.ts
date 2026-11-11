import { BrowserWindow, shell } from 'electron'
import { handleIpc } from './typedIpc'
import { getSearchService } from './search'
import { CustomToolService } from '../services/CustomToolService'
import { registerTool, unregisterTool } from '../lib/tools/registry'
import { assignMcpServerPrefixes } from '../../src/lib/mcpConfig'
import type { Settings } from '../../src/types'

/**
 * Thin IPC adapter for custom tools (JSON files in the profile's tools
 * folder). Loading and running them lives in CustomToolService; this wires
 * the real tool registry, the guarded request path, the file manager and
 * status push events.
 */

let service: CustomToolService

export function getCustomToolService(): CustomToolService {
  if (!service) {
    throw new Error('CustomToolService not initialized')
  }
  return service
}

export function registerCustomToolHandlers(folder: string, getSettings: () => Settings): void {
  service = new CustomToolService({
    folder,
    registerTool,
    unregisterTool,
    request: (url, options) => getSearchService().requestApi(url, options),
    getReservedPrefixes: () => [...assignMcpServerPrefixes(getSettings().mcpServers).values()].sort(),
    onStatusChange: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('customTools:status', status)
      }
    }
  })
  service.reload()
  service.startWatching()

  handleIpc('customTools:getStatus', () => service.getStatus())

  handleIpc('customTools:reload', () => service.reload())

  handleIpc('customTools:openFolder', async () => {
    service.ensureFolder()
    const error = await shell.openPath(service.folder)
    if (error) throw new Error(error)
  })
}
