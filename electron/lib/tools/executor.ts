import type { BrowserWindow } from 'electron'
import type { ToolCall } from '../../../src/types'
import { dispatchTool } from './registry'
import { PathJailError } from '../../services/pathJail'

// Side-effect imports: each tool self-registers when loaded
import './plan'
import './readFile'
import './writeFile'
import './writePdf'
import './appendFile'
import './editFile'
import './listFiles'
import './grepFiles'
import './webSearch'
import './orgSearch'
import './wikiSearch'
import './fetchUrl'

/**
 * Execute a tool call from the LLM and return the same ToolCall with
 * a `result` field populated.
 *
 * **Critical**: File tools route through WorkspaceService which enforces:
 * - All path validation and jail checks
 * - Strict mode dialogs for LLM-initiated file access
 * - Overwrite confirmations for existing files
 *
 * If a tool throws, the error is caught and returned as
 * { error, code } in the result — it does NOT crash the stream.
 * This lets the LLM see what went wrong and potentially self-correct.
 */
export async function executeTool(
  toolCall: ToolCall,
  win: BrowserWindow | null
): Promise<ToolCall> {
  try {
    const result = await dispatchTool(toolCall, win)
    return { ...toolCall, result }
  } catch (err) {
    const isRLError = err instanceof PathJailError ||
      (err instanceof Error && 'code' in err)

    const errorResult = {
      error: err instanceof Error ? err.message : String(err),
      code: isRLError ? (err as PathJailError).code : 'UNKNOWN'
    }

    return { ...toolCall, result: errorResult }
  }
}
