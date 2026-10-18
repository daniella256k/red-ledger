import { describe, expect, it, vi } from 'vitest'
import { ConversationService } from '../ConversationService'

type MigrationHarness = {
  db: {
    exec: (sql: string) => void
    prepare: (sql: string) => { get: () => { sql: string } | undefined }
    transaction: (fn: () => void) => () => void
  }
  migrateConversationProviderConstraintIfNeeded: () => void
}

type DatabaseHarness = {
  stmt: (key: string, sql: string) => {
    all?: (...args: unknown[]) => Record<string, unknown>[]
    get?: (...args: unknown[]) => unknown
    run?: (...args: unknown[]) => { changes?: number } | void
  }
}

type MutationHarness = DatabaseHarness & {
  db: {
    transaction: (fn: () => void) => () => void
  }
}

const listMessages = ConversationService.prototype.listMessages as (
  this: DatabaseHarness,
  conversationId: string
) => ReturnType<ConversationService['listMessages']>

const updateMessage = ConversationService.prototype.updateMessage as (
  this: MutationHarness,
  id: string,
  data: Parameters<ConversationService['updateMessage']>[1]
) => void

const deleteMessagesFrom = ConversationService.prototype.deleteMessagesFrom as (
  this: MutationHarness,
  conversationId: string,
  messageId: string
) => void

describe('ConversationService schema migrations', () => {
  it('migrates legacy provider constraints when lmstudio is missing', () => {
    const exec = vi.fn()
    const transaction = vi.fn((fn: () => void) => fn)
    const prepare = vi.fn((sql: string) => {
      if (sql.includes('sqlite_master')) {
        return {
          get: () => ({
            sql: `CREATE TABLE conversations (
              id TEXT PRIMARY KEY,
              provider TEXT NOT NULL DEFAULT 'openai'
                CHECK(provider IN ('openai', 'openrouter', 'ollama'))
            )`
          })
        }
      }

      return {
        get: () => undefined
      }
    })

    const service = Object.create(ConversationService.prototype) as unknown as MigrationHarness
    service.db = { exec, prepare, transaction }
    service.migrateConversationProviderConstraintIfNeeded()

    expect(exec).toHaveBeenCalledWith('PRAGMA foreign_keys = OFF')
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE conversations_new'))
    expect(exec).toHaveBeenCalledWith('PRAGMA foreign_keys = ON')
  })

  it('skips migration when lmstudio is already present', () => {
    const exec = vi.fn()
    const transaction = vi.fn((fn: () => void) => fn)
    const prepare = vi.fn(() => ({
      get: () => ({
        sql: `CREATE TABLE conversations (
          provider TEXT NOT NULL DEFAULT 'openai'
            CHECK(provider IN ('openai', 'openrouter', 'ollama', 'lmstudio'))
        )`
      })
    }))

    const service = Object.create(ConversationService.prototype) as unknown as MigrationHarness
    service.db = { exec, prepare, transaction }
    service.migrateConversationProviderConstraintIfNeeded()

    expect(exec).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })
})

describe('ConversationService message ordering and recency', () => {
  it('lists messages in insertion order even when created_at values are out of order', () => {
    const service = Object.create(ConversationService.prototype) as DatabaseHarness
    const rows = [
      {
        id: 'first-message',
        conversation_id: 'conv-1',
        role: 'user',
        content: 'first inserted',
        attachments: null,
        thinking: null,
        tool_calls: null,
        timestamp: '2026-03-03T12:00:00.000Z',
        created_at: 2_000
      },
      {
        id: 'second-message',
        conversation_id: 'conv-1',
        role: 'assistant',
        content: 'second inserted',
        attachments: null,
        thinking: null,
        tool_calls: null,
        timestamp: '2026-03-03T12:00:01.000Z',
        created_at: 1_000
      }
    ]
    const all = vi.fn(() => rows)
    const stmt = vi.fn((key: string, sql: string) => {
      expect(key).toBe('listMessages')
      expect(sql).toContain('ORDER BY rowid ASC')
      return { all }
    })

    service.stmt = stmt

    const messages = listMessages.call(service, 'conv-1')

    expect(messages.map((message) => message.id)).toEqual([
      'first-message',
      'second-message'
    ])
    expect(all).toHaveBeenCalledWith('conv-1')
  })

  it('bumps conversation updated_at when a message is edited', () => {
    const updateRun = vi.fn(() => ({ changes: 1 }))
    const touchRun = vi.fn()
    const transaction = vi.fn((fn: () => void) => fn)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(3_000)
    const service = Object.create(ConversationService.prototype) as MutationHarness

    service.db = { transaction }
    service.stmt = vi.fn((key: string, sql: string) => {
      if (key === 'updateMessage') {
        expect(sql).toContain('UPDATE messages SET')
        return { run: updateRun }
      }

      if (key === 'touchConversationForMessage') {
        expect(sql).toContain('SELECT conversation_id')
        return { run: touchRun }
      }

      throw new Error(`Unexpected statement key: ${key}`)
    })

    updateMessage.call(service, 'message-1', { content: 'after' })

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(updateRun).toHaveBeenCalledWith('after', null, null, 'message-1')
    expect(touchRun).toHaveBeenCalledWith(3_000, 'message-1')
    nowSpy.mockRestore()
  })

  it('bumps conversation updated_at when deleting messages from a cutoff', () => {
    const get = vi.fn(() => ({ rowid: 7 }))
    const deleteRun = vi.fn()
    const touchRun = vi.fn()
    const transaction = vi.fn((fn: () => void) => fn)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(4_000)
    const service = Object.create(ConversationService.prototype) as MutationHarness

    service.db = { transaction }
    service.stmt = vi.fn((key: string, sql: string) => {
      if (key === 'getConversationMessage') {
        expect(sql).toContain('SELECT rowid FROM messages')
        return { get }
      }

      if (key === 'deleteMessagesFrom') {
        expect(sql).toContain('DELETE FROM messages')
        return { run: deleteRun }
      }

      if (key === 'touchConversation') {
        expect(sql).toContain('UPDATE conversations SET updated_at = ? WHERE id = ?')
        return { run: touchRun }
      }

      throw new Error(`Unexpected statement key: ${key}`)
    })

    deleteMessagesFrom.call(service, 'conv-1', 'message-1')

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('message-1', 'conv-1')
    expect(deleteRun).toHaveBeenCalledWith('conv-1', 7)
    expect(touchRun).toHaveBeenCalledWith(4_000, 'conv-1')
    nowSpy.mockRestore()
  })
})

describe('ConversationService request metadata', () => {
  const requestInfo = {
    sentAt: '2026-01-01T00:00:00.000Z',
    provider: 'openrouter' as const,
    model: 'moonshotai/kimi-k2.5',
    temperature: null,
    maxTokens: 4096,
    reasoningEnabled: true,
    searchToolsEnabled: false,
    contextProfile: 'Default'
  }

  it('stores lastRequest as JSON without bumping updated_at', () => {
    const run = vi.fn()
    const service = Object.create(ConversationService.prototype) as DatabaseHarness
    service.stmt = vi.fn(() => ({ run }))

    const updateConversation = ConversationService.prototype.updateConversation as (
      this: DatabaseHarness,
      id: string,
      data: Parameters<ConversationService['updateConversation']>[1]
    ) => void
    updateConversation.call(service, 'c1', { lastRequest: requestInfo })

    const args = run.mock.calls[0]
    // [title, model, provider, pinFlag, pinned, bumpFlag, now, wsFlag, ws, lastFlag, last, id]
    expect(args[5]).toBe(0)
    expect(args[9]).toBe(1)
    expect(JSON.parse(args[10] as string)).toEqual(requestInfo)
    expect(args[11]).toBe('c1')
  })

  it('parses lastRequest from rows and tolerates bad JSON', () => {
    const toConversation = (ConversationService.prototype as unknown as {
      toConversation: (row: Record<string, unknown>) => { lastRequest?: unknown }
    }).toConversation

    const base = { id: 'c1', title: 't', model: 'm', provider: 'openai', is_pinned: 0, created_at: 1, updated_at: 1, workspace_path: null }
    expect(toConversation({ ...base, last_request: JSON.stringify(requestInfo) }).lastRequest).toEqual(requestInfo)
    expect(toConversation({ ...base, last_request: '{not json' }).lastRequest).toBeNull()
    expect(toConversation({ ...base, last_request: null }).lastRequest).toBeNull()
  })
})
