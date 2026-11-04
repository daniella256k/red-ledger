// ─── Provider Types ──────────────────────────────────────────────────────────

export type ProviderName = 'openai' | 'openrouter' | 'ollama' | 'lmstudio' | 'custom'

export interface ProviderSettings {
  apiKey: string
  baseUrl: string
  models: string[]
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
  /** Of promptTokens, how many the provider read from its prompt cache (when it says). */
  cachedTokens?: number
  /** Tokens the provider wrote to its prompt cache for later requests (when it says). */
  cacheWriteTokens?: number
  /** Prompt cache use over every request of the reply, when the provider reports it. */
  cache?: CacheUsage
}

/**
 * How much of a reply's input came from the provider's prompt cache. A reply
 * that calls tools makes several requests, each resending the chat so far;
 * a cached prefix is cheaper and faster to process.
 */
export interface CacheUsage {
  requests: number
  /** Input tokens across those requests. */
  promptTokens: number
  /** Of those, read from the cache. */
  readTokens: number
  /** Written to the cache, for later requests to read. */
  writeTokens: number
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
  /** Which model round of the turn made the call, from 1. Shown in the call's details. */
  round?: number
  /** How long the tool took to run; absent when it never ran (limit reached, unavailable). */
  durationMs?: number
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

// ─── Turns ───────────────────────────────────────────────────────────────────
//
// The main process runs each turn (a reply, or a compaction) from start to
// finish and saves it as it goes, so it carries on while you look at other
// chats, survives a page reload, and several chats can reply at once. The
// page asks for turns and follows them through turn events.

/** What to reply to: a new message, another answer to one, or an edited copy of one. */
export type TurnStartRequest =
  | { conversationId: string; kind: 'send'; content: string; attachments?: Attachment[] }
  | { conversationId: string; kind: 'retry'; userMessageId: string }
  | { conversationId: string; kind: 'edit'; userMessageId: string; content: string }

export type TurnKind = 'reply' | 'compact'

/** What a running turn is doing: waiting on the model, thinking, writing, or calling tools. */
export type TurnPhase = 'waiting' | 'thinking' | 'text' | 'tools'

/** A running turn, as far as it has got. */
export interface LiveTurn {
  turnId: string
  conversationId: string
  kind: TurnKind
  /** The reply being written; null for a compaction, which adds its summary at the end. */
  messageId: string | null
  /** Goes up with every update, so an older one is never applied over a newer one. */
  seq: number
  content: string
  thinking: string
  toolCalls: ToolCall[]
  phase: TurnPhase
}

export type TurnEvent =
  | { type: 'started'; turn: LiveTurn }
  /** The turn so far; toolCalls is left out when they haven't changed since the last update. */
  | {
    type: 'update'
    turnId: string
    conversationId: string
    seq: number
    content: string
    thinking: string
    phase: TurnPhase
    toolCalls?: ToolCall[]
  }
  | { type: 'notice'; conversationId: string; level: Toast['type']; message: string }
  /** The chat's saved record changed: title, request info, context use, or when it was updated. */
  | { type: 'conversation'; conversation: Conversation }
  /** A tool changed workspace files. */
  | { type: 'filesChanged'; conversationId: string }
  /** The turn is over and everything it wrote is saved. */
  | { type: 'finished'; turnId: string; conversationId: string; kind: TurnKind }

/** What asking for a compaction did: started, or nothing new since the last summary. */
export type CompactStartResult = 'started' | 'nothing_to_compact'

/** What undoing a reply's file changes did. */
export interface FileUndoResult {
  /** Files put back to how they were before the reply. */
  undone: string[]
  /** Files that couldn't be: too large to have been kept, or no longer reachable safely. */
  skipped: string[]
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
  /** An earlier assistant reply's thinking, for servers that need it sent back. */
  thinking?: string
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
  /** A folder whose contents were not all listed (too many files); list it on its own to see more. */
  truncated?: boolean
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string
  url: string
  /** Host without "www.", e.g. "nlrb.gov". */
  domain: string
  /** YYYY-MM-DD when the source gives a readable date; otherwise as given ("3 days ago"). */
  published?: string
  snippet: string
}

export type SearchRecency = 'day' | 'week' | 'month' | 'year'
export type SearchTopic = 'general' | 'news'

/** Optional narrowing for a web search. */
export interface SearchFilters {
  /** Only results from the past day, week, month or year. */
  recency?: SearchRecency
  /** "news" searches news coverage, which carries publish dates. */
  topic?: SearchTopic
  /** Only these sites (hostnames). */
  domains?: string[]
}

/** What web_search, org_search and wiki_search return. */
export interface SearchResponse extends SearchFilters {
  /** The query as sent, including any site: operator org_search added. */
  query: string
  backend: 'tavily' | 'serpapi' | 'wikipedia'
  results: SearchResult[]
  /** E.g. that results came from the fallback service, and why. */
  note?: string
}

/** What fetch_url returns: one part of a web page, PDF or text file. */
export interface FetchUrlResult {
  /** Final URL, after redirects. */
  url: string
  title: string
  site_name?: string
  byline?: string
  published?: string
  content_type: string
  /**
   * article: the page's main content, as Markdown; page: the whole page
   * without navigation, as Markdown; pdf: text extracted from a PDF;
   * text: a text format (plain, JSON, XML, CSV) as sent.
   */
  extraction: 'article' | 'page' | 'pdf' | 'text'
  content: string
  /** Character range of the whole document that `content` covers. */
  start_index: number
  end_index: number
  total_chars: number
  /** True when the document continues past this part. */
  truncated: boolean
  /** Where the next part starts; present while there is more. */
  next_start_index?: number
  note?: string
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
  /** Shows the branch through this message: its newest reply chain, or exactly up to it. */
  selectBranch(conversationId: string, messageId: string, options?: SelectBranchOptions): Promise<Message[]>
  /** Deletes a message and everything after it on any branch; returns the branch now on screen. */
  deleteMessageBranch(conversationId: string, messageId: string): Promise<Message[]>

  // Turns (see TurnEvent)
  /**
   * Starts a reply in a chat and returns the branch now on screen (with your
   * message and the empty reply). Fails if the chat is already replying.
   */
  startTurn(request: TurnStartRequest): Promise<Message[]>
  /** Has the model summarize the chat so far, to stand in for it from then on. */
  compactChat(conversationId: string): Promise<CompactStartResult>
  /** Stops the chat's running turn, if it has one. */
  cancelTurn(conversationId: string): Promise<void>
  /** Every running turn, as far as it has got (for catching up after a reload). */
  listActiveTurns(): Promise<LiveTurn[]>
  onTurnEvent(handler: (event: TurnEvent) => void): () => void

  listModels(provider: string): Promise<string[]>

  // File history
  /** Replies in a chat whose workspace file changes can be undone. */
  listUndoableReplies(conversationId: string): Promise<string[]>
  /** Asks, then undoes a reply's file changes; null when the user cancels. */
  undoReplyFileChanges(messageId: string): Promise<FileUndoResult | null>

  // Settings
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>
  /** Whether API keys are saved encrypted (OS keychain) or as plain text. */
  getKeyStorage(): Promise<'encrypted' | 'plain'>

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
