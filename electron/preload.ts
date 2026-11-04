import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AttachmentParseResult, McpServerStatus, MenuAction, RedLedgerAPI, TurnEvent } from '../src/types'

function getFileName(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Unknown file'
  const record = value as { name?: unknown }
  return typeof record.name === 'string' && record.name.trim().length > 0
    ? record.name
    : 'Unknown file'
}

function resolveAttachmentPaths(files: File[]): { paths: string[]; unresolved: string[] } {
  const paths: string[] = []
  const unresolved: string[] = []
  const seen = new Set<string>()

  for (const file of files) {
    try {
      const filePath = webUtils.getPathForFile(file)
      if (!filePath) {
        unresolved.push(getFileName(file))
        continue
      }
      if (seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    } catch {
      unresolved.push(getFileName(file))
    }
  }

  return { paths, unresolved }
}

/**
 * The preload script exposes a single `window.redLedger` API object.
 * This is the ONLY surface the renderer process can use to interact
 * with the main process. No native modules are loaded here.
 */
const api: RedLedgerAPI = {
  // ─── Workspace & File Operations ─────────────────────────────────────────

  selectWorkspace: () => ipcRenderer.invoke('fs:selectWorkspace'),

  readFile: (relativePath: string) =>
    ipcRenderer.invoke('fs:readFile', relativePath),

  listFiles: (relativePath?: string) =>
    ipcRenderer.invoke('fs:listFiles', relativePath),

  showInFolder: (relativePath: string) =>
    ipcRenderer.invoke('fs:showInFolder', relativePath),

  // ─── Context Files ───────────────────────────────────────────────────────

  loadContext: (type: 'system' | 'user' | 'org') =>
    ipcRenderer.invoke('context:load', type),

  saveContext: (type: 'system' | 'user' | 'org', content: string) =>
    ipcRenderer.invoke('context:save', type, content),

  loadDefaultContext: (type: 'system' | 'user' | 'org') =>
    ipcRenderer.invoke('context:loadDefault', type),

  listContextProfiles: () =>
    ipcRenderer.invoke('context:listProfiles'),

  createContextProfile: (name: string) =>
    ipcRenderer.invoke('context:createProfile', name),

  setActiveContextProfile: (profileId: string) =>
    ipcRenderer.invoke('context:setActiveProfile', profileId),

  renameContextProfile: (profileId: string, name: string) =>
    ipcRenderer.invoke('context:renameProfile', profileId, name),

  deleteContextProfile: (profileId: string) =>
    ipcRenderer.invoke('context:deleteProfile', profileId),

  // ─── Conversations ───────────────────────────────────────────────────────

  listConversations: () =>
    ipcRenderer.invoke('db:listConversations'),

  searchConversations: (query: string) =>
    ipcRenderer.invoke('db:searchConversations', query),

  getConversation: (id: string) =>
    ipcRenderer.invoke('db:getConversation', id),

  createConversation: (data) =>
    ipcRenderer.invoke('db:createConversation', data),

  updateConversation: (id: string, data) =>
    ipcRenderer.invoke('db:updateConversation', id, data),

  deleteConversation: (id: string) =>
    ipcRenderer.invoke('db:deleteConversation', id),

  forkConversation: (conversationId: string, messageId: string) =>
    ipcRenderer.invoke('db:forkConversation', conversationId, messageId),

  // ─── Messages ────────────────────────────────────────────────────────────

  listMessages: (conversationId: string) =>
    ipcRenderer.invoke('db:listMessages', conversationId),


  selectBranch: (conversationId: string, messageId: string, options) =>
    ipcRenderer.invoke('db:selectBranch', conversationId, messageId, options),

  deleteMessageBranch: (conversationId: string, messageId: string) =>
    ipcRenderer.invoke('db:deleteMessageBranch', conversationId, messageId),

  // ─── Turns ───────────────────────────────────────────────────────────────

  startTurn: (request) =>
    ipcRenderer.invoke('turn:start', request),

  compactChat: (conversationId) =>
    ipcRenderer.invoke('turn:compact', conversationId),

  cancelTurn: (conversationId) =>
    ipcRenderer.invoke('turn:cancel', conversationId),

  listActiveTurns: () =>
    ipcRenderer.invoke('turn:listActive'),

  onTurnEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, turnEvent: unknown) => {
      if (turnEvent && typeof turnEvent === 'object') handler(turnEvent as TurnEvent)
    }
    ipcRenderer.on('turn:event', listener)
    return () => {
      ipcRenderer.removeListener('turn:event', listener)
    }
  },

  listModels: (provider: string) =>
    ipcRenderer.invoke('llm:listModels', provider),

  // ─── File history ────────────────────────────────────────────────────────

  listUndoableReplies: (conversationId) =>
    ipcRenderer.invoke('fileHistory:replies', conversationId),

  undoReplyFileChanges: (messageId) =>
    ipcRenderer.invoke('fileHistory:undo', messageId),

  // ─── Settings ────────────────────────────────────────────────────────────

  loadSettings: () =>
    ipcRenderer.invoke('settings:load'),

  saveSettings: (settings) =>
    ipcRenderer.invoke('settings:save', settings),

  getKeyStorage: () =>
    ipcRenderer.invoke('settings:keyStorage'),

  // ─── MCP Connections ─────────────────────────────────────────────────────

  getMcpStatus: () =>
    ipcRenderer.invoke('mcp:getStatus'),

  reconnectMcpServer: (serverId: string) =>
    ipcRenderer.invoke('mcp:reconnect', serverId),

  signInMcpServer: (serverId: string) =>
    ipcRenderer.invoke('mcp:signIn', serverId),

  cancelMcpSignIn: (serverId: string) =>
    ipcRenderer.invoke('mcp:cancelSignIn', serverId),

  signOutMcpServer: (serverId: string) =>
    ipcRenderer.invoke('mcp:signOut', serverId),

  onMcpStatus: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, statuses: unknown) => {
      if (Array.isArray(statuses)) handler(statuses as McpServerStatus[])
    }
    ipcRenderer.on('mcp:status', listener)
    return () => {
      ipcRenderer.removeListener('mcp:status', listener)
    }
  },

  // ─── Dialogs ─────────────────────────────────────────────────────────────

  showConfirmDialog: (options) =>
    ipcRenderer.invoke('dialog:confirm', options),

  openTextFile: () =>
    ipcRenderer.invoke('dialog:openTextFile'),

  openAttachmentFiles: () =>
    ipcRenderer.invoke('dialog:openAttachmentFiles'),

  parseAttachmentFiles: async (files) => {
    const safeFiles = Array.isArray(files) ? files : []
    const { paths, unresolved } = resolveAttachmentPaths(safeFiles)

    if (paths.length === 0) {
      return {
        attachments: [],
        failed: unresolved
      }
    }

    const result = await ipcRenderer.invoke('attachment:parseFiles', paths) as AttachmentParseResult
    return {
      attachments: result.attachments,
      failed: [...result.failed, ...unresolved]
    }
  },

  // ─── Storage ─────────────────────────────────────────────────────────────

  getStorageOverview: () =>
    ipcRenderer.invoke('storage:getOverview'),

  listChatStorage: () =>
    ipcRenderer.invoke('storage:listChats'),

  listStoredImages: () =>
    ipcRenderer.invoke('storage:listImages'),

  removeStoredImage: (blobId: string) =>
    ipcRenderer.invoke('storage:removeImage', blobId),

  compactDatabase: () =>
    ipcRenderer.invoke('storage:compact'),

  clearCaches: () =>
    ipcRenderer.invoke('storage:clearCaches'),

  // ─── Chat Export / Import ────────────────────────────────────────────────

  exportChat: (conversationId, format) =>
    ipcRenderer.invoke('chat:export', conversationId, format),

  importChat: () =>
    ipcRenderer.invoke('chat:import'),

  onMenuAction: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (action === 'exportChat' || action === 'importChat') {
        handler(action as MenuAction)
      }
    }
    ipcRenderer.on('menu:action', listener)
    return () => {
      ipcRenderer.removeListener('menu:action', listener)
    }
  }
}

contextBridge.exposeInMainWorld('redLedger', api)
