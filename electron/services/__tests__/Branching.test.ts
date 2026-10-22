import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { ConversationService } from '../ConversationService'
import { ChatTransferService } from '../ChatTransferService'
import type { Message } from '../../../src/types'

const services: ConversationService[] = []
const dirs: string[] = []

function open(dbPath = ':memory:'): ConversationService {
  const service = new ConversationService(dbPath)
  services.push(service)
  return service
}

afterEach(() => {
  for (const service of services.splice(0)) service.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = (messages: Message[]) => messages.map((message) => message.content)

/** A chat with a question and an answer, plus helpers to add to the branch on screen. */
function chatWithTurn(service: ConversationService) {
  const chat = service.createConversation({ title: 'Branches' })
  const say = (role: Message['role'], content: string, parentId?: string | null) =>
    service.createMessage({ conversationId: chat.id, role, content, ...(parentId !== undefined ? { parentId } : {}) })
  const q1 = say('user', 'q1')
  const a1 = say('assistant', 'a1')
  return { chat, say, q1, a1 }
}

describe('existing chats', () => {
  it('become a single branch, in the order they were saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rl-branching-'))
    dirs.push(dir)
    const dbPath = join(dir, 'conversations.db')

    // The schema before branching: no parent_id, no active_leaf_id.
    const legacy = new Database(dbPath)
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Chat', model TEXT NOT NULL DEFAULT 'm',
        provider TEXT NOT NULL DEFAULT 'openrouter', is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, workspace_path TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        attachments TEXT, thinking TEXT, tool_calls TEXT, timestamp TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', 1, 1), ('c2', 1, 1);
      INSERT INTO messages VALUES ('m1', 'c1', 'user', 'first', NULL, NULL, NULL, 't', 30);
      INSERT INTO messages VALUES ('x1', 'c2', 'user', 'other chat', NULL, NULL, NULL, 't', 1);
      INSERT INTO messages VALUES ('m2', 'c1', 'assistant', 'second', NULL, NULL, NULL, 't', 10);
      INSERT INTO messages VALUES ('m3', 'c1', 'user', 'third', NULL, NULL, NULL, 't', 20);
    `)
    legacy.close()

    const service = open(dbPath)
    const messages = service.listMessages('c1')

    // Save order, not created_at, as before.
    expect(ids(messages)).toEqual(['first', 'second', 'third'])
    expect(messages.map((m) => m.parentId)).toEqual([null, 'm1', 'm2'])
    expect(messages.every((m) => m.siblingIds === undefined)).toBe(true)
    expect(ids(service.listMessages('c2'))).toEqual(['other chat'])

    // New messages continue the branch.
    service.createMessage({ conversationId: 'c1', role: 'assistant', content: 'fourth' })
    expect(ids(service.listMessages('c1'))).toEqual(['first', 'second', 'third', 'fourth'])
  })
})

describe('retry', () => {
  it('adds a reply beside the earlier one, and both stay reachable', () => {
    const service = open()
    const { chat, say, q1, a1 } = chatWithTurn(service)

    expect(ids(service.selectBranch(chat.id, q1.id, { exact: true }))).toEqual(['q1'])
    const a2 = say('assistant', 'a2')

    expect(a2.parentId).toBe(q1.id)
    expect(a2.siblingIds).toEqual([a1.id, a2.id])
    expect(ids(service.listMessages(chat.id))).toEqual(['q1', 'a2'])

    const back = service.selectBranch(chat.id, a1.id)
    expect(ids(back)).toEqual(['q1', 'a1'])
    expect(back[1].siblingIds).toEqual([a1.id, a2.id])
  })
})

describe('edit', () => {
  it('adds a new version of the prompt; switching back restores its whole branch', () => {
    const service = open()
    const { chat, say, a1 } = chatWithTurn(service)
    const q2 = say('user', 'q2')
    say('assistant', 'a2')

    const q2b = say('user', 'q2 edited', a1.id)
    expect(q2b.siblingIds).toEqual([q2.id, q2b.id])
    expect(ids(service.listMessages(chat.id))).toEqual(['q1', 'a1', 'q2 edited'])
    say('assistant', 'a2 for the edit')

    // Picking a version shows its newest reply chain.
    expect(ids(service.selectBranch(chat.id, q2.id))).toEqual(['q1', 'a1', 'q2', 'a2'])
    expect(ids(service.selectBranch(chat.id, q2b.id))).toEqual(['q1', 'a1', 'q2 edited', 'a2 for the edit'])
  })

  it('can edit the first message of a chat', () => {
    const service = open()
    const { chat, say, q1 } = chatWithTurn(service)

    const q1b = say('user', 'q1 edited', null)

    expect(q1b.parentId).toBeNull()
    expect(q1b.siblingIds).toEqual([q1.id, q1b.id])
    expect(ids(service.listMessages(chat.id))).toEqual(['q1 edited'])
  })

  it('refuses a parent from another chat', () => {
    const service = open()
    const { q1 } = chatWithTurn(service)
    const other = service.createConversation({})

    expect(() => service.createMessage({ conversationId: other.id, role: 'user', content: 'x', parentId: q1.id }))
      .toThrow(/not found/)
  })
})

describe('deleting a version', () => {
  it('moves to the newest remaining version when the one on screen goes', () => {
    const service = open()
    const { chat, say, q1, a1 } = chatWithTurn(service)
    service.selectBranch(chat.id, q1.id, { exact: true })
    const a2 = say('assistant', 'a2')
    say('user', 'follow-up on a2')

    const after = service.deleteMessageBranch(chat.id, a2.id)

    expect(ids(after)).toEqual(['q1', 'a1'])
    expect(after[1].siblingIds).toBeUndefined()
    expect(service.exportMessages(chat.id).messages.map((m) => m.id)).toEqual([q1.id, a1.id])
  })

  it('leaves the branch on screen alone when another version goes', () => {
    const service = open()
    const { chat, say, q1, a1 } = chatWithTurn(service)
    service.selectBranch(chat.id, q1.id, { exact: true })
    say('assistant', 'a2')

    expect(ids(service.deleteMessageBranch(chat.id, a1.id))).toEqual(['q1', 'a2'])
  })

  it('shows the prompt again when its only reply is dropped', () => {
    const service = open()
    const { chat, a1 } = chatWithTurn(service)

    expect(ids(service.deleteMessageBranch(chat.id, a1.id))).toEqual(['q1'])
  })
})

describe('fork', () => {
  it('copies only the branch on screen, up to the chosen message', () => {
    const service = open()
    const { chat, say, q1 } = chatWithTurn(service)
    service.selectBranch(chat.id, q1.id, { exact: true })
    const a2 = say('assistant', 'a2')
    say('user', 'later')

    const fork = service.forkConversation(chat.id, a2.id)
    const forked = service.listMessages(fork.id)

    expect(ids(forked)).toEqual(['q1', 'a2'])
    expect(forked[1].parentId).toBe(forked[0].id)
    expect(forked.every((m) => m.siblingIds === undefined)).toBe(true)
  })
})

describe('XML export and import', () => {
  it('keeps every version and the branch that was on screen', () => {
    const service = open()
    const transfer = new ChatTransferService(service)
    const { chat, say, q1, a1 } = chatWithTurn(service)
    service.selectBranch(chat.id, q1.id, { exact: true })
    say('assistant', 'a2')
    service.selectBranch(chat.id, a1.id)
    say('user', 'q2 after a1')

    const imported = transfer.importFromXml(transfer.exportConversation(chat.id, 'xml'))
    const importedId = imported.conversation.id

    expect(imported.importedMessageCount).toBe(4)
    const branch = service.listMessages(importedId)
    expect(ids(branch)).toEqual(['q1', 'a1', 'q2 after a1'])
    expect(branch[1].siblingIds).toHaveLength(2)

    const otherReply = branch[1].siblingIds!.find((id) => id !== branch[1].id)!
    expect(ids(service.selectBranch(importedId, otherReply))).toEqual(['q1', 'a2'])
  })
})
