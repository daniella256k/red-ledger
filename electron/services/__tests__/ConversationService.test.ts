import { describe, expect, it, vi } from 'vitest'
import { ConversationService } from '../ConversationService'

type MigrationHarness = {
  db: {
    exec: (sql: string) => void
    prepare: (sql: string) => {
      get: () => { sql: string } | undefined
      all: () => Array<{ name: string }>
    }
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

const updateMessage = ConversationService.prototype.updateMessage as (
  this: MutationHarness,
  id: string,
  data: Parameters<ConversationService['updateMessage']>[1]
) => void

describe('ConversationService schema migrations', () => {
  function migrationHarness(tableSql: string, columns: string[]) {
    const exec = vi.fn()
    const transaction = vi.fn((fn: () => void) => fn)
    const prepare = vi.fn((sql: string) => ({
      get: () => (sql.includes('sqlite_master') ? { sql: tableSql } : undefined),
      all: () => (sql.includes('table_info') ? columns.map((name) => ({ name })) : [])
    }))
    const service = Object.create(ConversationService.prototype) as unknown as MigrationHarness
    service.db = { exec, prepare, transaction }
    return { service, exec, transaction }
  }

  const BASE_COLUMNS = ['id', 'title', 'model', 'provider', 'is_pinned', 'created_at', 'updated_at', 'workspace_path']

  it('drops a legacy provider CHECK constraint', () => {
    const { service, exec, transaction } = migrationHarness(
      `CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'openai'
          CHECK(provider IN ('openai', 'openrouter', 'ollama'))
      )`,
      BASE_COLUMNS
    )

    service.migrateConversationProviderConstraintIfNeeded()

    expect(exec).toHaveBeenCalledWith('PRAGMA foreign_keys = OFF')
    expect(transaction).toHaveBeenCalledTimes(1)
    const rebuild = exec.mock.calls.map(([sql]) => sql as string).find((sql) => sql.includes('CREATE TABLE conversations_new'))
    expect(rebuild).toBeDefined()
    expect(rebuild).not.toMatch(/CHECK/i)
    expect(rebuild).not.toContain('last_request')
    expect(exec).toHaveBeenCalledWith('PRAGMA foreign_keys = ON')
  })

  it('keeps last_request when rebuilding a 1.5.x table', () => {
    const { service, exec } = migrationHarness(
      `CREATE TABLE conversations (
        provider TEXT NOT NULL DEFAULT 'openai'
          CHECK(provider IN ('openai', 'openrouter', 'ollama', 'lmstudio')),
        last_request TEXT
      )`,
      [...BASE_COLUMNS, 'last_request']
    )

    service.migrateConversationProviderConstraintIfNeeded()

    const rebuild = exec.mock.calls.map(([sql]) => sql as string).find((sql) => sql.includes('CREATE TABLE conversations_new'))
    expect(rebuild).toContain('last_request TEXT')
    expect(rebuild).toContain('workspace_path, last_request')
  })

  it('skips migration when there is no provider CHECK constraint', () => {
    const { service, exec, transaction } = migrationHarness(
      `CREATE TABLE conversations (
        provider TEXT NOT NULL DEFAULT 'openai',
        workspace_path TEXT
      )`,
      BASE_COLUMNS
    )

    service.migrateConversationProviderConstraintIfNeeded()

    expect(exec).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('rejects unknown providers in app code', () => {
    const service = Object.create(ConversationService.prototype) as ConversationService
    expect(() => service.createConversation({ provider: 'bogus' as never })).toThrow(/Unknown provider/)
    expect(() => service.updateConversation('id', { provider: 'bogus' as never })).toThrow(/Unknown provider/)
  })
})

describe('ConversationService message ordering and recency', () => {
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
})

describe('ConversationService request metadata', () => {
  const requestInfo = {
    sentAt: '2026-01-01T00:00:00.000Z',
    provider: 'openrouter' as const,
    model: 'moonshotai/kimi-k3',
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
    // [title, model, provider, pinFlag, pinned, bumpFlag, now, wsFlag, ws, lastFlag, last, profileFlag, profile, id]
    expect(args[5]).toBe(0)
    expect(args[9]).toBe(1)
    expect(JSON.parse(args[10] as string)).toEqual(requestInfo)
    expect(args[11]).toBe(0)
    expect(args[13]).toBe('c1')
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

describe('ConversationService context profile', () => {
  type ProfileHarness = DatabaseHarness & {
    db: MigrationHarness['db']
    getDefaultProfileId: () => string | null
    addColumnsMissingAfterProviderMigration: () => void
  }

  const BASE_ROW = {
    id: 'c1', title: 't', model: 'm', provider: 'openai', is_pinned: 0,
    created_at: 1, updated_at: 1, workspace_path: null, last_request: null
  }

  /** The branch a fork copies: one message. */
  const FORK_PATH_ROW = {
    id: 'm1', role: 'user', content: 'hi', attachments: null, thinking: null,
    tool_calls: null, timestamp: 't', created_at: 1
  }

  function createHarness(rowProfileId: string | null, defaultProfileId: string | null = rowProfileId) {
    const runs: Array<{ key: string; args: unknown[] }> = []
    const service = Object.create(ConversationService.prototype) as ProfileHarness
    service.getDefaultProfileId = () => defaultProfileId
    service.db = {
      exec: vi.fn(),
      prepare: vi.fn(),
      transaction: (fn: () => void) => fn
    } as unknown as ProfileHarness['db']
    service.stmt = vi.fn((key: string) => ({
      run: (...args: unknown[]) => { runs.push({ key, args }) },
      get: () => ({ ...BASE_ROW, profile_id: rowProfileId }),
      all: () => (key === 'pathRows' ? [FORK_PATH_ROW] : [])
    }))
    return { service, runs }
  }

  function columnHarness(columns: string[]) {
    const exec = vi.fn()
    const service = Object.create(ConversationService.prototype) as ProfileHarness
    service.db = {
      exec,
      prepare: () => ({ get: () => undefined, all: () => columns.map((name) => ({ name })) }),
      transaction: (fn: () => void) => fn
    }
    return { service, exec }
  }

  const createConversation = ConversationService.prototype.createConversation as (
    this: ProfileHarness,
    data: Parameters<ConversationService['createConversation']>[0]
  ) => ReturnType<ConversationService['createConversation']>

  const updateConversation = ConversationService.prototype.updateConversation as (
    this: ProfileHarness,
    id: string,
    data: Parameters<ConversationService['updateConversation']>[1]
  ) => void

  const forkConversation = ConversationService.prototype.forkConversation as (
    this: ProfileHarness,
    conversationId: string,
    messageId: string
  ) => ReturnType<ConversationService['forkConversation']>

  it('adds a nullable profile_id column to older databases', () => {
    const { service, exec } = columnHarness(['id', 'workspace_path', 'last_request'])

    service.addColumnsMissingAfterProviderMigration()

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('ALTER TABLE conversations ADD COLUMN profile_id TEXT')
  })

  it('leaves databases that already have profile_id alone', () => {
    const { service, exec } = columnHarness(['id', 'workspace_path', 'last_request', 'profile_id'])

    service.addColumnsMissingAfterProviderMigration()

    expect(exec).not.toHaveBeenCalled()
  })

  it('stamps new chats with the active profile', () => {
    const { service, runs } = createHarness('campaign-a')

    const conversation = createConversation.call(service, { workspacePath: null })

    const insert = runs.find((run) => run.key === 'createConversation')
    expect(insert?.args[8]).toBe('campaign-a')
    expect(conversation.profileId).toBe('campaign-a')
  })

  it('prefers an explicit profile over the active one', () => {
    const { service, runs } = createHarness('committee-b', 'campaign-a')

    createConversation.call(service, { profileId: 'committee-b' })

    expect(runs.find((run) => run.key === 'createConversation')?.args[8]).toBe('committee-b')
  })

  it('updates profile_id only when it is given', () => {
    const { service, runs } = createHarness(null)

    updateConversation.call(service, 'c1', { title: 'Renamed' })
    updateConversation.call(service, 'c1', { profileId: 'committee-b' })

    expect(runs[0].args.slice(11, 14)).toEqual([0, null, 'c1'])
    expect(runs[1].args.slice(11, 14)).toEqual([1, 'committee-b', 'c1'])
  })

  it('rejects a non-string profile id', () => {
    const { service } = createHarness(null)
    expect(() => updateConversation.call(service, 'c1', { profileId: 42 as never })).toThrow(/profileId/)
  })

  it('maps profile_id from rows, treating missing values as null', () => {
    const toConversation = (ConversationService.prototype as unknown as {
      toConversation: (row: Record<string, unknown>) => { profileId: string | null }
    }).toConversation

    expect(toConversation({ ...BASE_ROW, profile_id: 'campaign-a' }).profileId).toBe('campaign-a')
    expect(toConversation({ ...BASE_ROW, profile_id: null }).profileId).toBeNull()
    expect(toConversation({ ...BASE_ROW }).profileId).toBeNull()
  })

  it('carries the profile over when forking', () => {
    const { service, runs } = createHarness('campaign-a')

    const fork = forkConversation.call(service, 'c1', 'm1')

    const insert = runs.find((run) => run.key === 'createForkConversation')
    expect(insert?.args[9]).toBe('campaign-a')
    expect(fork.profileId).toBe('campaign-a')
  })
})

describe('ConversationService search', () => {
  type SearchHarness = DatabaseHarness & { messageSearchIndexed: boolean }

  const searchConversations = ConversationService.prototype.searchConversations as (
    this: SearchHarness,
    query: string
  ) => ReturnType<ConversationService['searchConversations']>

  function searchHarness(indexed: boolean) {
    const all = vi.fn((): Record<string, unknown>[] => [])
    const stmt = vi.fn((_key: string, _sql: string) => ({ all }))
    const service = Object.create(ConversationService.prototype) as SearchHarness
    service.stmt = stmt
    service.messageSearchIndexed = indexed
    return { service, stmt, all }
  }

  it('matches message content through the FTS index as a quoted phrase', () => {
    const { service, stmt, all } = searchHarness(true)
    searchConversations.call(service, '  say "hello" 100%  ')

    expect(stmt.mock.calls[0][0]).toBe('searchConversationsIndexed')
    expect(stmt.mock.calls[0][1]).toContain('messages_fts MATCH ?')
    expect(all).toHaveBeenCalledWith('%say "hello" 100\\%%', '"say ""hello"" 100%"')
  })

  it('falls back to LIKE for queries shorter than a trigram', () => {
    const { service, stmt, all } = searchHarness(true)
    searchConversations.call(service, 'ab')

    expect(stmt.mock.calls[0][0]).toBe('searchConversations')
    expect(all).toHaveBeenCalledWith('%ab%', '%ab%')
  })

  it('falls back to LIKE when the index is unavailable', () => {
    const { service, stmt } = searchHarness(false)
    searchConversations.call(service, 'organizing')

    expect(stmt.mock.calls[0][0]).toBe('searchConversations')
  })
})
