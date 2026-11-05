import { dialog, type BrowserWindow } from 'electron'
import type { DialogAdapter } from '../../services/WorkspaceService'
import { PathJailError } from '../../services/pathJail'

/** A tool call's question was cut short because the user stopped the reply. */
export function toolStoppedError(): PathJailError {
  return new PathJailError('CANCELLED', 'The reply was stopped, so this was not done.')
}

/**
 * The confirmation dialog a tool call asks through (overwrites, Strict Mode).
 * It fails closed: with no window to ask over, the question counts as
 * answered no, so nothing a prompt guards happens unconfirmed. Stopping the
 * reply closes an open question unanswered, and the tool does nothing.
 *
 * Every tool question puts its refusing answer (Cancel or Deny) first, so
 * Esc and a closed question both come back as 0.
 */
export function toolDialog(win: BrowserWindow | null, signal?: AbortSignal): DialogAdapter {
  return {
    showMessageBox: async (options) => {
      if (signal?.aborted) throw toolStoppedError()
      if (!win || win.isDestroyed()) {
        throw new PathJailError('USER_DENIED', 'No app window is open to ask the user, so this was not done.')
      }
      const answer = await dialog.showMessageBox(win, { ...options, cancelId: 0, ...(signal ? { signal } : {}) })
      if (signal?.aborted) throw toolStoppedError()
      return answer
    }
  }
}
