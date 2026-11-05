import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { ConversationService, DatabaseVersionError } from '../ConversationService'

const services: ConversationService[] = []
const dirs: string[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rl-migrations-'))
  dirs.push(dir)
  return join(dir, 'conversations.db')
}

function open(path: string): ConversationService {
  const service = new ConversationService(path)
  services.push(service)
  return service
}

function close(service: ConversationService): void {
  service.close()
  services.splice(services.indexOf(service), 1)
}

/** Runs something against the file directly, as another program (or an older version) would. */
function withRaw<T>(path: string, run: (db: Database.Database) => T): T {
  const db = new Database(path)
  try {
    return run(db)
  } finally {
    db.close()
  }
}

const userVersion = (path: string) => withRaw(path, (db) => db.pragma('user_version', { simple: true }) as number)

describe('database schema versions', () => {
  it('records the latest version on a new database', () => {
    const path = dbFile()
    const service = open(path)
    const latest = service.schemaVersion
    close(service)

    expect(latest).toBeGreaterThan(0)
    expect(userVersion(path)).toBe(latest)
  })

  it('runs no upgrade steps on a database that is already current', () => {
    const path = dbFile()
    const service = open(path)
    const chat = service.createConversation({})
    service.createMessage({ conversationId: chat.id, role: 'user', content: 'q' })
    close(service)

    // Old-style inline image data, which the image step would move if it ran again.
    const legacy = JSON.stringify([{ kind: 'image', name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAEC' }])
    withRaw(path, (db) => db.prepare('UPDATE messages SET attachments = ?').run(legacy))

    open(path)
    expect(withRaw(path, (db) => (db.prepare('SELECT attachments FROM messages').get() as { attachments: string }).attachments)).toBe(legacy)
  })

  it('upgrades a database from before versions were recorded, keeping its chats', () => {
    const path = dbFile()
    const service = open(path)
    const latest = service.schemaVersion
    const chat = service.createConversation({ title: 'Kept' })
    service.createMessage({ conversationId: chat.id, role: 'user', content: 'still here' })
    close(service)
    // Every step was applied by an older version, which recorded nothing.
    withRaw(path, (db) => db.pragma('user_version = 0'))

    const upgraded = open(path)
    expect(upgraded.getConversation(chat.id)?.title).toBe('Kept')
    expect(upgraded.listMessages(chat.id).map((m) => m.content)).toEqual(['still here'])
    expect(upgraded.searchConversations('still here').map((c) => c.id)).toEqual([chat.id])
    close(upgraded)
    expect(userVersion(path)).toBe(latest)
  })

  it('finishes an upgrade that stopped part way', () => {
    const path = dbFile()
    const service = open(path)
    const latest = service.schemaVersion
    close(service)
    withRaw(path, (db) => db.pragma('user_version = 3'))

    close(open(path))
    expect(userVersion(path)).toBe(latest)
  })

  it('adds the reply reasoning column to a 1.9 database, whose replies have none', () => {
    const path = dbFile()
    const service = open(path)
    const chat = service.createConversation({})
    service.createMessage({ conversationId: chat.id, role: 'user', content: 'q' })
    const reply = service.createMessage({ conversationId: chat.id, role: 'assistant', content: 'a', thinking: 'thought' })
    close(service)
    // As 1.9 left it: schema 8, no replay column.
    withRaw(path, (db) => {
      db.exec('ALTER TABLE messages DROP COLUMN replay')
      db.pragma('user_version = 8')
    })

    const upgraded = open(path)
    const columns = withRaw(path, (db) => (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name))
    expect(columns).toContain('replay')
    expect(upgraded.listMessages(chat.id).map((m) => m.content)).toEqual(['q', 'a'])
    expect(upgraded.getSavedReasoning([reply.id]).size).toBe(0)
    expect(userVersion(path)).toBe(9)
  })

  it('refuses a database from a newer version and leaves it as it was', () => {
    const path = dbFile()
    const service = open(path)
    const newer = service.schemaVersion + 1
    close(service)
    withRaw(path, (db) => db.pragma(`user_version = ${newer}`))

    expect(() => new ConversationService(path)).toThrow(DatabaseVersionError)
    expect(userVersion(path)).toBe(newer)
  })
})
