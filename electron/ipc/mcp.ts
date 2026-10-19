import { BrowserWindow, safeStorage, shell } from 'electron'
import { handleIpc } from './typedIpc'
import { assertString } from './validate'
import { dialogForWindow } from './fs'
import { McpService } from '../services/McpService'
import { createFileAuthStore, PLAIN_TEXT_CODEC, type McpAuthCodec } from '../services/mcpOAuth'
import { registerTool, unregisterTool } from '../lib/tools/registry'
import type { Settings } from '../../src/types'

/**
 * Thin IPC adapter for MCP connections.
 * All connection logic lives in McpService; this wires the real tool
 * registry, Electron dialogs, the browser, the encrypted sign-in store and
 * status push events.
 */

/** Sign-in tokens are encrypted with the OS keychain (DPAPI on Windows) when it is available. */
function authCodec(): McpAuthCodec {
  if (!safeStorage.isEncryptionAvailable()) return PLAIN_TEXT_CODEC
  return {
    encrypted: true,
    encode: (json) => safeStorage.encryptString(json).toString('base64'),
    decode: (data) => safeStorage.decryptString(Buffer.from(data, 'base64'))
  }
}

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
    authStore: createFileAuthStore(authStorePath, authCodec),
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
