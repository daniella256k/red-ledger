import { BrowserWindow, shell } from 'electron'
import { handleIpc } from './typedIpc'
import { assertString } from './validate'
import { dialogForWindow } from './fs'
import { McpService } from '../services/McpService'
import { createFileAuthStore } from '../services/mcpOAuth'
import { safeStorageCodec } from './safeStorageCodec'
import { registerTool, unregisterTool } from '../lib/tools/registry'
import type { Settings } from '../../src/types'

/**
 * Thin IPC adapter for MCP connections.
 * All connection logic lives in McpService; this wires the real tool
 * registry, Electron dialogs, the browser, the encrypted sign-in store and
 * status push events.
 */

let service: McpService

export function getMcpService(): McpService {
  if (!service) {
    throw new Error('McpService not initialized')
  }
  return service
}

export function registerMcpHandlers(getSettings: () => Settings, authStorePath: string): void {
  service = new McpService({
    getSettings,
    getDialog: dialogForWindow,
    registerTool,
    unregisterTool,
    authStore: createFileAuthStore(authStorePath, safeStorageCodec),
    openUrl: (url) => shell.openExternal(url),
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

  handleIpc('mcp:signIn', async (_e, serverId) => {
    assertString(serverId, 'serverId')
    return service.signIn(serverId)
  })

  handleIpc('mcp:cancelSignIn', (_e, serverId) => {
    assertString(serverId, 'serverId')
    service.cancelSignIn(serverId)
  })

  handleIpc('mcp:signOut', async (_e, serverId) => {
    assertString(serverId, 'serverId')
    await service.signOut(serverId)
  })
}
