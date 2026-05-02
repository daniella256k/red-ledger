import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import type { Attachment, Conversation, Message, ImageAttachmentMimeType } from '../../src/types'

const SUPPORTED_IMAGE_MIME_TYPES = new Set<ImageAttachmentMimeType>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
])

function parseAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string') return null

  if (record.kind === 'image') {
    if (typeof record.mimeType !== 'string' || !SUPPORTED_IMAGE_MIME_TYPES.has(record.mimeType as ImageAttachmentMimeType)) {
      return null
    }
    if (typeof record.dataUrl !== 'string' || record.dataUrl.length === 0) {
      return null
    }
    const mimeType = record.mimeType as ImageAttachmentMimeType
    return {
      kind: 'image',
      name: record.name,
      mimeType,
      dataUrl: record.dataUrl
    }
  }

  if (typeof record.content !== 'string') return null

  return {
    kind: 'text',
    name: record.name,
    content: record.content
  }
}

/**
 * Domain service for conversations and messages.
 * Owns the SQLite database lifecycle, schema, and all CRUD operations.
 * No Electron imports — testable with plain Node.
 */
export class ConversationService {
  private db: Database.Database
  private statements: Map<string, Database.Statement> = new Map()

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3')
    this.db = new BetterSqlite3(dbPath) as Database.Database

    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.createTables()
  }

  // ─── Schema ───────────────────────────────────────────────────────────────

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New Chat',
        model TEXT NOT NULL DEFAULT 'gpt-4',
        provider TEXT NOT NULL DEFAULT 'openai'
          CHECK(provider IN ('openai', 'openrouter', 'ollama', 'lmstudio')),
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        workspace_path TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        attachments TEXT,
        thinking TEXT,
        tool_calls TEXT,
        timestamp TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `)

    // Migration path for existing databases created before pinning support.
    const conversationColumns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    if (!conversationColumns.some((column) => column.name === 'is_pinned')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0')
    }

    this.migrateConversationProviderConstraintIfNeeded()

    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
       CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
       CREATE INDEX IF NOT EXISTS idx_conversations_pinned_updated ON conversations(is_pinned DESC, updated_at DESC);`
    )
  }

  private migrateConversationProviderConstraintIfNeeded(): void {
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
      .get() as { sql?: string } | undefined

    if (!schema || typeof schema.sql !== 'string') return
    if (schema.sql.toLowerCase().includes("'lmstudio'")) return

    this.db.exec('PRAGMA foreign_keys = OFF')
    try {
      const migrate = this.db.transaction(() => {
        this.db.exec(`
          DROP TABLE IF EXISTS conversations_new;

          CREATE TABLE conversations_new (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New Chat',
            model TEXT NOT NULL DEFAULT 'gpt-4',
            provider TEXT NOT NULL DEFAULT 'openai'
              CHECK(provider IN ('openai', 'openrouter', 'ollama', 'lmstudio')),
            is_pinned INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            workspace_path TEXT
          );

          INSERT INTO conversations_new (id, title, model, provider, is_pinned, created_at, updated_at, workspace_path)
          SELECT
            id,
            title,
            model,
            CASE
              WHEN provider IN ('openai', 'openrouter', 'ollama', 'lmstudio') THEN provider
              ELSE 'openai'
            END,
            COALESCE(is_pinned, 0),
            created_at,
            updated_at,
            workspace_path
          FROM conversations;

          DROP TABLE conversations;
          ALTER TABLE conversations_new RENAME TO conversations;
        `)
      })

      migrate()
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON')
    }
  }

  // ─── Column Mapping ───────────────────────────────────────────────────────

  private toConversation(row: Record<string, unknown>): Conversation {
    return {
      id: row.id as string,
      title: row.title as string,
      model: row.model as string,
      provider: row.provider as Conversation['provider'],
      isPinned: Boolean(row.is_pinned),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      workspacePath: row.workspace_path as string | null
    }
  }

  private toMessage(row: Record<string, unknown>): Message {
    let attachments: Attachment[] | undefined
    if (typeof row.attachments === 'string' && row.attachments.length > 0) {
      try {
        const parsed = JSON.parse(row.attachments) as unknown
        if (Array.isArray(parsed)) {
          attachments = parsed
            .map((item) => parseAttachment(item))
            .filter((item): item is Attachment => item !== null)
        }
      } catch {
        attachments = undefined
      }
    }

    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      attachments,
      thinking: typeof row.thinking === 'string' ? row.thinking : undefined,
      toolCalls: typeof row.tool_calls === 'string' ? row.tool_calls : undefined,
      timestamp: row.timestamp as string,
      createdAt: row.created_at as number
    }
  }

  private buildForkTitle(sourceTitle: string): string {
    const trimmed = sourceTitle.trim()
    const base = trimmed.length > 0 ? trimmed : 'New Chat'
    return base.endsWith(' (Fork)')
      ? base
      : `${base} (Fork)`
  }

  private touchConversation(conversationId: string, updatedAt: number): void {
    this.stmt(
      'touchConversation',
      'UPDATE conversations SET updated_at = ? WHERE id = ?'
    ).run(updatedAt, conversationId)
  }

  private touchConversationForMessage(messageId: string, updatedAt: number): void {
    this.stmt(
      'touchConversationForMessage',
      `UPDATE conversations
       SET updated_at = ?
       WHERE id = (
         SELECT conversation_id
         FROM messages
         WHERE id = ?
       )`
    ).run(updatedAt, messageId)
  }

  // ─── Prepared Statement Cache ─────────────────────────────────────────────

  private stmt(key: string, sql: string): Database.Statement {
    if (!this.statements.has(key)) {
      this.statements.set(key, this.db.prepare(sql))
    }
    return this.statements.get(key)!
  }

  // ─── Conversation CRUD ────────────────────────────────────────────────────

  listConversations(): Conversation[] {
    const rows = this.stmt(
      'listConversations',
      'SELECT * FROM conversations ORDER BY is_pinned DESC, updated_at DESC'
    ).all() as Record<string, unknown>[]

    return rows.map(r => this.toConversation(r))
  }

  searchConversations(query: string): Conversation[] {
    const trimmed = query.trim()
    if (trimmed.length === 0) return this.listConversations()

    const escaped = trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    const pattern = `%${escaped}%`

    const rows = this.stmt(
      'searchConversations',
      `SELECT c.*
         FROM conversations c
        WHERE c.title LIKE ? ESCAPE '\\'
           OR EXISTS (
             SELECT 1 FROM messages m
              WHERE m.conversation_id = c.id
                AND m.content LIKE ? ESCAPE '\\'
           )
        ORDER BY c.is_pinned DESC, c.updated_at DESC`
    ).all(pattern, pattern) as Record<string, unknown>[]

    return rows.map(r => this.toConversation(r))
  }

  getConversation(id: string): Conversation | null {
    const row = this.stmt(
      'getConversation',
      'SELECT * FROM conversations WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined

    return row ? this.toConversation(row) : null
  }

  createConversation(data: Partial<Conversation>): Conversation {
    const id = uuidv4()
    const now = Date.now()

    this.stmt(
      'createConversation',
      `INSERT INTO conversations (id, title, model, provider, is_pinned, created_at, updated_at, workspace_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.title || 'New Chat',
      data.model || 'gpt-4',
      data.provider || 'openai',
      data.isPinned ? 1 : 0,
      now,
      now,
      data.workspacePath || null
    )

    return this.toConversation(
      this.stmt('getConversation', 'SELECT * FROM conversations WHERE id = ?')
        .get(id) as Record<string, unknown>
    )
  }

  updateConversation(id: string, data: Partial<Conversation>): void {
    const now = Date.now()
    const shouldUpdateWorkspacePath = data.workspacePath !== undefined
    const shouldUpdatePinned = data.isPinned !== undefined
    const shouldBumpUpdatedAt =
      data.title !== undefined ||
      data.model !== undefined ||
      data.provider !== undefined ||
      shouldUpdateWorkspacePath

    this.stmt(
      'updateConversation',
      `UPDATE conversations SET
        title = COALESCE(?, title),
        model = COALESCE(?, model),
        provider = COALESCE(?, provider),
        is_pinned = CASE
          WHEN ? = 1 THEN ?
          ELSE is_pinned
        END,
        updated_at = CASE
          WHEN ? = 1 THEN ?
          ELSE updated_at
        END,
        workspace_path = CASE
          WHEN ? = 1 THEN ?
          ELSE workspace_path
        END
       WHERE id = ?`
    ).run(
      data.title ?? null,
      data.model ?? null,
      data.provider ?? null,
      shouldUpdatePinned ? 1 : 0,
      data.isPinned ? 1 : 0,
      shouldBumpUpdatedAt ? 1 : 0,
      now,
      shouldUpdateWorkspacePath ? 1 : 0,
      data.workspacePath ?? null,
      id
    )
  }

  deleteConversation(id: string): void {
    const deleteInTransaction = this.db.transaction((convId: string) => {
      this.stmt(
        'deleteMessages',
        'DELETE FROM messages WHERE conversation_id = ?'
      ).run(convId)

      this.stmt(
        'deleteConversation',
        'DELETE FROM conversations WHERE id = ?'
      ).run(convId)
    })

    deleteInTransaction(id)
  }

  forkConversation(conversationId: string, messageId: string): Conversation {
    const sourceConversation = this.stmt(
      'getConversationForFork',
      'SELECT * FROM conversations WHERE id = ?'
    ).get(conversationId) as Record<string, unknown> | undefined

    if (!sourceConversation) {
      throw new Error(`Conversation not found: ${conversationId}`)
    }

    const cutoff = this.stmt(
      'getForkCutoff',
      'SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?'
    ).get(messageId, conversationId) as { rowid: number } | undefined

    if (!cutoff) {
      throw new Error(`Message not found in conversation: ${messageId}`)
    }

    const sourceMessages = this.stmt(
      'listMessagesForFork',
      `SELECT role, content, attachments, thinking, tool_calls, timestamp, created_at
       FROM messages
       WHERE conversation_id = ? AND rowid <= ?
       ORDER BY rowid ASC`
    ).all(conversationId, cutoff.rowid) as Array<{
      role: Message['role']
      content: string
      attachments: string | null
      thinking: string | null
      tool_calls: string | null
      timestamp: string
      created_at: number
    }>

    const forkConversationId = uuidv4()
    const now = Date.now()
    const forkTitle = this.buildForkTitle(sourceConversation.title as string)

    const forkInTransaction = this.db.transaction(() => {
      this.stmt(
        'createForkConversation',
        `INSERT INTO conversations (id, title, model, provider, is_pinned, created_at, updated_at, workspace_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        forkConversationId,
        forkTitle,
        sourceConversation.model as string,
        sourceConversation.provider as Conversation['provider'],
        0,
        now,
        now,
        sourceConversation.workspace_path as string | null
      )

      const insertForkMessage = this.stmt(
        'insertForkMessage',
        `INSERT INTO messages (id, conversation_id, role, content, attachments, thinking, tool_calls, timestamp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )

      for (const message of sourceMessages) {
        insertForkMessage.run(
          uuidv4(),
          forkConversationId,
          message.role,
          message.content,
          message.attachments,
          message.thinking,
          message.tool_calls,
          message.timestamp,
          message.created_at
        )
      }
    })

    forkInTransaction()

    return this.toConversation(
      this.stmt('getConversation', 'SELECT * FROM conversations WHERE id = ?')
        .get(forkConversationId) as Record<string, unknown>
    )
  }

  // ─── Message CRUD ─────────────────────────────────────────────────────────

  listMessages(conversationId: string): Message[] {
    const rows = this.stmt(
      'listMessages',
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC'
    ).all(conversationId) as Record<string, unknown>[]

    return rows.map(r => this.toMessage(r))
  }

  createMessage(data: Omit<Message, 'id' | 'createdAt' | 'timestamp'>): Message {
    const id = uuidv4()
    const now = Date.now()
    const timestamp = new Date().toISOString()

    const createInTransaction = this.db.transaction(() => {
      this.stmt(
        'createMessage',
        `INSERT INTO messages (id, conversation_id, role, content, attachments, thinking, tool_calls, timestamp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        data.conversationId,
        data.role,
        data.content,
        data.attachments && data.attachments.length > 0 ? JSON.stringify(data.attachments) : null,
        data.thinking ?? null,
        data.toolCalls || null,
        timestamp,
        now
      )

      // Bump parent conversation's updatedAt
      this.touchConversation(data.conversationId, now)
    })

    createInTransaction()

    return this.toMessage(
      this.stmt(
        'getMessage',
        'SELECT * FROM messages WHERE id = ?'
      ).get(id) as Record<string, unknown>
    )
  }

  updateMessage(id: string, data: Partial<Message>): void {
    const shouldUpdateMessage =
      data.content !== undefined ||
      data.thinking !== undefined ||
      data.toolCalls !== undefined

    if (!shouldUpdateMessage) return

    const now = Date.now()

    const updateInTransaction = this.db.transaction(() => {
      const result = this.stmt(
        'updateMessage',
        `UPDATE messages SET
          content = COALESCE(?, content),
          thinking = COALESCE(?, thinking),
          tool_calls = COALESCE(?, tool_calls)
         WHERE id = ?`
      ).run(
        data.content ?? null,
        data.thinking ?? null,
        data.toolCalls ?? null,
        id
      )

      if (result.changes > 0) {
        this.touchConversationForMessage(id, now)
      }
    })

    updateInTransaction()
  }

  deleteMessagesFrom(conversationId: string, messageId: string): void {
    const now = Date.now()

    const deleteInTransaction = this.db.transaction(() => {
      const row = this.stmt(
        'getConversationMessage',
        'SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?'
      ).get(messageId, conversationId) as { rowid: number } | undefined

      if (!row) return

      this.stmt(
        'deleteMessagesFrom',
        'DELETE FROM messages WHERE conversation_id = ? AND rowid >= ?'
      ).run(conversationId, row.rowid)

      this.touchConversation(conversationId, now)
    })

    deleteInTransaction()
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.statements.clear()
    this.db.close()
  }
}
