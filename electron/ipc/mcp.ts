import { BrowserWindow } from 'electron'
import { handleIpc } from './typedIpc'
import { assertString } from './validate'
import { dialogForWindow } from './fs'
import { McpService } from '../services/McpService'
import { registerTool, unregisterTool } from '../lib/tools/registry'
import type { Settings } from '../../src/types'

/**
 * Thin IPC adapter for MCP connections.
 * All connection logic lives in McpService; this wires the real tool
 * registry, Electron dialogs and status push events.
 */

let service: McpService

export function getMcpService(): McpService {
  if (!service) {
    throw new Error('McpService not initialized')
  }
  return service
}

export function registerMcpHandlers(getSettings: () => Settings): void {
  service = new McpService({
    getSettings,
    getDialog: dialogForWindow,
    registerTool,
    unregisterTool,
    onStatusChange: (statuses) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('mcp:status', statuses)
      }
    }
  })

  handleIpc('mcp:getStatus', () => service.getStatuses())

  handleIpc('mcp:reconnect', async (_e, serverId) => {
    assertString(serverId, 'serverId')
    await service.reconnect(serverId)
  })
}
