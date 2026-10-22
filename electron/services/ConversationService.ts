import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { DEFAULT_MODEL, DEFAULT_PROVIDER, isProviderName } from '../../src/lib/providers'
import { BLOB_ID_PATTERN, isImageMimeType } from '../../src/lib/attachments'
import type {
  Attachment,
  ChatStorageInfo,
  Conversation,
  ConversationRequestInfo,
  CreateMessageInput,
  ImageAttachment,
  Message,
  ImageAttachmentMimeType,
  RemoveImageResult,
  SelectBranchOptions,
  StoredImageInfo
} from '../../src/types'

function parseRequestInfo(value: unknown): ConversationRequestInfo | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ConversationRequestInfo
      : null
  } catch {
    return null
  }
}

function parseAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string') return null

  if (record.kind === 'image') {
    if (!isImageMimeType(record.mimeType)) return null
    const image: ImageAttachment = {
      kind: 'image',
      name: record.name,
      mimeType: record.mimeType,
      ...(typeof record.size === 'number' ? { size: record.size } : {})
    }
    if (record.removed === true) return { ...image, removed: true }
    if (typeof record.blobId === 'string' && BLOB_ID_PATTERN.test(record.blobId)) {
      return { ...image, blobId: record.blobId }
    }
    // Left inline only if the move to the attachment store couldn't read it.
    if (typeof record.dataUrl === 'string' && record.dataUrl.length > 0) {
      return { ...image, dataUrl: record.dataUrl }
    }
    return null
  }

  if (typeof record.content !== 'string') return null

  return {
    kind: 'text',
    name: record.name,
    content: record.content
  }
}

/** Guards the tree walks against a damaged tree with a loop; real chats are far shallower. */
const MAX_BRANCH_DEPTH = 100_000

/** A message and every message below it, on all branches. Bind the message id. */
const SUBTREE_CTE = `WITH RECURSIVE subtree(id, depth) AS (
  SELECT ?, 0
  UNION ALL
  SELECT m.id, subtree.depth + 1
    FROM messages m
    JOIN subtree ON m.parent_id = subtree.id
   WHERE subtree.depth < ${MAX_BRANCH_DEPTH}
)`

/** The bytes of a base64 data: URL, or null if it isn't one. */
function decodeDataUrl(dataUrl: string): Buffer | null {
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || comma === -1) return null
  if (!dataUrl.slice(0, comma).endsWith(';base64')) return null
  const data = Buffer.from(dataUrl.slice(comma + 1), 'base64')
  return data.length > 0 ? data : null
}

function hashBytes(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function parseAttachmentList(json: unknown): unknown[] {
  if (typeof json !== 'string' || json.length === 0) return []
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

/** Messages' attachments as stored, with images moved to the attachment store. */
interface PreparedAttachments {
  json: string | null
  blobIds: string[]
}

/** A stored image's bytes. */
export interface AttachmentBlob {
  mimeType: string
  data: Buffer
}

/** Page counts behind the database's size on disk. */
export interface DatabasePageStats {
  pageSize: number
  pageCount: number
  freePages: number
}

/**
 * Domain service for conversations and messages.
 * Owns the SQLite database lifecycle, schema, and all CRUD operations.
 * No Electron imports — testable with plain Node.
 */
export interface ConversationServiceOptions {
  /** Context profile stamped on new chats that don't name one (the active profile). */
  getDefaultProfileId?: () => string | null
}

export class ConversationService {
  private db: Database.Database
  private statements: Map<string, Database.Statement> = new Map()
  private getDefaultProfileId: () => string | null
  private messageSearchIndexed = false

  constructor(dbPath: string, options: ConversationServiceOptions = {}) {
    this.getDefaultProfileId = options.getDefaultProfileId ?? (() => null)
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
        model TEXT NOT NULL DEFAULT '${DEFAULT_MODEL}',
        provider TEXT NOT NULL DEFAULT '${DEFAULT_PROVIDER}',
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

      -- Image bytes, stored once per distinct image (keyed by SHA-256), so
      -- forks and re-sent images share one copy instead of inline base64.
      CREATE TABLE IF NOT EXISTS attachment_blobs (
        id TEXT PRIMARY KEY,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Which messages use which images; an image no message uses is deleted.
      CREATE TABLE IF NOT EXISTS message_blobs (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        blob_id TEXT NOT NULL REFERENCES attachment_blobs(id),
        PRIMARY KEY (message_id, blob_id)
      );
    `)

    // Migration path for existing databases created before pinning support.
    const conversationColumns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    if (!conversationColumns.some((column) => column.name === 'is_pinned')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0')
    }

    this.migrateConversationProviderConstraintIfNeeded()

    this.addColumnsMissingAfterProviderMigration()

    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
       CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
       CREATE INDEX IF NOT EXISTS idx_conversations_pinned_updated ON conversations(is_pinned DESC, updated_at DESC);
       CREATE INDEX IF NOT EXISTS idx_message_blobs_blob ON message_blobs(blob_id);`
    )

    this.messageSearchIndexed = this.ensureMessageSearchIndex()

    this.moveInlineImagesToAttachmentStore()

    this.addMessageTree()
  }

  /**
   * Images used to be saved inside the attachments JSON as base64 data URLs.
   * Moves them, byte for byte, into attachment_blobs (base64 text is a third
   * larger than the bytes, and forks copied it), then compacts the database
   * once so the file actually shrinks. Unreadable entries are left as they were.
   */
  private moveInlineImagesToAttachmentStore(): void {
    const candidates = this.db
      .prepare(`SELECT id FROM messages WHERE attachments LIKE '%"dataUrl"%'`)
      .all() as Array<{ id: string }>
    if (candidates.length === 0) return

    const getAttachments = this.db.prepare('SELECT attachments FROM messages WHERE id = ?')
    const setAttachments = this.db.prepare('UPDATE messages SET attachments = ? WHERE id = ?')
    let moved = 0

    const moveOne = this.db.transaction((messageId: string) => {
      const row = getAttachments.get(messageId) as { attachments: string | null } | undefined
      const list = parseAttachmentList(row?.attachments)
      const blobIds: string[] = []

      const next = list.map((item) => {
        if (!isRecord(item) || item.kind !== 'image' || typeof item.dataUrl !== 'string') return item
        const data = decodeDataUrl(item.dataUrl)
        if (!data || typeof item.mimeType !== 'string') return item
        const blobId = this.putBlob(data, item.mimeType)
        blobIds.push(blobId)
        return { kind: 'image', name: item.name, mimeType: item.mimeType, blobId, size: data.length }
      })
      if (blobIds.length === 0) return

      setAttachments.run(JSON.stringify(next), messageId)
      this.linkBlobs(messageId, blobIds)
      moved += 1
    })

    // One message per transaction, so a large history is never all in memory at once.
    for (const { id } of candidates) moveOne(id)

    if (moved > 0) {
      try {
        this.compact()
      } catch (err) {
        console.warn('[ConversationService] Could not compact the database after moving images:', err)
      }
    }
  }

  /**
   * Full-text index over message content, kept in sync by triggers. The
   * trigram tokenizer matches any substring of 3+ characters, case-insensitively,
   * so search behaves like the old LIKE '%query%' scan without reading every row.
   * Returns false (search falls back to LIKE) if this SQLite build lacks FTS5 trigram.
   */
  private ensureMessageSearchIndex(): boolean {
    const existing = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
      .get()

    try {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            content='messages',
            content_rowid='rowid',
            tokenize='trigram'
          );

          CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
          END;

          CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
          END;

          CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
            INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
          END;
        `)

        // First run on a database with existing history: index what is already there.
        if (!existing) {
          this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
        }
      })()
      return true
    } catch (err) {
      console.warn('[ConversationService] Message search index unavailable, using LIKE search:', err)
      return false
    }
  }

  /**
   * Columns added after the provider migration, which rebuilds the table
   * without them on very old databases. Both are nullable.
   */
  private addColumnsMissingAfterProviderMigration(): void {
    const columns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'last_request')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN last_request TEXT')
    }
    // Context profile the chat's system prompt is built from (null = active profile).
    if (!columns.some((column) => column.name === 'profile_id')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN profile_id TEXT')
    }
  }

  /**
   * Branching: each message points at the one before it (parent_id), and each
   * chat remembers the last message of the branch on screen (active_leaf_id).
   * Chats from before this are a single branch, so each message's parent is
   * simply the message saved before it. Additive, in one transaction.
   */
  private addMessageTree(): void {
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    const conversationColumns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    const needsParents = !messageColumns.some((column) => column.name === 'parent_id')
    const needsLeaves = !conversationColumns.some((column) => column.name === 'active_leaf_id')

    this.db.transaction(() => {
      if (needsParents) {
        this.db.exec('ALTER TABLE messages ADD COLUMN parent_id TEXT')
        this.db.exec(`
          UPDATE messages SET parent_id = (
            SELECT p.id FROM messages p
             WHERE p.conversation_id = messages.conversation_id AND p.rowid < messages.rowid
             ORDER BY p.rowid DESC LIMIT 1
          )
        `)
      }
      if (needsLeaves) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN active_leaf_id TEXT')
        this.db.exec(`
          UPDATE conversations SET active_leaf_id = (
            SELECT m.id FROM messages m
             WHERE m.conversation_id = conversations.id
             ORDER BY m.rowid DESC LIMIT 1
          )
        `)
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)')
    })()
  }

  /**
   * Databases from before 1.6.0 restrict `provider` with a CHECK constraint,
   * so every new provider needed a table rebuild. Rebuild once without it;
   * providers are validated in app code (src/lib/providers.ts) instead.
   */
  private migrateConversationProviderConstraintIfNeeded(): void {
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
      .get() as { sql?: string } | undefined

    if (!schema || typeof schema.sql !== 'string') return
    if (!/check\s*\(\s*provider\s+in\b/i.test(schema.sql)) return

    const columns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    // last_request is added after this migration on very old databases, but
    // 1.5.x databases already have it alongside the CHECK constraint.
    const lastRequest = columns.some((column) => column.name === 'last_request') ? ', last_request' : ''

    this.db.exec('PRAGMA foreign_keys = OFF')
    try {
      const migrate = this.db.transaction(() => {
        this.db.exec(`
          DROP TABLE IF EXISTS conversations_new;

          CREATE TABLE conversations_new (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New Chat',
            model TEXT NOT NULL DEFAULT '${DEFAULT_MODEL}',
            provider TEXT NOT NULL DEFAULT '${DEFAULT_PROVIDER}',
            is_pinned INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            workspace_path TEXT${lastRequest ? ', last_request TEXT' : ''}
          );

          INSERT INTO conversations_new (id, title, model, provider, is_pinned, created_at, updated_at, workspace_path${lastRequest})
          SELECT
            id,
            title,
            model,
            provider,
            COALESCE(is_pinned, 0),
            created_at,
            updated_at,
            workspace_path${lastRequest}
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
      workspacePath: row.workspace_path as string | null,
      profileId: typeof row.profile_id === 'string' && row.profile_id.length > 0 ? row.profile_id : null,
      lastRequest: parseRequestInfo(row.last_request)
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
      parentId: typeof row.parent_id === 'string' ? row.parent_id : null,
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

    // Trigrams need at least 3 characters; shorter queries scan with LIKE.
    if (this.messageSearchIndexed && [...trimmed].length >= 3) {
      // A quoted FTS5 phrase is matched literally; quotes inside are doubled.
      const phrase = `"${trimmed.replace(/"/g, '""')}"`
      const rows = this.stmt(
        'searchConversationsIndexed',
        `SELECT c.*
           FROM conversations c
          WHERE c.title LIKE ? ESCAPE '\\'
             OR c.id IN (
               SELECT m.conversation_id
                 FROM messages_fts
                 JOIN messages m ON m.rowid = messages_fts.rowid
                WHERE messages_fts MATCH ?
             )
          ORDER BY c.is_pinned DESC, c.updated_at DESC`
      ).all(pattern, phrase) as Record<string, unknown>[]

      return rows.map(r => this.toConversation(r))
    }

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
    assertValidProvider(data.provider)
    assertValidProfileId(data.profileId)
    const id = randomUUID()
    const now = Date.now()
    const profileId = data.profileId !== undefined ? data.profileId : this.getDefaultProfileId()

    this.stmt(
      'createConversation',
      `INSERT INTO conversations (id, title, model, provider, is_pinned, created_at, updated_at, workspace_path, profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.title || 'New Chat',
      data.model || DEFAULT_MODEL,
      data.provider || DEFAULT_PROVIDER,
      data.isPinned ? 1 : 0,
      now,
      now,
      data.workspacePath || null,
      profileId || null
    )

    return this.toConversation(
      this.stmt('getConversation', 'SELECT * FROM conversations WHERE id = ?')
        .get(id) as Record<string, unknown>
    )
  }

  updateConversation(id: string, data: Partial<Conversation>): void {
    assertValidProvider(data.provider)
    assertValidProfileId(data.profileId)
    const now = Date.now()
    const shouldUpdateProfileId = data.profileId !== undefined
    const shouldUpdateWorkspacePath = data.workspacePath !== undefined
    const shouldUpdatePinned = data.isPinned !== undefined
    const shouldUpdateLastRequest = data.lastRequest !== undefined
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
        END,
        last_request = CASE
          WHEN ? = 1 THEN ?
          ELSE last_request
        END,
        profile_id = CASE
          WHEN ? = 1 THEN ?
          ELSE profile_id
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
      shouldUpdateLastRequest ? 1 : 0,
      data.lastRequest ? JSON.stringify(data.lastRequest) : null,
      shouldUpdateProfileId ? 1 : 0,
      data.profileId || null,
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

      this.pruneUnusedBlobs()
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

    // A fork is the branch leading to this message, without the other versions.
    const sourceMessages = this.pathRows(conversationId, messageId) as Array<{
      id: string
      role: Message['role']
      content: string
      attachments: string | null
      thinking: string | null
      tool_calls: string | null
      timestamp: string
      created_at: number
    }>

    if (sourceMessages.length === 0) {
      throw new Error(`Message not found in conversation: ${messageId}`)
    }

    const forkConversationId = randomUUID()
    const now = Date.now()
    const forkTitle = this.buildForkTitle(sourceConversation.title as string)

    const forkInTransaction = this.db.transaction(() => {
      this.stmt(
        'createForkConversation',
        `INSERT INTO conversations (id, title, model, provider, is_pinned, created_at, updated_at, workspace_path, last_request, profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        forkConversationId,
        forkTitle,
        sourceConversation.model as string,
        sourceConversation.provider as Conversation['provider'],
        0,
        now,
        now,
        sourceConversation.workspace_path as string | null,
        (sourceConversation.last_request as string | null) ?? null,
        (sourceConversation.profile_id as string | null) ?? null
      )

      const insertForkMessage = this.stmt(
        'insertForkMessage',
        `INSERT INTO messages (id, conversation_id, parent_id, role, content, attachments, thinking, tool_calls, timestamp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )

      // The fork's messages share the source's stored images rather than copying them.
      const shareForkMessageBlobs = this.stmt(
        'shareForkMessageBlobs',
        `INSERT OR IGNORE INTO message_blobs (message_id, blob_id)
         SELECT ?, blob_id FROM message_blobs WHERE message_id = ?`
      )

      let forkParentId: string | null = null
      for (const message of sourceMessages) {
        const forkMessageId = randomUUID()
        insertForkMessage.run(
          forkMessageId,
          forkConversationId,
          forkParentId,
          message.role,
          message.content,
          message.attachments,
          message.thinking,
          message.tool_calls,
          message.timestamp,
          message.created_at
        )
        shareForkMessageBlobs.run(forkMessageId, message.id)
        forkParentId = forkMessageId
      }
      this.setActiveLeaf(forkConversationId, forkParentId)
    })

    forkInTransaction()

    return this.toConversation(
      this.stmt('getConversation', 'SELECT * FROM conversations WHERE id = ?')
        .get(forkConversationId) as Record<string, unknown>
    )
  }

  // ─── Message CRUD ─────────────────────────────────────────────────────────

  /** The branch on screen, first message first, with each message's alternatives. */
  listMessages(conversationId: string): Message[] {
    const leafId = this.activeLeafId(conversationId)
    if (!leafId) return []

    const path = this.pathRows(conversationId, leafId).map((row) => this.toMessage(row))
    return this.withSiblings(path, this.childrenByParent(conversationId))
  }

  /** Saves a message and makes it the end of the branch on screen. */
  createMessage(data: CreateMessageInput): Message {
    const id = randomUUID()
    const now = Date.now()
    const timestamp = new Date().toISOString()

    const createInTransaction = this.db.transaction(() => {
      const parentId = data.parentId === undefined
        ? this.activeLeafId(data.conversationId)
        : data.parentId
      if (parentId !== null && !this.isMessageInConversation(parentId, data.conversationId)) {
        throw new Error(`Message not found in conversation: ${parentId}`)
      }

      const attachments = this.prepareAttachments(data.attachments)

      this.stmt(
        'createMessage',
        `INSERT INTO messages (id, conversation_id, parent_id, role, content, attachments, thinking, tool_calls, timestamp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        data.conversationId,
        parentId,
        data.role,
        data.content,
        attachments.json,
        data.thinking ?? null,
        data.toolCalls || null,
        timestamp,
        now
      )
      this.linkBlobs(id, attachments.blobIds)
      this.setActiveLeaf(data.conversationId, id)

      // Bump parent conversation's updatedAt
      this.touchConversation(data.conversationId, now)
    })

    createInTransaction()

    const message = this.toMessage(
      this.stmt(
        'getMessage',
        'SELECT * FROM messages WHERE id = ?'
      ).get(id) as Record<string, unknown>
    )
    return this.withSiblings([message], this.childrenByParent(data.conversationId))[0]
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

  // ─── Branches ─────────────────────────────────────────────────────────────

  /**
   * Shows the branch through a message: by default down to its newest reply
   * chain, or with `exact`, ending at the message itself (a retry then adds
   * its new reply beside the old ones). Returns the branch now on screen.
   */
  selectBranch(conversationId: string, messageId: string, options: SelectBranchOptions = {}): Message[] {
    if (!this.isMessageInConversation(messageId, conversationId)) {
      throw new Error(`Message not found in conversation: ${messageId}`)
    }
    this.setActiveLeaf(conversationId, options.exact ? messageId : this.newestInSubtree(messageId))
    return this.listMessages(conversationId)
  }

  /**
   * Deletes a message and everything after it, on every branch below it. If
   * the branch on screen was among them, the chat moves to the newest
   * remaining branch under the same parent. Returns the branch now on screen.
   */
  deleteMessageBranch(conversationId: string, messageId: string): Message[] {
    const now = Date.now()

    const deleteInTransaction = this.db.transaction(() => {
      const row = this.stmt(
        'getMessageParent',
        'SELECT parent_id FROM messages WHERE id = ? AND conversation_id = ?'
      ).get(messageId, conversationId) as { parent_id: string | null } | undefined
      if (!row) return

      const leafId = this.activeLeafId(conversationId)
      const removedIds = (this.stmt(
        'listSubtree',
        `${SUBTREE_CTE} SELECT id FROM subtree`
      ).all(messageId) as Array<{ id: string }>).map((entry) => entry.id)

      this.stmt(
        'deleteSubtree',
        `${SUBTREE_CTE} DELETE FROM messages WHERE id IN (SELECT id FROM subtree)`
      ).run(messageId)

      if (!leafId || removedIds.includes(leafId)) {
        // No parent left means the chat's newest message takes over (see activeLeafId).
        this.setActiveLeaf(conversationId, row.parent_id ? this.newestInSubtree(row.parent_id) : null)
      }

      this.touchConversation(conversationId, now)
      this.pruneUnusedBlobs()
    })

    deleteInTransaction()
    return this.listMessages(conversationId)
  }

  /** Rows from the chat's first message down to this one, first message first. */
  private pathRows(conversationId: string, leafId: string): Record<string, unknown>[] {
    return this.stmt(
      'pathRows',
      `WITH RECURSIVE path(id, depth) AS (
         SELECT id, 0 FROM messages WHERE id = ? AND conversation_id = ?
         UNION ALL
         SELECT m.parent_id, path.depth + 1
           FROM messages m
           JOIN path ON m.id = path.id
          WHERE m.parent_id IS NOT NULL AND path.depth < ${MAX_BRANCH_DEPTH}
       )
       SELECT m.* FROM path
         JOIN messages m ON m.id = path.id
        WHERE m.conversation_id = ?
        ORDER BY path.depth DESC`
    ).all(leafId, conversationId, conversationId) as Record<string, unknown>[]
  }

  /** The newest message at or below this one: the end of its most recent branch. */
  private newestInSubtree(messageId: string): string {
    const row = this.stmt(
      'newestInSubtree',
      `${SUBTREE_CTE}
       SELECT m.id FROM subtree
         JOIN messages m ON m.id = subtree.id
        ORDER BY m.rowid DESC
        LIMIT 1`
    ).get(messageId) as { id: string } | undefined
    return row?.id ?? messageId
  }

  /** The last message of the branch on screen; a missing or stale pointer falls back to the newest message. */
  private activeLeafId(conversationId: string): string | null {
    const active = this.stmt(
      'getActiveLeaf',
      `SELECT m.id FROM conversations c
         JOIN messages m ON m.id = c.active_leaf_id AND m.conversation_id = c.id
        WHERE c.id = ?`
    ).get(conversationId) as { id: string } | undefined
    if (active) return active.id

    const newest = this.stmt(
      'getNewestMessage',
      'SELECT id FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1'
    ).get(conversationId) as { id: string } | undefined
    return newest?.id ?? null
  }

  private setActiveLeaf(conversationId: string, leafId: string | null): void {
    this.stmt(
      'setActiveLeaf',
      'UPDATE conversations SET active_leaf_id = ? WHERE id = ?'
    ).run(leafId, conversationId)
  }

  private isMessageInConversation(messageId: string, conversationId: string): boolean {
    return this.stmt(
      'isMessageInConversation',
      'SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?'
    ).get(messageId, conversationId) !== undefined
  }

  /** Each message's replies in this chat, oldest first, keyed by parent id ('' for first messages). */
  private childrenByParent(conversationId: string): Map<string, string[]> {
    const rows = this.stmt(
      'listMessageParents',
      'SELECT id, parent_id FROM messages WHERE conversation_id = ? ORDER BY rowid ASC'
    ).all(conversationId) as Array<{ id: string; parent_id: string | null }>

    const children = new Map<string, string[]>()
    for (const row of rows) {
      const key = row.parent_id ?? ''
      const list = children.get(key)
      if (list) list.push(row.id)
      else children.set(key, [row.id])
    }
    return children
  }

  private withSiblings(messages: Message[], children: Map<string, string[]>): Message[] {
    return messages.map((message) => {
      const siblingIds = children.get(message.parentId ?? '') ?? []
      return siblingIds.length > 1 ? { ...message, siblingIds } : message
    })
  }

  // ─── Attachment Store ─────────────────────────────────────────────────────

  /**
   * Attachments as saved: images go to the attachment store and are kept as a
   * reference. Images that are already stored (a resent message) are reused.
   */
  private prepareAttachments(attachments: Attachment[] | undefined): PreparedAttachments {
    if (!attachments || attachments.length === 0) return { json: null, blobIds: [] }

    const blobIds: string[] = []
    const stored = attachments.map((attachment): Attachment => {
      if (attachment.kind !== 'image') return attachment

      const image: ImageAttachment = { kind: 'image', name: attachment.name, mimeType: attachment.mimeType }
      if (attachment.removed) {
        return { ...image, removed: true, ...(attachment.size !== undefined ? { size: attachment.size } : {}) }
      }
      if (attachment.dataUrl) {
        const data = decodeDataUrl(attachment.dataUrl)
        if (!data) throw new Error(`Image "${attachment.name}" could not be read`)
        const blobId = this.putBlob(data, attachment.mimeType)
        blobIds.push(blobId)
        return { ...image, blobId, size: data.length }
      }

      const size = attachment.blobId ? this.getBlobSize(attachment.blobId) : null
      if (!attachment.blobId || size === null) throw new Error(`Image "${attachment.name}" is no longer stored`)
      blobIds.push(attachment.blobId)
      return { ...image, blobId: attachment.blobId, size }
    })

    return { json: JSON.stringify(stored), blobIds }
  }

  /** Stores image bytes once, keyed by their hash, and returns that id. */
  private putBlob(data: Buffer, mimeType: string): string {
    const blobId = hashBytes(data)
    this.stmt(
      'putBlob',
      `INSERT OR IGNORE INTO attachment_blobs (id, mime_type, size, data, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(blobId, mimeType, data.length, data, Date.now())
    return blobId
  }

  private linkBlobs(messageId: string, blobIds: string[]): void {
    const link = this.stmt(
      'linkBlob',
      'INSERT OR IGNORE INTO message_blobs (message_id, blob_id) VALUES (?, ?)'
    )
    for (const blobId of blobIds) link.run(messageId, blobId)
  }

  private getBlobSize(blobId: string): number | null {
    const row = this.stmt(
      'getBlobSize',
      'SELECT size FROM attachment_blobs WHERE id = ?'
    ).get(blobId) as { size: number } | undefined
    return row ? row.size : null
  }

  /** Deletes stored images that no message uses any more. */
  private pruneUnusedBlobs(): void {
    this.stmt(
      'pruneUnusedBlobs',
      `DELETE FROM attachment_blobs
       WHERE NOT EXISTS (SELECT 1 FROM message_blobs mb WHERE mb.blob_id = attachment_blobs.id)`
    ).run()
  }

  getAttachmentBlob(blobId: string): AttachmentBlob | null {
    if (!BLOB_ID_PATTERN.test(blobId)) return null
    const row = this.stmt(
      'getAttachmentBlob',
      'SELECT mime_type, data FROM attachment_blobs WHERE id = ?'
    ).get(blobId) as { mime_type: string; data: Buffer } | undefined
    return row ? { mimeType: row.mime_type, data: row.data } : null
  }

  /**
   * Everything an export file needs: every message on every branch, oldest
   * first (a parent always comes before its replies), with each stored image
   * inlined as a data URL, and the message the chat is showing.
   */
  exportMessages(conversationId: string): { messages: Message[]; activeMessageId: string | null } {
    const rows = this.stmt(
      'listAllMessages',
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC'
    ).all(conversationId) as Record<string, unknown>[]

    const messages = rows.map((row) => this.toMessage(row)).map((message) => {
      if (!message.attachments?.some((attachment) => attachment.kind === 'image' && attachment.blobId)) {
        return message
      }
      return {
        ...message,
        attachments: message.attachments.map((attachment): Attachment => {
          if (attachment.kind !== 'image' || !attachment.blobId) return attachment
          const blob = this.getAttachmentBlob(attachment.blobId)
          const image: ImageAttachment = { kind: 'image', name: attachment.name, mimeType: attachment.mimeType }
          return blob
            ? { ...image, dataUrl: `data:${blob.mimeType};base64,${blob.data.toString('base64')}` }
            : { ...image, removed: true }
        })
      }
    })

    return { messages, activeMessageId: this.activeLeafId(conversationId) }
  }

  // ─── Storage ──────────────────────────────────────────────────────────────

  getPageStats(): DatabasePageStats {
    return {
      pageSize: this.db.pragma('page_size', { simple: true }) as number,
      pageCount: this.db.pragma('page_count', { simple: true }) as number,
      freePages: this.db.pragma('freelist_count', { simple: true }) as number
    }
  }

  getStoredImageBytes(): number {
    const row = this.stmt(
      'getStoredImageBytes',
      'SELECT COALESCE(SUM(size), 0) AS bytes FROM attachment_blobs'
    ).get() as { bytes: number }
    return row.bytes
  }

  /** Every chat with how much space it takes, largest first. */
  listChatStorage(): ChatStorageInfo[] {
    const rows = this.stmt(
      'listChatStorage',
      `WITH text_sizes AS (
         SELECT conversation_id,
                COUNT(*) AS message_count,
                SUM(length(CAST(content AS BLOB))
                  + COALESCE(length(CAST(thinking AS BLOB)), 0)
                  + COALESCE(length(CAST(tool_calls AS BLOB)), 0)
                  + COALESCE(length(CAST(attachments AS BLOB)), 0)) AS text_bytes
           FROM messages
          GROUP BY conversation_id
       ),
       chat_images AS (
         SELECT DISTINCT m.conversation_id, mb.blob_id
           FROM message_blobs mb
           JOIN messages m ON m.id = mb.message_id
       ),
       image_sizes AS (
         SELECT ci.conversation_id, COUNT(*) AS image_count, SUM(b.size) AS image_bytes
           FROM chat_images ci
           JOIN attachment_blobs b ON b.id = ci.blob_id
          GROUP BY ci.conversation_id
       )
       SELECT c.id, c.title, c.is_pinned, c.updated_at,
              COALESCE(t.message_count, 0) AS message_count,
              COALESCE(t.text_bytes, 0) AS text_bytes,
              COALESCE(i.image_count, 0) AS image_count,
              COALESCE(i.image_bytes, 0) AS image_bytes
         FROM conversations c
         LEFT JOIN text_sizes t ON t.conversation_id = c.id
         LEFT JOIN image_sizes i ON i.conversation_id = c.id
        ORDER BY COALESCE(t.text_bytes, 0) + COALESCE(i.image_bytes, 0) DESC, c.updated_at DESC`
    ).all() as Array<{
      id: string
      title: string
      is_pinned: number
      updated_at: number
      message_count: number
      text_bytes: number
      image_count: number
      image_bytes: number
    }>

    return rows.map((row) => ({
      conversationId: row.id,
      title: row.title,
      isPinned: Boolean(row.is_pinned),
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      imageCount: row.image_count,
      textBytes: row.text_bytes,
      imageBytes: row.image_bytes,
      totalBytes: row.text_bytes + row.image_bytes
    }))
  }

  /** Every stored image with the chats that use it, largest first. */
  listStoredImages(): StoredImageInfo[] {
    const rows = this.stmt(
      'listStoredImages',
      `SELECT b.id AS blob_id, b.mime_type, b.size, m.created_at, m.attachments,
              c.id AS conversation_id, c.title, c.updated_at
         FROM attachment_blobs b
         JOIN message_blobs mb ON mb.blob_id = b.id
         JOIN messages m ON m.id = mb.message_id
         JOIN conversations c ON c.id = m.conversation_id
        ORDER BY b.size DESC, b.id, m.created_at ASC`
    ).all() as Array<{
      blob_id: string
      mime_type: string
      size: number
      created_at: number
      attachments: string | null
      conversation_id: string
      title: string
      updated_at: number
    }>

    const images = new Map<string, StoredImageInfo>()
    for (const row of rows) {
      let image = images.get(row.blob_id)
      if (!image) {
        const entry = parseAttachmentList(row.attachments)
          .find((item) => isRecord(item) && item.blobId === row.blob_id)
        const record = isRecord(entry) ? entry : {}
        image = {
          blobId: row.blob_id,
          name: typeof record.name === 'string' ? record.name : 'image',
          mimeType: isImageMimeType(record.mimeType) ? record.mimeType : row.mime_type as ImageAttachmentMimeType,
          bytes: row.size,
          firstSentAt: row.created_at,
          lastChatActivityAt: row.updated_at,
          chats: []
        }
        images.set(row.blob_id, image)
      }
      image.firstSentAt = Math.min(image.firstSentAt, row.created_at)
      image.lastChatActivityAt = Math.max(image.lastChatActivityAt, row.updated_at)
      if (!image.chats.some((chat) => chat.conversationId === row.conversation_id)) {
        image.chats.push({ conversationId: row.conversation_id, title: row.title })
      }
    }

    return [...images.values()]
  }

  /**
   * Removes an image from every message that uses it and deletes its bytes.
   * The messages keep the image's name, marked as removed, and their text.
   */
  removeStoredImage(blobId: string): RemoveImageResult {
    if (!BLOB_ID_PATTERN.test(blobId)) throw new Error('Invalid image id')

    const remove = this.db.transaction((): RemoveImageResult => {
      const size = this.getBlobSize(blobId)
      if (size === null) return { freedBytes: 0, conversationIds: [] }

      const rows = this.stmt(
        'listMessagesUsingBlob',
        `SELECT m.id, m.conversation_id, m.attachments
           FROM message_blobs mb
           JOIN messages m ON m.id = mb.message_id
          WHERE mb.blob_id = ?`
      ).all(blobId) as Array<{ id: string; conversation_id: string; attachments: string | null }>

      const setAttachments = this.stmt('setMessageAttachments', 'UPDATE messages SET attachments = ? WHERE id = ?')
      for (const row of rows) {
        const next = parseAttachmentList(row.attachments).map((item) =>
          isRecord(item) && item.kind === 'image' && item.blobId === blobId
            ? { kind: 'image', name: item.name, mimeType: item.mimeType, size, removed: true }
            : item
        )
        setAttachments.run(JSON.stringify(next), row.id)
      }

      this.stmt('unlinkBlob', 'DELETE FROM message_blobs WHERE blob_id = ?').run(blobId)
      this.stmt('deleteBlob', 'DELETE FROM attachment_blobs WHERE id = ?').run(blobId)

      return {
        freedBytes: size,
        conversationIds: [...new Set(rows.map((row) => row.conversation_id))]
      }
    })

    return remove()
  }

  /**
   * Rewrites the database file without its free space. Deleting rows only
   * marks their pages free, so this is what makes the file smaller, and what
   * clears deleted chats and images out of it for good.
   */
  compact(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
    this.db.pragma('wal_checkpoint(TRUNCATE)')
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.statements.clear()
    this.db.close()
  }
}

/** Providers are checked here rather than by a DB CHECK constraint, so adding one needs no migration. */
function assertValidProvider(provider: unknown): void {
  if (provider !== undefined && !isProviderName(provider)) {
    throw new Error(`Unknown provider: ${String(provider)}`)
  }
}

function assertValidProfileId(profileId: unknown): void {
  if (profileId !== undefined && profileId !== null && typeof profileId !== 'string') {
    throw new Error('profileId must be a string or null')
  }
}
