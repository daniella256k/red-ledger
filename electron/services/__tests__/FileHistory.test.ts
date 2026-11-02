import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ConversationService } from '../ConversationService'
import { WorkspaceService } from '../WorkspaceService'
import { sanitizeSettings } from '../SettingsService'

let workspaceRoot: string
let conversations: ConversationService

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'rl-history-'))
  conversations = new ConversationService(':memory:')
})

afterEach(() => {
  conversations.close()
  rmSync(workspaceRoot, { recursive: true, force: true })
})

/** A chat with one reply, and a workspace whose changes are recorded under that reply. */
function replyWorkspace() {
  const chat = conversations.createConversation({ title: 'Chat' })
  conversations.createMessage({ conversationId: chat.id, role: 'user', content: 'change files' })
  const reply = conversations.createMessage({ conversationId: chat.id, role: 'assistant', content: '' })
  const base = new WorkspaceService(() => sanitizeSettings(undefined))
  base.setWorkspacePath(workspaceRoot)
  const workspace = base.snapshot(conversations.fileHistory.recorderFor(reply.id, workspaceRoot))
  return { chat, reply, workspace }
}

const read = (name: string) => readFileSync(join(workspaceRoot, name), 'utf-8')

describe('file history', () => {
  it('undoes edits, new files and moves from one reply', async () => {
    writeFileSync(join(workspaceRoot, 'notes.md'), 'v1')
    writeFileSync(join(workspaceRoot, 'draft.md'), 'draft')
    const { chat, reply, workspace } = replyWorkspace()

    await workspace.writeFile(null, 'notes.md', 'v2', false)
    await workspace.editFile(null, 'notes.md', 'v3')
    await workspace.writeFile(null, 'reports/new.md', 'created', false)
    await workspace.moveFile(null, 'draft.md', 'archive/draft.md')

    expect(conversations.fileHistory.repliesWithChanges(chat.id)).toEqual([reply.id])
    expect(conversations.fileHistory.describeChanges(reply.id)).toEqual([
      { path: 'archive/draft.md', action: 'delete', changedSince: false },
      { path: 'draft.md', action: 'restore', changedSince: false },
      { path: 'notes.md', action: 'restore', changedSince: false },
      { path: 'reports/new.md', action: 'delete', changedSince: false }
    ])

    const result = conversations.fileHistory.undo(reply.id)

    expect(result.skipped).toEqual([])
    expect(read('notes.md')).toBe('v1')
    expect(read('draft.md')).toBe('draft')
    expect(existsSync(join(workspaceRoot, 'reports', 'new.md'))).toBe(false)
    expect(existsSync(join(workspaceRoot, 'archive', 'draft.md'))).toBe(false)
    expect(conversations.fileHistory.repliesWithChanges(chat.id)).toEqual([])
    expect(conversations.fileHistory.storedBytes()).toBe(0)
  })

  it('leaves no files beside the workspace files', async () => {
    writeFileSync(join(workspaceRoot, 'notes.md'), 'v1')
    const { workspace } = replyWorkspace()

    await workspace.writeFile(null, 'notes.md', 'v2', false)

    expect(readdirSync(workspaceRoot)).toEqual(['notes.md'])
  })

  it('flags files changed after the reply', async () => {
    writeFileSync(join(workspaceRoot, 'notes.md'), 'v1')
    const { reply, workspace } = replyWorkspace()
    await workspace.writeFile(null, 'notes.md', 'v2', false)

    writeFileSync(join(workspaceRoot, 'notes.md'), 'edited by hand')

    expect(conversations.fileHistory.describeChanges(reply.id)[0]).toMatchObject({ path: 'notes.md', changedSince: true })
  })

  it('stores identical content once and forgets it with the chat', async () => {
    writeFileSync(join(workspaceRoot, 'a.md'), 'same text')
    writeFileSync(join(workspaceRoot, 'b.md'), 'same text')
    const { chat, workspace } = replyWorkspace()

    await workspace.writeFile(null, 'a.md', 'x', false)
    await workspace.writeFile(null, 'b.md', 'y', false)
    expect(conversations.fileHistory.storedBytes()).toBeGreaterThan(0)

    conversations.deleteConversation(chat.id)

    expect(conversations.fileHistory.storedBytes()).toBe(0)
  })

  it('records nothing outside a reply', async () => {
    writeFileSync(join(workspaceRoot, 'notes.md'), 'v1')
    const chat = conversations.createConversation({ title: 'Chat' })
    const workspace = new WorkspaceService(() => sanitizeSettings(undefined))
    workspace.setWorkspacePath(workspaceRoot)

    await workspace.writeFile(null, 'notes.md', 'v2', false)

    expect(conversations.fileHistory.repliesWithChanges(chat.id)).toEqual([])
    expect(read('notes.md')).toBe('v2')
  })
})
