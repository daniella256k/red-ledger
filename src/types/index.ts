// ─── Provider Types ──────────────────────────────────────────────────────────

export type ProviderName = 'openai' | 'openrouter' | 'ollama' | 'lmstudio'
export type LMStudioCompatibility = 'openai' | 'lmstudio'

export interface ProviderSettings {
  apiKey: string
  baseUrl: string
  models: string[]
  compatibility?: LMStudioCompatibility
  selectedModel?: string
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface Settings {
  activeProvider: ProviderName
  providers: Record<ProviderName, ProviderSettings>
  defaultModel: string
  reasoningEnabled: boolean
  temperatureEnabled: boolean
  temperature: number     // 0.0–2.0
  maxTokensEnabled: boolean
  maxTokens: number       // 1–128000
  maxToolCalls: number    // 1-25
  strictMode: boolean
  darkMode: boolean
  tavilyApiKey: string
  serpApiKey: string
  orgSite: string
  searchToolsEnabled: boolean
  lastWorkspacePath: string | null
  providerSectionExpanded: boolean
  searchSectionExpanded: boolean
  advancedSectionExpanded: boolean
}

// ─── Conversations ───────────────────────────────────────────────────────────

export interface Conversation {
  id: string
  title: string
  model: string
  provider: ProviderName
  isPinned: boolean
  createdAt: number
  updatedAt: number
  workspacePath: string | null
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  attachments?: Attachment[]
  thinking?: string      // optional raw thinking/reasoning token stream
  toolCalls?: string     // JSON-serialized ToolCall[]
  timestamp: string      // ISO 8601 system timestamp captured when message was created
  createdAt: number
}

// ─── Tool Calls ──────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  result?: unknown
  /** Character offset into Message.content where this tool call was initiated. */
  contentOffset?: number
}

// ─── LLM Request ─────────────────────────────────────────────────────────────

export interface LLMRequest {
  conversationId: string
  messages: LLMRequestMessage[]
  model: string
  provider: ProviderName
  temperature?: number
  maxTokens?: number
}

export interface TitleGenerationRequest {
  prompt: string
  model: string
  provider: ProviderName
  maxTokens?: number
}

export interface LLMRequestMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  attachments?: Attachment[]
}

// ─── Stream Chunks ───────────────────────────────────────────────────────────

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'done'
  content?: string
  toolCall?: ToolCall
  error?: string
}

// ─── File Tree ───────────────────────────────────────────────────────────────

export interface FileNode {
  name: string
  path: string       // Relative to workspace root, forward slashes
  type: 'file' | 'directory'
  children?: FileNode[]
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

// ─── Attachments ─────────────────────────────────────────────────────────

export interface TextAttachment {
  kind?: 'text'
  name: string
  content: string
}

export type ImageAttachmentMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'

export interface ImageAttachment {
  kind: 'image'
  name: string
  mimeType: ImageAttachmentMimeType
  dataUrl: string
}

export type Attachment = TextAttachment | ImageAttachment

export interface AttachmentParseResult {
  attachments: Attachment[]
  failed: string[]
}

// --- Context Profiles ---

export interface ContextProfile {
  id: string
  name: string
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'PATH_TRAVERSAL'
  | 'FILE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'WORKSPACE_NOT_SET'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'INVALID_INPUT'
  | 'DATABASE_ERROR'
  | 'USER_DENIED'
  | 'UNKNOWN'

// ─── Chat Import/Export ─────────────────────────────────────────────────────

export type ChatExportFormat = 'markdown' | 'xml'

export type ChatExportResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string }

export type ChatImportResult =
  | { ok: true; conversation: Conversation; importedMessageCount: number }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string }

export type MenuAction = 'exportChat' | 'importChat'

// ─── Toast ───────────────────────────────────────────────────────────────────

export interface Toast {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
  duration?: number | null
}

// ─── IPC API (exposed via contextBridge as window.redLedger) ─────────────────

export interface RedLedgerAPI {
  // Workspace & File Operations
  selectWorkspace(): Promise<string | null>
  readFile(relativePath: string): Promise<string>
  writeFile(relativePath: string, content: string, append?: boolean): Promise<void>
  listFiles(relativePath?: string): Promise<FileNode[]>

  // Context Files
  loadContext(type: 'system' | 'user' | 'org'): Promise<string>
  saveContext(type: 'system' | 'user' | 'org', content: string): Promise<void>
  loadDefaultContext(type: 'system' | 'user' | 'org'): Promise<string>
  listContextProfiles(): Promise<{ profiles: ContextProfile[]; activeProfileId: string }>
  createContextProfile(name: string): Promise<{ profiles: ContextProfile[]; activeProfileId: string }>
  setActiveContextProfile(profileId: string): Promise<{ profiles: ContextProfile[]; activeProfileId: string }>
  deleteContextProfile(profileId: string): Promise<{ profiles: ContextProfile[]; activeProfileId: string }>

  // Conversations
  listConversations(): Promise<Conversation[]>
  searchConversations(query: string): Promise<Conversation[]>
  getConversation(id: string): Promise<Conversation | null>
  createConversation(data: Partial<Conversation>): Promise<Conversation>
  updateConversation(id: string, data: Partial<Conversation>): Promise<void>
  deleteConversation(id: string): Promise<void>
  forkConversation(conversationId: string, messageId: string): Promise<Conversation>

  // Messages
  listMessages(conversationId: string): Promise<Message[]>
  createMessage(data: Omit<Message, 'id' | 'createdAt' | 'timestamp'>): Promise<Message>
  updateMessage(id: string, data: Partial<Message>): Promise<void>
  deleteMessagesFrom(conversationId: string, messageId: string): Promise<void>

  // LLM Streaming
  sendMessage(request: LLMRequest, onStream: (chunk: StreamChunk) => void): () => void
  listModels(provider: string): Promise<string[]>
  generateTitle(request: TitleGenerationRequest): Promise<string | null>

  // Settings
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>

  // Search
  webSearch(query: string, numResults?: number): Promise<SearchResult[]>

  // Dialogs
  showConfirmDialog(options: { title: string; message: string; detail?: string }): Promise<boolean>
  openTextFile(): Promise<string | null>
  openAttachmentFiles(): Promise<Attachment[]>
  parseAttachmentFiles(files: File[]): Promise<AttachmentParseResult>

  // Chat Export / Import
  exportChat(conversationId: string, format: ChatExportFormat): Promise<ChatExportResult>
  importChat(): Promise<ChatImportResult>
  onMenuAction(handler: (action: MenuAction) => void): () => void
}

// Extend Window interface for the renderer
declare global {
  interface Window {
    redLedger: RedLedgerAPI
  }
}
