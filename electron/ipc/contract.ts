/**
 * Central IPC contract — single source of truth for all IPC channels.
 *
 * Both the main-process handlers and the preload API derive from these types.
 * Events the main process sends on its own (turn:event, mcp:status,
 * menu:action) don't fit invoke/handle; their payloads are typed in src/types.
 */
import type {
  Conversation, Message, Settings, FileNode, SearchResult,
  Attachment, AttachmentParseResult, ContextProfile,
  McpServerStatus, McpSignInResult,
  StorageOverview, ChatStorageInfo, StoredImageInfo, RemoveImageResult, CompactResult,
  CreateMessageInput, SelectBranchOptions, FileUndoResult,
  TurnStartRequest, CompactStartResult, LiveTurn
} from '../../src/types'

export type ChatExportFormat = 'markdown' | 'xml'

export type ChatExportResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string }

export type ChatImportResult =
  | { ok: true; conversation: Conversation; importedMessageCount: number }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string }

// ─── Helper types used only by the contract ─────────────────────────────────

export type ContextType = 'system' | 'user' | 'org'
export interface ContextProfileState {
  profiles: ContextProfile[]
  activeProfileId: string
}

export type CreateMessageData = CreateMessageInput

export interface ConfirmDialogOptions {
  title: string
  message: string
  detail?: string
}

// ─── Invoke/Handle contract ─────────────────────────────────────────────────

export interface IpcContract {
  // Conversations
  'db:listConversations':       { params: [];                                          result: Conversation[] }
  'db:searchConversations':     { params: [query: string];                             result: Conversation[] }
  'db:getConversation':         { params: [id: string];                                result: Conversation | null }
  'db:createConversation':      { params: [data: Partial<Conversation>];               result: Conversation }
  'db:updateConversation':      { params: [id: string, data: Partial<Conversation>];   result: void }
  'db:deleteConversation':      { params: [id: string];                                result: void }
  'db:forkConversation':        { params: [conversationId: string, messageId: string]; result: Conversation }

  // Messages
  'db:listMessages':            { params: [conversationId: string];                    result: Message[] }
  'db:createMessage':           { params: [data: CreateMessageData];                   result: Message }
  'db:selectBranch':            { params: [conversationId: string, messageId: string, options?: SelectBranchOptions]; result: Message[] }
  'db:deleteMessageBranch':     { params: [conversationId: string, messageId: string]; result: Message[] }

  // Workspace & Files
  'fs:selectWorkspace':         { params: [];                                          result: string | null }
  'fs:readFile':                { params: [relativePath: string];                      result: string }
  'fs:writeFile':               { params: [relativePath: string, content: string, append?: boolean]; result: void }
  'fs:listFiles':               { params: [relativePath?: string];                     result: FileNode[] }
  'fs:showInFolder':            { params: [relativePath: string];                      result: void }

  // Context
  'context:load':               { params: [type: ContextType];                         result: string }
  'context:save':               { params: [type: ContextType, content: string];        result: void }
  'context:loadDefault':        { params: [type: ContextType];                         result: string }
  'context:listProfiles':       { params: [];                                           result: ContextProfileState }
  'context:createProfile':      { params: [name: string];                               result: ContextProfileState }
  'context:setActiveProfile':   { params: [profileId: string];                          result: ContextProfileState }
  'context:renameProfile':      { params: [profileId: string, name: string];            result: ContextProfileState }
  'context:deleteProfile':      { params: [profileId: string];                          result: ContextProfileState }

  // Settings
  'settings:load':              { params: [];                                          result: Settings }
  'settings:save':              { params: [settings: Settings];                        result: void }
  'settings:keyStorage':        { params: [];                                          result: 'encrypted' | 'plain' }

  // Search
  'search:web':                 { params: [query: string, numResults?: number];        result: SearchResult[] }

  // MCP connections
  'mcp:getStatus':              { params: [];                                          result: McpServerStatus[] }
  'mcp:reconnect':              { params: [serverId: string];                          result: void }
  'mcp:signIn':                 { params: [serverId: string];                          result: McpSignInResult }
  'mcp:cancelSignIn':           { params: [serverId: string];                          result: void }
  'mcp:signOut':                { params: [serverId: string];                          result: void }

  // LLM
  'llm:listModels':             { params: [provider: string];                          result: string[] }

  // Turns (run in the main process; followed through turn:event)
  'turn:start':                 { params: [request: TurnStartRequest];                 result: Message[] }
  'turn:compact':               { params: [conversationId: string];                    result: CompactStartResult }
  'turn:cancel':                { params: [conversationId: string];                    result: void }
  'turn:listActive':            { params: [];                                          result: LiveTurn[] }

  // File history (undo a reply's file changes)
  'fileHistory:replies':        { params: [conversationId: string];                    result: string[] }
  'fileHistory:undo':           { params: [messageId: string];                         result: FileUndoResult | null }

  // Dialogs
  'dialog:confirm':             { params: [options: ConfirmDialogOptions];             result: boolean }
  'dialog:openTextFile':        { params: [];                                          result: string | null }
  'dialog:openAttachmentFiles': { params: [];                                          result: Attachment[] }
  'attachment:parseFiles':      { params: [filePaths: string[]];                       result: AttachmentParseResult }

  // Storage
  'storage:getOverview':        { params: [];                                          result: StorageOverview }
  'storage:listChats':          { params: [];                                          result: ChatStorageInfo[] }
  'storage:listImages':         { params: [];                                          result: StoredImageInfo[] }
  'storage:removeImage':        { params: [blobId: string];                            result: RemoveImageResult }
  'storage:compact':            { params: [];                                          result: CompactResult }
  'storage:clearCaches':        { params: [];                                          result: void }

  // Chat import/export
  'chat:export':                { params: [conversationId: string, format: ChatExportFormat]; result: ChatExportResult }
  'chat:import':                { params: [];                                          result: ChatImportResult }
}

// ─── Derived helper types ───────────────────────────────────────────────────

export type IpcChannel = keyof IpcContract
export type IpcParams<C extends IpcChannel> = IpcContract[C]['params']
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result']
