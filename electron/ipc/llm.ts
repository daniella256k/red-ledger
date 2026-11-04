import { LlmService } from '../services/LlmService'
import type { AttachmentBlob } from '../services/ConversationService'
import { assertString } from './validate'
import type { ProviderName, Settings } from '../../src/types'
import { handleIpc } from './typedIpc'

/**
 * Thin IPC adapter for the LLM service. Turns (replies and compactions) are
 * run by TurnService (see ipc/turns.ts); this only lists models.
 */

let service: LlmService

export function getLlmService(): LlmService {
  if (!service) {
    throw new Error('LlmService not initialized')
  }
  return service
}

export function registerLlmHandlers(deps: {
  getSettings: () => Settings
  getSystemPrompt: (conversationId: string) => string
  getAttachmentBlob: (blobId: string) => AttachmentBlob | null
}): void {
  service = new LlmService(deps)

  handleIpc('llm:listModels', async (_e, provider) => {
    assertString(provider, 'provider')
    return service.listModels(provider as ProviderName)
  })
}
