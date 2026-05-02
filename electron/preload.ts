import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AttachmentParseResult, MenuAction, RedLedgerAPI, StreamChunk } from '../src/types'

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

  writeFile: (relativePath: string, content: string, append?: boolean) =>
    ipcRenderer.invoke('fs:writeFile', relativePath, content, append),

  listFiles: (relativePath?: string) =>
    ipcRenderer.invoke('fs:listFiles', relativePath),

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

  createMessage: (data) =>
    ipcRenderer.invoke('db:createMessage', data),

  updateMessage: (id: string, data) =>
    ipcRenderer.invoke('db:updateMessage', id, data),

  deleteMessagesFrom: (conversationId: string, messageId: string) =>
    ipcRenderer.invoke('db:deleteMessagesFrom', conversationId, messageId),

  // ─── LLM Streaming ──────────────────────────────────────────────────────

  sendMessage: (request, onStream) => {
    // Generate a unique channel ID to prevent collisions between concurrent streams
    const channel = `llm:stream:${Date.now()}-${Math.random().toString(36).slice(2)}`

    const handler = (_event: Electron.IpcRendererEvent, chunk: unknown) => {
      onStream(chunk as Parameters<typeof onStream>[0])
    }

    ipcRenderer.on(channel, handler)
    void ipcRenderer.invoke('llm:sendMessage', request, channel).catch((err) => {
      ipcRenderer.removeListener(channel, handler)
      const message = err instanceof Error ? err.message : String(err)
      onStream({ type: 'error', error: message } as StreamChunk)
      onStream({ type: 'done' } as StreamChunk)
    })

    // Return cleanup function
    return () => {
      ipcRenderer.removeListener(channel, handler)
      ipcRenderer.invoke('llm:cancelStream', channel).catch(() => {
        // Stream may already be finished
      })
    }
  },

  listModels: (provider: string) =>
    ipcRenderer.invoke('llm:listModels', provider),

  generateTitle: (request) =>
    ipcRenderer.invoke('llm:generateTitle', request),

  // ─── Settings ────────────────────────────────────────────────────────────

  loadSettings: () =>
    ipcRenderer.invoke('settings:load'),

  saveSettings: (settings) =>
    ipcRenderer.invoke('settings:save', settings),

  // ─── Search ──────────────────────────────────────────────────────────────

  webSearch: (query: string, numResults?: number) =>
    ipcRenderer.invoke('search:web', query, numResults),

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
