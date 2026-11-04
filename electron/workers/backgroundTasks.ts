import { grepWorkspace, type GrepMatch, type GrepOptions } from '../services/grep'
import { extractDocumentText } from '../services/DocumentTextService'
import { parseAttachmentPaths } from '../services/AttachmentService'
import { sliceTextFile, type FileSlice, type SliceOptions } from '../lib/tools/fileSlice'
import type { AttachmentParseResult } from '../../src/types'

/**
 * Work too heavy for the main process, where it would hold up every other
 * chat, the window's requests and IPC: searching a workspace, pulling the
 * text out of PDFs, Word files and spreadsheets, and paging through very
 * large text files. Each takes and returns plain data, so it can run in a
 * worker thread (taskWorker.ts) or, when there is none (tests), inline.
 */
export const backgroundTasks = {
  grep: (payload: { workspaceRoot: string; options: GrepOptions }): GrepMatch[] =>
    grepWorkspace(payload.workspaceRoot, payload.options),

  extractDocument: (payload: { filePath: string }): Promise<string | null> =>
    extractDocumentText(payload.filePath),

  parseAttachments: (payload: { filePaths: string[] }): Promise<AttachmentParseResult> =>
    parseAttachmentPaths(payload.filePaths),

  sliceTextFile: (payload: { filePath: string; options: SliceOptions }): Promise<FileSlice> =>
    sliceTextFile(payload.filePath, payload.options)
}

export type BackgroundTasks = typeof backgroundTasks
export type BackgroundTaskName = keyof BackgroundTasks
export type BackgroundPayload<T extends BackgroundTaskName> = Parameters<BackgroundTasks[T]>[0]
export type BackgroundResult<T extends BackgroundTaskName> = Awaited<ReturnType<BackgroundTasks[T]>>

/** An error as it crosses the thread boundary: its class name and the fields callers check. */
export interface SerializedError {
  name: string
  message: string
  code?: string
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return { name: err.name, message: err.message, ...(typeof code === 'string' ? { code } : {}) }
  }
  return { name: 'Error', message: String(err) }
}
