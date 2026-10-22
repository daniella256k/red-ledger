import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { ConversationService } from '../ConversationService'
import { StorageService } from '../StorageService'
import type { ImageAttachment } from '../../../src/types'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])
const OTHER_BYTES = Buffer.from([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9])
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`
const OTHER_DATA_URL = `data:image/jpeg;base64,${OTHER_BYTES.toString('base64')}`
const PNG_ID = createHash('sha256').update(PNG_BYTES).digest('hex')

const services: ConversationService[] = []
const dirs: string[] = []

function open(dbPath = ':memory:'): ConversationService {
  const service = new ConversationService(dbPath)
  services.push(service)
  return service
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rl-attachments-'))
  dirs.push(dir)
  return dir
}

function image(name: string, dataUrl: string): ImageAttachment {
  return { kind: 'image', name, mimeType: dataUrl.includes('jpeg') ? 'image/jpeg' : 'image/png', dataUrl }
}

function rawDb(service: ConversationService) {
  return (service as unknown as { db: import('better-sqlite3').Database }).db
}

function blobCount(service: ConversationService): number {
  return (rawDb(service).prepare('SELECT COUNT(*) AS n FROM attachment_blobs').get() as { n: number }).n
}

afterEach(() => {
  for (const service of services.splice(0)) service.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('attachment store', () => {
  it('saves images as stored bytes and keeps only a reference in the message', () => {
    const service = open()
    const chat = service.createConversation({ title: 'Photos' })
    const message = service.createMessage({
      conversationId: chat.id,
      role: 'user',
      content: 'look',
      attachments: [image('a.png', PNG_DATA_URL), { kind: 'text', name: 'notes.txt', content: 'hello' }]
    })

    expect(message.attachments).toEqual([
      { kind: 'image', name: 'a.png', mimeType: 'image/png', blobId: PNG_ID, size: PNG_BYTES.length },
      { kind: 'text', name: 'notes.txt', content: 'hello' }
    ])
    const stored = rawDb(service).prepare('SELECT attachments FROM messages WHERE id = ?').get(message.id) as { attachments: string }
    expect(stored.attachments).not.toContain('base64')

    const blob = service.getAttachmentBlob(PNG_ID)
    expect(blob?.mimeType).toBe('image/png')
    expect(Buffer.compare(blob!.data, PNG_BYTES)).toBe(0)
  })

  it('keeps one copy of an image however many messages use it', () => {
    const service = open()
    const chat = service.createConversation({})
    const first = service.createMessage({ conversationId: chat.id, role: 'user', content: '1', attachments: [image('a.png', PNG_DATA_URL)] })
    service.createMessage({ conversationId: chat.id, role: 'user', content: '2', attachments: [image('again.png', PNG_DATA_URL)] })
    // A resent message refers to the stored image instead of carrying its bytes.
    service.createMessage({ conversationId: chat.id, role: 'user', content: '3', attachments: first.attachments })

    expect(blobCount(service)).toBe(1)
    expect(() => service.createMessage({
      conversationId: chat.id,
      role: 'user',
      content: '4',
      attachments: [{ kind: 'image', name: 'gone.png', mimeType: 'image/png', blobId: 'b'.repeat(64) }]
    })).toThrow(/no longer stored/)
  })

  it('shares images with forks and deletes them once no chat uses them', () => {
    const service = open()
    const chat = service.createConversation({ title: 'Source' })
    service.createMessage({ conversationId: chat.id, role: 'user', content: 'q', attachments: [image('a.png', PNG_DATA_URL)] })
    const reply = service.createMessage({ conversationId: chat.id, role: 'assistant', content: 'a' })
    const fork = service.forkConversation(chat.id, reply.id)

    expect(blobCount(service)).toBe(1)
    service.deleteConversation(chat.id)
    expect(blobCount(service)).toBe(1)
    expect(service.listMessages(fork.id)[0].attachments?.[0]).toMatchObject({ blobId: PNG_ID })

    service.deleteConversation(fork.id)
    expect(blobCount(service)).toBe(0)
  })

  it('deletes an image when the messages that used it are deleted', () => {
    const service = open()
    const chat = service.createConversation({})
    const keep = service.createMessage({ conversationId: chat.id, role: 'user', content: 'keep', attachments: [image('a.png', PNG_DATA_URL)] })
    const drop = service.createMessage({ conversationId: chat.id, role: 'user', content: 'drop', attachments: [image('b.jpg', OTHER_DATA_URL)] })

    service.deleteMessagesFrom(chat.id, drop.id)

    expect(blobCount(service)).toBe(1)
    expect(service.listMessages(chat.id).map((m) => m.id)).toEqual([keep.id])
  })

  it('removes an image from every chat that uses it, keeping the messages', () => {
    const service = open()
    const chat = service.createConversation({ title: 'Source' })
    const question = service.createMessage({ conversationId: chat.id, role: 'user', content: 'q', attachments: [image('a.png', PNG_DATA_URL), image('b.jpg', OTHER_DATA_URL)] })
    const fork = service.forkConversation(chat.id, question.id)

    const result = service.removeStoredImage(PNG_ID)

    expect(result.freedBytes).toBe(PNG_BYTES.length)
    expect(result.conversationIds.sort()).toEqual([chat.id, fork.id].sort())
    expect(service.getAttachmentBlob(PNG_ID)).toBeNull()
    for (const conversationId of [chat.id, fork.id]) {
      const [message] = service.listMessages(conversationId)
      expect(message.content).toBe('q')
      expect(message.attachments).toEqual([
        { kind: 'image', name: 'a.png', mimeType: 'image/png', size: PNG_BYTES.length, removed: true },
        expect.objectContaining({ name: 'b.jpg', blobId: expect.any(String) })
      ])
    }
    expect(service.removeStoredImage(PNG_ID)).toEqual({ freedBytes: 0, conversationIds: [] })
  })

  it('inlines stored images again for export', () => {
    const service = open()
    const chat = service.createConversation({})
    service.createMessage({ conversationId: chat.id, role: 'user', content: 'q', attachments: [image('a.png', PNG_DATA_URL)] })

    const [message] = service.listMessagesWithImageData(chat.id)
    expect(message.attachments).toEqual([{ kind: 'image', name: 'a.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL }])
  })
})

describe('moving inline images into the attachment store', () => {
  it('moves base64 images byte for byte, after backing the database up', () => {
    const dir = tempDir()
    const dbPath = join(dir, 'conversations.db')
    const legacy = open(dbPath)
    const chat = legacy.createConversation({ title: 'Old chat' })
    const message = legacy.createMessage({ conversationId: chat.id, role: 'user', content: 'old', attachments: [] })
    // How images were saved before the attachment store existed.
    rawDb(legacy).prepare('UPDATE messages SET attachments = ? WHERE id = ?').run(JSON.stringify([
      { kind: 'image', name: 'a.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL },
      { kind: 'image', name: 'broken.png', mimeType: 'image/png', dataUrl: 'not a data url' },
      { kind: 'text', name: 'notes.txt', content: 'mentions "dataUrl" in passing' }
    ]), message.id)
    legacy.close()
    services.splice(services.indexOf(legacy), 1)

    const upgraded = open(dbPath)

    expect(existsSync(join(dir, 'conversations.pre-attachment-store.db'))).toBe(true)
    expect(upgraded.listMessages(chat.id)[0].attachments).toEqual([
      { kind: 'image', name: 'a.png', mimeType: 'image/png', blobId: PNG_ID, size: PNG_BYTES.length },
      { kind: 'image', name: 'broken.png', mimeType: 'image/png', dataUrl: 'not a data url' },
      { kind: 'text', name: 'notes.txt', content: 'mentions "dataUrl" in passing' }
    ])
    expect(Buffer.compare(upgraded.getAttachmentBlob(PNG_ID)!.data, PNG_BYTES)).toBe(0)
  })

  it('does nothing, and makes no backup, when there is nothing to move', () => {
    const dir = tempDir()
    const dbPath = join(dir, 'conversations.db')
    const service = open(dbPath)
    const chat = service.createConversation({})
    service.createMessage({ conversationId: chat.id, role: 'user', content: 'x', attachments: [{ kind: 'text', name: 'a', content: '"dataUrl"' }] })
    service.close()
    services.splice(services.indexOf(service), 1)

    open(dbPath)
    expect(existsSync(join(dir, 'conversations.pre-attachment-store.db'))).toBe(false)
  })
})

describe('storage listings', () => {
  it('sizes chats with their images and lists images with the chats that use them', () => {
    const service = open()
    const small = service.createConversation({ title: 'Small' })
    service.createMessage({ conversationId: small.id, role: 'user', content: 'hi' })
    const big = service.createConversation({ title: 'Big' })
    const question = service.createMessage({ conversationId: big.id, role: 'user', content: 'q', attachments: [image('a.png', PNG_DATA_URL), image('b.jpg', OTHER_DATA_URL)] })
    const fork = service.forkConversation(big.id, question.id)

    const chats = service.listChatStorage()
    // The fork is as large as its source: an image shared with a fork counts in both.
    expect(chats.map((chat) => chat.title).slice(0, 2).sort()).toEqual(['Big', 'Big (Fork)'])
    const bigInfo = chats.find((chat) => chat.conversationId === big.id)!
    expect(bigInfo).toMatchObject({ messageCount: 1, imageCount: 2, imageBytes: PNG_BYTES.length + OTHER_BYTES.length })
    expect(bigInfo.totalBytes).toBe(bigInfo.textBytes + bigInfo.imageBytes)
    expect(chats[chats.length - 1].title).toBe('Small')

    const images = service.listStoredImages()
    expect(images.map((stored) => stored.name)).toEqual(['b.jpg', 'a.png'])
    expect(images[0].chats.map((chat) => chat.conversationId).sort()).toEqual([big.id, fork.id].sort())
    expect(service.getStoredImageBytes()).toBe(PNG_BYTES.length + OTHER_BYTES.length)
  })

  it('compacts the file and only touches backups it lists', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'conversations.db')
    const conversations = open(dbPath)
    const chat = conversations.createConversation({})
    conversations.createMessage({ conversationId: chat.id, role: 'user', content: 'x'.repeat(200_000) })
    conversations.deleteConversation(chat.id)
    rawDb(conversations).prepare('VACUUM INTO ?').run(join(dir, 'conversations.pre-test.db'))

    let cleared = 0
    const storage = new StorageService({
      conversations,
      dbPath,
      profilePath: dir,
      cacheCleaner: { clear: async () => { cleared += 1 } }
    })

    expect(storage.getOverview().reclaimableBytes).toBeGreaterThan(100_000)
    const result = storage.compact()
    expect(result.afterBytes).toBeLessThan(result.beforeBytes)
    expect(storage.getOverview().reclaimableBytes).toBe(0)

    expect(storage.listBackups().map((backup) => backup.name)).toEqual(['conversations.pre-test.db'])
    expect(() => storage.deleteBackup('conversations.db')).toThrow(/Backup not found/)
    expect(() => storage.deleteBackup('../conversations.pre-test.db')).toThrow(/Backup not found/)
    storage.deleteBackup('conversations.pre-test.db')
    expect(storage.listBackups()).toEqual([])

    await storage.clearCaches()
    expect(cleared).toBe(1)
  })
})
