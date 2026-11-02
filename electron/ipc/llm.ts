import { ipcMain, BrowserWindow } from 'electron'
import { LlmService, type StreamSink } from '../services/LlmService'
import type { AttachmentBlob } from '../services/ConversationService'
import { executeTool } from '../lib/tools/executor'
import { getWorkspaceService } from './fs'
import { getConversationService } from './db'
import { assertString, assertObject, assertOptionalNumber } from './validate'
import type { LLMRequest, StreamChunk, ProviderName, Settings, TitleGenerationRequest } from '../../src/types'
import { handleIpc } from './typedIpc'

/**
 * Thin IPC adapter for LLM streaming.
 * All orchestration logic lives in LlmService.
 *
 * The streaming channel (llm:sendMessage) uses event-based IPC
 * instead of the standard invoke/handle pattern, so it's wired manually.
 */

let service: LlmService

export function registerLlmHandlers(deps: {
  getSettings: () => Settings
  getSystemPrompt: (conversationId: string) => string
  getAttachmentBlob: (blobId: string) => AttachmentBlob | null
}): void {
  service = new LlmService(deps)

  // ─── Streaming (event-based, wired manually) ─────────────────────────

  ipcMain.handle('llm:sendMessage', async (event, request: LLMRequest, channel: string) => {
    assertObject(request, 'request')
    assertString(channel, 'channel')
    const win = BrowserWindow.fromWebContents(event.sender)
    try {
      if (!win) {
        throw new Error('No active window for streaming request')
      }

      const sink: StreamSink = {
        send: (chunk) => win.webContents.send(channel, chunk)
      }
      // The folder this chat is in now; later chat switches don't move the turn.
      // File changes are recorded under the reply so they can be undone.
      const workspaceRoot = getWorkspaceService().getWorkspacePath()
      const history = request.replyMessageId && workspaceRoot
        ? getConversationService().fileHistory.recorderFor(request.replyMessageId, workspaceRoot)
        : null
      const workspace = getWorkspaceService().snapshot(history)

      await service.orchestrateStream(
        request,
        channel,
        sink,
        (tc) => executeTool(tc, { win, workspace })
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const errorChunk: StreamChunk = { type: 'error', error: message }
      event.sender.send(channel, errorChunk)
      event.sender.send(channel, { type: 'done' } as StreamChunk)
    }
  })

  // ─── Non-streaming (typed invoke/handle) ──────────────────────────────

  handleIpc('llm:cancelStream', async (_e, channel) => {
    assertString(channel, 'channel')
    service.cancelStream(channel)
  })

  handleIpc('llm:listModels', async (_e, provider) => {
    assertString(provider, 'provider')
    return service.listModels(provider as ProviderName)
  })

  handleIpc('llm:generateTitle', async (_e, request) => {
    assertObject(request, 'request')
    assertString(request.provider, 'request.provider')
    assertString(request.model, 'request.model')
    assertString(request.prompt, 'request.prompt')
    assertOptionalNumber(request.maxTokens, 'request.maxTokens')
    return service.generateTitle(request as TitleGenerationRequest)
  })

  handleIpc('llm:compact', async (_e, request, channel) => {
    assertObject(request, 'request')
    assertString(channel, 'channel')
    return service.compactConversation(request, channel)
  })
}

/** Stops a chat's running reply; safe to call before the LLM handlers exist. */
export function cancelConversationStreams(conversationId: string): void {
  service?.cancelConversationStreams(conversationId)
}
