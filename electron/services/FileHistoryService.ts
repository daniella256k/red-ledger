import { createHash } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { dirname, relative, sep } from 'path'
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import type Database from 'better-sqlite3'
import { resolveWorkspacePath } from './pathJail'
import type { FileUndoResult } from '../../src/types'

/**
 * File history: what workspace files looked like before a reply changed them,
 * so the reply's file changes can be undone from the chat.
 *
 * For each reply and file, the state before the reply's first change is kept
 * (later changes in the same reply don't add more), along with a hash of the
 * file after its last change, to spot edits made since. File contents are
 * stored once per distinct content (keyed by SHA-256) and gzipped. History is
 * kept as long as the reply is: deleting the reply or its chat deletes it.
 * No Electron imports.
 */

/** Files larger than this are changed without keeping their previous version. */
export const MAX_HISTORY_FILE_BYTES = 25 * 1024 * 1024

type BeforeState = 'absent' | 'stored' | 'too_large'

/** Hooks WorkspaceService calls around every change a reply makes to a file. */
export interface FileChangeRecorder {
  /** Before a file is created, changed, moved or removed. */
  beforeChange(fullPath: string): void
  /** After the change; records what the file is now, to tell later edits apart. */
  afterChange(fullPath: string): void
}

export interface FileChangeSummary {
  path: string
  /** What undo does: put the old content back, delete a file the reply created, or nothing. */
  action: 'restore' | 'delete' | 'unavailable'
  /** The file is different from how the reply left it (edited since, or by a later reply). */
  changedSince: boolean
}

interface ChangeRow {
  workspace_root: string
  relative_path: string
  before_state: BeforeState
  before_version: string | null
  after_hash: string | null
}

function hashBytes(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** SHA-256 of a file, or null when there is none (or it's no longer a regular file). */
function hashFile(fullPath: string): string | null {
  const stat = lstatSync(fullPath, { throwIfNoEntry: false })
  if (!stat?.isFile()) return null
  return hashBytes(readFileSync(fullPath))
}

function toRelativeKey(workspaceRoot: string, fullPath: string): string {
  return relative(workspaceRoot, fullPath).split(sep).join('/')
}

export class FileHistoryStore {
  private db: Database.Database

  /** Expects the schema in place (ConversationService's migrations call createSchema). */
  constructor(db: Database.Database) {
    this.db = db
  }

  /** The file history tables. Safe to run again: everything is created only if missing. */
  static createSchema(db: Database.Database): void {
    db.exec(`
      -- File contents a reply replaced, once per distinct content, gzipped.
      CREATE TABLE IF NOT EXISTS file_versions (
        id TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Each file a reply changed: its state before the reply, and a hash of
      -- how the reply left it (null: the reply left no file there).
      CREATE TABLE IF NOT EXISTS file_changes (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        workspace_root TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        before_state TEXT NOT NULL CHECK(before_state IN ('absent', 'stored', 'too_large')),
        before_version TEXT REFERENCES file_versions(id),
        after_hash TEXT,
        changed_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, workspace_root, relative_path)
      );

      CREATE INDEX IF NOT EXISTS idx_file_changes_version ON file_changes(before_version);
    `)
  }

  /** Records the changes one reply makes in one workspace folder. */
  recorderFor(messageId: string, workspaceRoot: string): FileChangeRecorder {
    const exists = this.db.prepare(
      'SELECT 1 FROM file_changes WHERE message_id = ? AND workspace_root = ? AND relative_path = ?'
    )
    const insertVersion = this.db.prepare(
      'INSERT OR IGNORE INTO file_versions (id, size, data, created_at) VALUES (?, ?, ?, ?)'
    )
    const insertChange = this.db.prepare(
      `INSERT INTO file_changes (message_id, workspace_root, relative_path, before_state, before_version, after_hash, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const setAfter = this.db.prepare(
      'UPDATE file_changes SET after_hash = ?, changed_at = ? WHERE message_id = ? AND workspace_root = ? AND relative_path = ?'
    )

    const recordBefore = this.db.transaction((path: string, fullPath: string) => {
      if (exists.get(messageId, workspaceRoot, path)) return
      const now = Date.now()
      const stat = lstatSync(fullPath, { throwIfNoEntry: false })
      if (!stat?.isFile()) {
        insertChange.run(messageId, workspaceRoot, path, 'absent', null, null, now)
      } else if (stat.size > MAX_HISTORY_FILE_BYTES) {
        insertChange.run(messageId, workspaceRoot, path, 'too_large', null, null, now)
      } else {
        const data = readFileSync(fullPath)
        const id = hashBytes(data)
        insertVersion.run(id, data.length, gzipSync(data), now)
        insertChange.run(messageId, workspaceRoot, path, 'stored', id, id, now)
      }
    })

    return {
      beforeChange: (fullPath) => recordBefore(toRelativeKey(workspaceRoot, fullPath), fullPath),
      afterChange: (fullPath) => {
        setAfter.run(hashFile(fullPath), Date.now(), messageId, workspaceRoot, toRelativeKey(workspaceRoot, fullPath))
      }
    }
  }

  /** Replies in a chat with file changes that can be undone. */
  repliesWithChanges(conversationId: string): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT fc.message_id AS id FROM file_changes fc
         JOIN messages m ON m.id = fc.message_id
        WHERE m.conversation_id = ?`
    ).all(conversationId) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  /** What undoing a reply's file changes would do, file by file. */
  describeChanges(messageId: string): FileChangeSummary[] {
    return this.changeRows(messageId).map((row) => {
      const fullPath = this.safePath(row)
      return {
        path: row.relative_path,
        action: !fullPath || row.before_state === 'too_large'
          ? 'unavailable'
          : row.before_state === 'absent' ? 'delete' : 'restore',
        changedSince: fullPath !== null && hashFile(fullPath) !== row.after_hash
      }
    })
  }

  /**
   * Puts every file the reply changed back the way it was before the reply:
   * old content written back, files it created deleted. The reply's history
   * is then cleared, so an undo can't be applied twice.
   */
  undo(messageId: string): FileUndoResult {
    const result: FileUndoResult = { undone: [], skipped: [] }
    const getVersion = this.db.prepare('SELECT data FROM file_versions WHERE id = ?')

    for (const row of this.changeRows(messageId)) {
      const fullPath = this.safePath(row)
      if (!fullPath || row.before_state === 'too_large') {
        result.skipped.push(row.relative_path)
        continue
      }
      if (row.before_state === 'absent') {
        rmSync(fullPath, { force: true })
      } else {
        const version = getVersion.get(row.before_version) as { data: Buffer } | undefined
        if (!version) {
          result.skipped.push(row.relative_path)
          continue
        }
        mkdirSync(dirname(fullPath), { recursive: true })
        writeFileSync(fullPath, gunzipSync(version.data))
      }
      result.undone.push(row.relative_path)
    }

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM file_changes WHERE message_id = ?').run(messageId)
      this.pruneUnusedVersions()
    })()
    return result
  }

  /** Deletes stored file contents no reply's history uses any more. */
  pruneUnusedVersions(): void {
    this.db.prepare(
      `DELETE FROM file_versions
        WHERE NOT EXISTS (SELECT 1 FROM file_changes fc WHERE fc.before_version = file_versions.id)`
    ).run()
  }

  /** Bytes the stored file contents take up. */
  storedBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM file_versions').get() as { bytes: number }
    return row.bytes
  }

  private changeRows(messageId: string): ChangeRow[] {
    return this.db.prepare(
      `SELECT workspace_root, relative_path, before_state, before_version, after_hash
         FROM file_changes WHERE message_id = ? ORDER BY relative_path`
    ).all(messageId) as ChangeRow[]
  }

  /** The file's path, checked against the workspace jail again (links may have appeared since). */
  private safePath(row: ChangeRow): string | null {
    try {
      return resolveWorkspacePath(row.workspace_root, row.relative_path)
    } catch {
      return null
    }
  }
}
