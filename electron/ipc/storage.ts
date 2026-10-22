import { session, shell } from 'electron'
import { handleIpc } from './typedIpc'
import { assertString } from './validate'
import { StorageService } from '../services/StorageService'
import type { ConversationService } from '../services/ConversationService'

/**
 * Thin IPC adapter for the Storage panel.
 * All logic lives in StorageService and ConversationService.
 */

let service: StorageService

export function registerStorageHandlers(deps: {
  conversations: ConversationService
  dbPath: string
  profilePath: string
}): void {
  const { conversations } = deps
  service = new StorageService({
    ...deps,
    cacheCleaner: {
      clear: async () => {
        // The app's own data (local storage, IndexedDB) is left alone.
        const defaultSession = session.defaultSession
        await defaultSession.clearCache()
        await defaultSession.clearCodeCaches({})
        await defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage', 'shadercache'] })
      }
    }
  })

  handleIpc('storage:getOverview', () => service.getOverview())

  handleIpc('storage:listChats', () => conversations.listChatStorage())

  handleIpc('storage:listImages', () => conversations.listStoredImages())

  handleIpc('storage:removeImage', (_e, blobId) => {
    assertString(blobId, 'blobId')
    return conversations.removeStoredImage(blobId)
  })

  handleIpc('storage:compact', () => service.compact())

  handleIpc('storage:clearCaches', () => service.clearCaches())

  handleIpc('storage:showBackup', (_e, name) => {
    assertString(name, 'name')
    shell.showItemInFolder(service.backupPath(name))
  })

  handleIpc('storage:deleteBackup', (_e, name) => {
    assertString(name, 'name')
    service.deleteBackup(name)
  })
}
