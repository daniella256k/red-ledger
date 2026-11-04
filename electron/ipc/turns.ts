import { BrowserWindow } from 'electron'
import { TurnService } from '../services/TurnService'
import { executeTool } from '../lib/tools/executor'
import { getWorkspaceService } from './fs'
import { getConversationService } from './db'
import { getLlmService } from './llm'
import { getContextService } from './context'
import { handleIpc } from './typedIpc'
import { assertObject, assertString } from './validate'
import type { Settings, TurnEvent, TurnStartRequest } from '../../src/types'

/**
 * Thin IPC adapter for chat turns. TurnService runs each turn in the main
 * process; the page starts and stops them and follows them through
 * 'turn:event' messages.
 */

let service: TurnService

export function getTurnService(): TurnService {
  if (!service) {
    throw new Error('TurnService not initialized')
  }
  return service
}

function broadcast(event: TurnEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('turn:event', event)
  }
}

function assertTurnStartRequest(value: unknown): TurnStartRequest {
  const request = assertObject(value, 'request')
  assertString(request.conversationId, 'request.conversationId')
  switch (request.kind) {
    case 'send':
      assertString(request.content, 'request.content')
      if (request.attachments !== undefined && !Array.isArray(request.attachments)) {
        throw new Error('request.attachments must be an array')
      }
      break
    case 'retry':
      assertString(request.userMessageId, 'request.userMessageId')
      break
    case 'edit':
      assertString(request.userMessageId, 'request.userMessageId')
      assertString(request.content, 'request.content')
      break
    default:
      throw new Error(`request.kind must be 'send', 'retry' or 'edit', got '${String(request.kind)}'`)
  }
  return request as unknown as TurnStartRequest
}

export function registerTurnHandlers(deps: {
  getSettings: () => Settings
  /** The window confirmation dialogs open over, looked up when a tool asks. */
  getWindow: () => BrowserWindow | null
}): void {
  service = new TurnService({
    conversations: getConversationService(),
    llm: getLlmService(),
    getSettings: deps.getSettings,
    getOpenWorkspace: () => getWorkspaceService().getWorkspacePath(),
    createToolRunner: (replyMessageId, workspaceRoot) => {
      // Pinned to the chat's own folder, so switching chats (and so the open
      // folder) mid-reply can't redirect its tools. File changes are recorded
      // under the reply so they can be undone.
      const history = workspaceRoot
        ? getConversationService().fileHistory.recorderFor(replyMessageId, workspaceRoot)
        : null
      const workspace = getWorkspaceService().snapshot(history)
      workspace.setWorkspacePath(workspaceRoot)
      return (toolCall) => {
        const win = deps.getWindow()
        return executeTool(toolCall, { win: win && !win.isDestroyed() ? win : null, workspace })
      }
    },
    getProfileName: (profileId) => {
      const state = getContextService().listProfiles()
      const own = profileId ? state.profiles.find((profile) => profile.id === profileId) : undefined
      return (own ?? state.profiles.find((profile) => profile.id === state.activeProfileId))?.name ?? null
    },
    emit: broadcast
  })

  handleIpc('turn:start', (_e, request) => service.start(assertTurnStartRequest(request)))

  handleIpc('turn:compact', (_e, conversationId) => {
    assertString(conversationId, 'conversationId')
    return service.compact(conversationId)
  })

  handleIpc('turn:cancel', (_e, conversationId) => {
    assertString(conversationId, 'conversationId')
    service.cancel(conversationId)
  })

  handleIpc('turn:listActive', () => service.listActive())
}

/** Stops a chat's running turn; safe to call before the handlers exist. */
export function cancelConversationTurn(conversationId: string): void {
  service?.cancel(conversationId)
}

/** Stops every running turn. */
export function cancelAllTurns(): void {
  service?.cancelAll()
}

/** Stops every turn and saves what each wrote, before the database closes. */
export function shutdownTurns(): void {
  service?.shutdown()
}
