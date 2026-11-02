import { dialog, BrowserWindow } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { handleIpc } from './typedIpc'
import { assertString } from './validate'
import { ChatTransferService, type ChatExportFormat } from '../services/ChatTransferService'
import type { ConversationService } from '../services/ConversationService'

let service: ChatTransferService

export function registerTransferHandlers(conversations: ConversationService): void {
  service = new ChatTransferService(conversations)

  handleIpc('chat:export', async (event, conversationId, formatRaw) => {
    assertString(conversationId, 'conversationId')
    assertString(formatRaw, 'format')
    const format: ChatExportFormat = formatRaw === 'xml' ? 'xml' : 'markdown'

    const win = BrowserWindow.fromWebContents(event.sender) || null
    const suggestedName = service.buildSuggestedFilename(conversationId)
    const extension = format === 'xml' ? 'xml' : 'md'
    const filterName = format === 'xml' ? 'XML' : 'Markdown'

    const dialogOptions = {
      title: 'Export Chat',
      defaultPath: `${suggestedName}.${extension}`,
      filters: [
        { name: filterName, extensions: [extension] },
        { name: 'All Files', extensions: ['*'] }
      ]
    }

    const result = win
      ? await dialog.showSaveDialog(win, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true } as const
    }

    try {
      const content = service.exportConversation(conversationId, format)
      writeFileSync(result.filePath, content, 'utf-8')
      return { ok: true, path: result.filePath } as const
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, canceled: false, error: message } as const
    }
  })

  handleIpc('chat:import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || null

    const dialogOptions = {
      title: 'Import Chat',
      filters: [
        { name: 'XML', extensions: ['xml'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile' as const]
    }

    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true } as const
    }

    try {
      const xml = readFileSync(result.filePaths[0], 'utf-8')
      const { conversation, importedMessageCount } = await service.importFromXml(xml, async (workspacePath) => {
        if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) return false
        const options = {
          type: 'question' as const,
          buttons: ['Import Without Folder', 'Use Folder'],
          defaultId: 0,
          cancelId: 0,
          title: 'Imported Chat Workspace',
          message: 'This chat was linked to a workspace folder. Use it for the imported chat?',
          detail: `${workspacePath}\n\nThe assistant can read and change files in this folder.`
        }
        const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
        return answer.response === 1
      })
      return { ok: true, conversation, importedMessageCount } as const
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, canceled: false, error: message } as const
    }
  })
}
