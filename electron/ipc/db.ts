import { handleIpc } from './typedIpc'
import { assertString, assertObject } from './validate'
import { ConversationService } from '../services/ConversationService'

/**
 * Thin IPC adapter for conversation and message operations.
 * All business logic lives in ConversationService.
 */

let service: ConversationService

export function getConversationService(): ConversationService {
  if (!service) {
    throw new Error('ConversationService not initialized')
  }
  return service
}

export function registerDbHandlers(dbPath: string): void {
  service = new ConversationService(dbPath)

  // ─── Conversations ──────────────────────────────────────────────────────

  handleIpc('db:listConversations', () => {
    return service.listConversations()
  })

  handleIpc('db:searchConversations', (_e, query) => {
    assertString(query, 'query')
    return service.searchConversations(query)
  })

  handleIpc('db:getConversation', (_e, id) => {
    assertString(id, 'id')
    return service.getConversation(id)
  })

  handleIpc('db:createConversation', (_e, data) => {
    assertObject(data, 'data')
    return service.createConversation(data)
  })

  handleIpc('db:updateConversation', (_e, id, data) => {
    assertString(id, 'id')
    assertObject(data, 'data')
    return service.updateConversation(id, data)
  })

  handleIpc('db:deleteConversation', (_e, id) => {
    assertString(id, 'id')
    return service.deleteConversation(id)
  })

  handleIpc('db:forkConversation', (_e, conversationId, messageId) => {
    assertString(conversationId, 'conversationId')
    assertString(messageId, 'messageId')
    return service.forkConversation(conversationId, messageId)
  })

  // ─── Messages ───────────────────────────────────────────────────────────

  handleIpc('db:listMessages', (_e, conversationId) => {
    assertString(conversationId, 'conversationId')
    return service.listMessages(conversationId)
  })

  handleIpc('db:createMessage', (_e, data) => {
    assertObject(data, 'data')
    return service.createMessage(data)
  })

  handleIpc('db:updateMessage', (_e, id, data) => {
    assertString(id, 'id')
    assertObject(data, 'data')
    return service.updateMessage(id, data)
  })

  handleIpc('db:deleteMessagesFrom', (_e, conversationId, messageId) => {
    assertString(conversationId, 'conversationId')
    assertString(messageId, 'messageId')
    return service.deleteMessagesFrom(conversationId, messageId)
  })
}
