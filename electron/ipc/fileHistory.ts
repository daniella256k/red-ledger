import { BrowserWindow, dialog } from 'electron'
import { handleIpc } from './typedIpc'
import { assertString } from './validate'
import type { FileHistoryStore, FileChangeSummary } from '../services/FileHistoryService'

/**
 * Thin IPC adapter for undoing a reply's workspace file changes.
 * The history itself lives in FileHistoryStore (in the chat database).
 */

const ACTION_LABELS: Record<FileChangeSummary['action'], string> = {
  restore: 'restore the previous version',
  delete: 'delete (the reply created it)',
  unavailable: 'cannot undo (too large to keep, no longer reachable, or a folder is there now)'
}

function describe(changes: FileChangeSummary[]): string {
  const lines = changes.map((change) => `${change.path}: ${ACTION_LABELS[change.action]}`)
  const edited = changes.filter((change) => change.changedSince && change.action !== 'unavailable')
  if (edited.length > 0) {
    lines.push(
      '',
      `Changed since this reply, so undo also discards those later changes: ${edited.map((change) => change.path).join(', ')}`
    )
  }
  return lines.join('\n')
}

export function registerFileHistoryHandlers(history: FileHistoryStore): void {
  handleIpc('fileHistory:replies', (_e, conversationId) => {
    assertString(conversationId, 'conversationId')
    return history.repliesWithChanges(conversationId)
  })

  handleIpc('fileHistory:undo', async (event, messageId) => {
    assertString(messageId, 'messageId')
    const changes = history.describeChanges(messageId)
    if (changes.length === 0) return { undone: [], skipped: [], failed: [] }

    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Undo Changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Undo File Changes',
      message: `Undo this reply's changes to ${changes.length} file${changes.length === 1 ? '' : 's'}?`,
      detail: describe(changes)
    }
    const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    if (answer.response !== 1) return null
    return history.undo(messageId)
  })
}
