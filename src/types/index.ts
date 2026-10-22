// ─── Provider Types ──────────────────────────────────────────────────────────

export type ProviderName = 'openai' | 'openrouter' | 'ollama' | 'lmstudio' | 'custom'
export type LMStudioCompatibility = 'openai' | 'lmstudio'

export interface ProviderSettings {
  apiKey: string
  baseUrl: string
  models: string[]
  compatibility?: LMStudioCompatibility
  selectedModel?: string
  favoriteModels?: string[]
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
  strictMode: boolean
  darkMode: boolean
  tavilyApiKey: string
  serpApiKey: string
  orgSite: string
  searchToolsEnabled: boolean
  /** Hides every tool that reaches the network (web/wiki/url tools, HTTP MCP servers). */
  offlineMode: boolean
  lastWorkspacePath: string | null
  providerSectionExpanded: boolean
  searchSectionExpanded: boolean
  advancedSectionExpanded: boolean
  connectionsSectionExpanded: boolean
  mcpServers: McpServerConfig[]
}

// ─── MCP Connections ─────────────────────────────────────────────────────────

/** 'stdio' launches a local command; 'http' talks to a Streamable HTTP endpoint. */
export type McpTransport = 'stdio' | 'http'

/**
 * Optional OAuth settings for a remote server. Most servers need none of
 * these: the app registers itself with the server's sign-in provider.
 */
export interface McpOAuthConfig {
  /** Pre-registered client, for providers without dynamic registration. */
  clientId?: string
  clientSecret?: string
  /** Space-separated scopes, when the server doesn't say which it needs. */
  scope?: string
  /** Fixed port for the http://127.0.0.1:<port>/callback redirect. */
  callbackPort?: number
}

export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Folder a local command runs in; defaults to the user's home folder. */
  cwd?: string
  url?: string
  headers?: Record<string, string>
  oauth?: McpOAuthConfig
  /** Tools (by the server's own names) the user switched off; new tools start on. */
  disabledTools?: string[]
  enabled: boolean
}

export interface McpToolInfo {
  name: string
  description?: string
}

/** 'needs_auth': a remote server that wants the user to sign in first. */
export type McpConnectionState = 'disabled' | 'connecting' | 'connected' | 'needs_auth' | 'error'

export interface McpServerStatus {
  id: string
  state: McpConnectionState
  toolCount: number
  error?: string
  /** Remote servers only: OAuth tokens are saved for this server. */
  signedIn?: boolean
  /** A browser sign-in is in progress. */
  signingIn?: boolean
  /** Every tool the server offers, switched off or not; only while connected. */
  tools?: McpToolInfo[]
}

export type McpSignInResult = { ok: true } | { ok: false; error: string; cancelled?: boolean }

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
  /** Context profile this chat's system prompt is built from (null = active profile). */
  profileId: string | null
  /** Snapshot of the settings used for the most recent request in this chat. */
  lastRequest?: ConversationRequestInfo | null
}

export interface ConversationRequestInfo {
  sentAt: string               // ISO 8601
  provider: ProviderName
  model: string
  temperature: number | null   // null = provider default
  maxTokens: number | null     // null = provider default
  reasoningEnabled: boolean
  searchToolsEnabled: boolean
  contextProfile: string | null
  /** Context used by the reply to this request; carried over from the previous one until it finishes. */
  usage?: ContextUsage | null
}

/** How much of the model's context window the last reply used. */
export interface ContextUsage {
  /** Tokens sent in the reply's final request: history, tool results and tool definitions. */
  promptTokens: number
  /** Tokens the model generated in that request. */
  completionTokens: number
  /** The model's context window, when the provider reports it. */
  contextLength: number | null
  /** True when the provider reported no usage and the counts are estimated from text length. */
  estimated: boolean
}

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * A chat is a tree of messages: a retry adds a sibling reply and an edit adds
 * a sibling prompt. The chat shows one branch at a time, from its first
 * message down to its active message.
 */
export interface Message {
  id: string
  conversationId: string
  /** The message this one answers or follows; null for a chat's first message. */
  parentId: string | null
  /**
   * This message and its alternatives (same parent), oldest first. Only set
   * when there is more than one, which is when the version switcher shows.
   */
  siblingIds?: string[]
  role: 'user' | 'assistant' | 'system'
  content: string
  attachments?: Attachment[]
  thinking?: string      // optional raw thinking/reasoning token stream
  toolCalls?: string     // JSON-serialized ToolCall[]
  timestamp: string      // ISO 8601 system timestamp captured when message was created
  createdAt: number
}

export interface CreateMessageInput {
  conversationId: string
  role: Message['role']
  content: string
  attachments?: Attachment[]
  thinking?: string
  toolCalls?: string
  /**
   * Where the message goes in the tree. Left out, it continues the branch on
   * screen; null starts a new first message; an id adds it under that message
   * (beside any existing replies, which is how edits branch).
   */
  parentId?: string | null
}

export interface SelectBranchOptions {
  /**
   * Stop at this message instead of continuing to its newest reply. A retry
   * uses it, so the new reply goes next to the old ones.
   */
  exact?: boolean
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
  /** Tool calls made while producing an earlier assistant reply, results included. */
  toolCalls?: ToolCall[]
}

// ─── Stream Chunks ───────────────────────────────────────────────────────────

export interface StreamChunk {
  /**
   * 'notice' is a non-fatal heads-up for the user (e.g. tool call limit reached).
   * 'usage' carries token counts: per request from providers, once per turn to the renderer.
   */
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'notice' | 'usage' | 'error' | 'done'
  content?: string
  toolCall?: ToolCall
  usage?: ContextUsage
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
  /** The image as a data: URL, while it is being composed. Saved messages carry blobId instead. */
  dataUrl?: string
  /** SHA-256 of the image bytes in the database's attachment store. */
  blobId?: string
  /** Size of the stored image in bytes. */
  size?: number
  /** The user removed this image to free space: only its name is left. */
  removed?: boolean
}

export type Attachment = TextAttachment | ImageAttachment

export interface AttachmentParseResult {
  attachments: Attachment[]
  failed: string[]
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface StorageOverview {
  /** The database file and its write-ahead log on disk. */
  databaseBytes: number
  /** Free space inside the database file that Compact gives back to the disk. */
  reclaimableBytes: number
  /** Stored image attachments, each counted once. */
  imageBytes: number
  /** Chromium's caches in the app profile: safe to clear, rebuilt as needed. */
  cacheBytes: number
}

export interface ChatStorageInfo {
  conversationId: string
  title: string
  isPinned: boolean
  updatedAt: number
  messageCount: number
  imageCount: number
  /** Message text, reasoning, tool calls and text attachments. */
  textBytes: number
  /** Images in this chat; an image shared with a fork counts in both. */
  imageBytes: number
  totalBytes: number
}

export interface StoredImageInfo {
  blobId: string
  name: string
  mimeType: ImageAttachmentMimeType
  bytes: number
  /** When the image was first sent. */
  firstSentAt: number
  /** Most recent activity among the chats that use it. */
  lastChatActivityAt: number
  /** Every chat that uses the image (forks share it). */
  chats: Array<{ conversationId: string; title: string }>
}

export interface RemoveImageResult {
  freedBytes: number
  conversationIds: string[]
}

export interface CompactResult {
  beforeBytes: number
  afterBytes: number
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
  | 'MCP_ERROR'
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
  showInFolder(relativePath: string): Promise<void>

  // Context Files
  loadContext(type: 'system' | 'user' | 'org'): Promise<string>
  saveContext(type: 'system' | 'user' | 'org', content: string): Promise<void>
  loadDefaultContext(type: 'system' | 'user' | 'org'): Promise<string>
  listContextProfiles(): Promise<{ profiles: ContextProfile[]; activeProfileId: string }>
  createContextProfile(name: string): Promise<{ profiles: ContextProfile[]; activeProfileId: string }>
  setActiveContextProfile(profileId: string): Promise<{ profiles: ContextProfile[]; activeProfileId: string }>
  renameContextProfile(profileId: string, name: string): Promise<{ profiles: ContextProfile[]; activeProfileId: string }>
  deleteContextProfile(profileId: string): Promise<{ profiles: ContextProfile[]; activeProfileId: string }>

  // Conversations
  listConversations(): Promise<Conversation[]>
  searchConversations(query: string): Promise<Conversation[]>
  getConversation(id: string): Promise<Conversation | null>
  createConversation(data: Partial<Conversation>): Promise<Conversation>
  updateConversation(id: string, data: Partial<Conversation>): Promise<void>
  deleteConversation(id: string): Promise<void>
  forkConversation(conversationId: string, messageId: string): Promise<Conversation>

  // Messages (listMessages returns the branch on screen, first message first)
  listMessages(conversationId: string): Promise<Message[]>
  createMessage(data: CreateMessageInput): Promise<Message>
  updateMessage(id: string, data: Partial<Message>): Promise<void>
  /** Shows the branch through this message: its newest reply chain, or exactly up to it. */
  selectBranch(conversationId: string, messageId: string, options?: SelectBranchOptions): Promise<Message[]>
  /** Deletes a message and everything after it on any branch; returns the branch now on screen. */
  deleteMessageBranch(conversationId: string, messageId: string): Promise<Message[]>

  // LLM Streaming
  sendMessage(request: LLMRequest, onStream: (chunk: StreamChunk) => void): () => void
  listModels(provider: string): Promise<string[]>
  generateTitle(request: TitleGenerationRequest): Promise<string | null>

  // Settings
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>

  // Search
  webSearch(query: string, numResults?: number): Promise<SearchResult[]>

  // MCP Connections
  getMcpStatus(): Promise<McpServerStatus[]>
  reconnectMcpServer(serverId: string): Promise<void>
  /** Browser OAuth sign-in for a remote server; resolves when it finishes, fails or is cancelled. */
  signInMcpServer(serverId: string): Promise<McpSignInResult>
  cancelMcpSignIn(serverId: string): Promise<void>
  signOutMcpServer(serverId: string): Promise<void>
  onMcpStatus(handler: (statuses: McpServerStatus[]) => void): () => void

  // Dialogs
  showConfirmDialog(options: { title: string; message: string; detail?: string }): Promise<boolean>
  openTextFile(): Promise<string | null>
  openAttachmentFiles(): Promise<Attachment[]>
  parseAttachmentFiles(files: File[]): Promise<AttachmentParseResult>

  // Storage
  getStorageOverview(): Promise<StorageOverview>
  listChatStorage(): Promise<ChatStorageInfo[]>
  listStoredImages(): Promise<StoredImageInfo[]>
  /** Removes an image from every message that uses it and deletes its bytes. */
  removeStoredImage(blobId: string): Promise<RemoveImageResult>
  compactDatabase(): Promise<CompactResult>
  clearCaches(): Promise<void>

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
