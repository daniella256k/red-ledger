import { basename, dirname, resolve } from 'path'
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, lstatSync, mkdirSync, renameSync } from 'fs'
import { resolveWorkspacePath, PathJailError } from './pathJail'
import { loadGitignoreRules, isIgnoredByGitignore, type GitignoreRule } from './gitignore'
import { closeSync, openSync, readSync } from 'fs'
import { DocumentExtractionError, isExtractedDocument } from './DocumentTextService'
import { runInBackground } from '../workers/background'
import { decodeText, looksLikeText } from './AttachmentService'
import { sliceFileContent, type FileSlice, type SliceOptions } from '../lib/tools/fileSlice'
import { ALWAYS_SKIPPED, grepWorkspace, type GrepMatch, type GrepOptions } from './grep'
import type { FileChangeRecorder } from './FileHistoryService'
import type { FileNode, Settings } from '../../src/types'

// Re-export so IPC handlers can use the error type
export { PathJailError } from './pathJail'
// Search helpers live in grep.ts (so a worker thread can run them); re-exported for callers here.
export {
  buildGlobMatcher,
  buildGrepMatcher,
  excerptAroundMatch,
  DEFAULT_GREP_CONTEXT_CHARS,
  GREP_REGEX_BUDGET_MS,
  type GrepMatch,
  type GrepOptions
} from './grep'

/** Most entries the sidebar's file tree lists; list_files uses a smaller budget for the model. */
export const FILE_TREE_MAX_ENTRIES = 10_000

/** Text files up to this size are read whole by read_file; larger ones are paged line by line. */
export const READ_FILE_LOAD_BYTES = 8 * 1024 * 1024
/** The file viewer shows at most this much of a text file. */
export const VIEWER_MAX_BYTES = 2 * 1024 * 1024
/** How much of a file's start is checked for NUL bytes to tell binary files apart. */
const BINARY_PROBE_BYTES = 4096

/** The first `length` bytes of a file. */
function readHead(fullPath: string, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  if (length === 0) return buffer
  const fd = openSync(fullPath, 'r')
  try {
    const read = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/** Binary, judged like attachments: NUL bytes or many control characters near the start (UTF-16 with a BOM is text). */
function isBinary(head: Buffer): boolean {
  return !looksLikeText(head.subarray(0, BINARY_PROBE_BYTES))
}

function formatMegabytes(bytes: number): string {
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`
}

/**
 * Adapter for user confirmation dialogs.
 * In production, backed by Electron's dialog.showMessageBox.
 * In tests, a mock.
 */
export interface DialogAdapter {
  showMessageBox(options: {
    type: 'question' | 'warning' | 'error' | 'info' | 'none'
    buttons: string[]
    defaultId: number
    title: string
    message: string
    detail?: string
  }): Promise<{ response: number }>
}

/**
 * Domain service for workspace file operations.
 * Owns path jail enforcement, file read/write/list, and gitignore filtering.
 * No Electron imports — dialogs are injected via DialogAdapter.
 */
export class WorkspaceService {
  private workspacePath: string | null = null
  private getSettings: () => Settings
  /** Keeps what files looked like before a reply changed them, for undo; null outside a reply. */
  private history: FileChangeRecorder | null = null

  constructor(getSettings: () => Settings) {
    this.getSettings = getSettings
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  setWorkspacePath(path: string | null): void {
    this.workspacePath = path
  }

  /**
   * A copy fixed to the current folder. A chat's tool calls run against one so
   * switching chats (and so the active workspace) mid-reply can't redirect them.
   */
  snapshot(history: FileChangeRecorder | null = null): WorkspaceService {
    const pinned = new WorkspaceService(this.getSettings)
    pinned.setWorkspacePath(this.workspacePath)
    pinned.history = history
    return pinned
  }

  /**
   * Runs a change to workspace files, recording each file's state before and
   * after it for undo. History is a convenience: if it can't be recorded the
   * change still goes ahead.
   */
  private changeFiles<T>(fullPaths: string[], change: () => T): T {
    const record = (step: 'beforeChange' | 'afterChange') => {
      if (!this.history) return
      for (const fullPath of fullPaths) {
        try {
          this.history[step](fullPath)
        } catch (err) {
          console.warn(`[WorkspaceService] Could not record file history for ${fullPath}:`, err)
        }
      }
    }
    record('beforeChange')
    try {
      return change()
    } finally {
      record('afterChange')
    }
  }

  private resolveWriteTarget(relativePath: string): { fullPath: string; fileExists: boolean } {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }

    const fullPath = resolveWorkspacePath(this.workspacePath, relativePath)
    return { fullPath, fileExists: existsSync(fullPath) }
  }

  private async confirmWriteAllowed(
    dialog: DialogAdapter | null,
    relativePath: string,
    fullPath: string,
    fileExists: boolean,
    append: boolean
  ): Promise<void> {
    if (!dialog) return

    const settings = this.getSettings()

    // Overwrite confirmation (always, regardless of strict mode)
    if (fileExists && !append) {
      const confirmed = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Cancel', 'Overwrite'],
        defaultId: 0,
        title: 'Overwrite File',
        message: this.history
          ? "Overwrite existing file? You can undo this reply's file changes from the chat."
          : 'Overwrite existing file?',
        detail: fullPath
      })
      if (confirmed.response === 0) {
        throw new PathJailError('USER_DENIED', 'User cancelled file overwrite')
      }
    }

    // Strict mode check for append operations
    if (settings.strictMode && append) {
      const confirmed = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Deny', 'Allow'],
        defaultId: 0,
        title: 'File Append Request',
        message: fileExists
          ? `The assistant wants to append to: ${relativePath}`
          : `The assistant wants to create and append to: ${relativePath}`,
        detail: 'Do you want to allow this file modification?'
      })
      if (confirmed.response === 0) {
        throw new PathJailError('USER_DENIED', 'User denied file append')
      }
    }

    // Strict mode check for new file creation
    if (!append && !fileExists && settings.strictMode) {
      const confirmed = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Deny', 'Allow'],
        defaultId: 0,
        title: 'File Write Request',
        message: `The assistant wants to create: ${relativePath}`,
        detail: 'Do you want to allow this file creation?'
      })
      if (confirmed.response === 0) {
        throw new PathJailError('USER_DENIED', 'User denied file creation')
      }
    }
  }

  // ─── File Operations ──────────────────────────────────────────────────────

  /** Absolute path of an existing workspace file, for handing to the OS shell. */
  resolveExistingPath(relativePath: string): string {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }

    const fullPath = resolveWorkspacePath(this.workspacePath, relativePath)
    if (!existsSync(fullPath)) {
      throw new PathJailError('FILE_NOT_FOUND', `File not found: ${relativePath}`)
    }
    return fullPath
  }

  /** Strict Mode: the assistant asks before reading a file. */
  private async confirmRead(dialog: DialogAdapter | null, relativePath: string): Promise<void> {
    if (!dialog || !this.getSettings().strictMode) return
    const confirmed = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Deny', 'Allow'],
      defaultId: 0,
      title: 'File Read Request',
      message: `The assistant wants to read: ${relativePath}`,
      detail: 'Do you want to allow this file read?'
    })
    if (confirmed.response === 0) {
      throw new PathJailError('USER_DENIED', 'User denied file read')
    }
  }

  /** A workspace file that exists and is a file, as a full path. */
  private resolveReadableFile(relativePath: string): string {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }
    const fullPath = resolveWorkspacePath(this.workspacePath, relativePath)
    if (!existsSync(fullPath)) {
      throw new PathJailError('FILE_NOT_FOUND', `File not found: ${relativePath}`)
    }
    if (statSync(fullPath).isDirectory()) {
      throw new PathJailError('UNSUPPORTED_FILE', `"${relativePath}" is a folder. Use list_files to see what is in it.`)
    }
    return fullPath
  }

  /** The text of a PDF, Word file or spreadsheet (pulled out in a worker), or null for other files. */
  private async documentText(fullPath: string, relativePath: string): Promise<string | null> {
    try {
      return await runInBackground('extractDocument', { filePath: fullPath })
    } catch (err) {
      if (err instanceof DocumentExtractionError) {
        throw new Error(`Could not extract text from ${relativePath}: ${err.message}`, { cause: err })
      }
      throw err
    }
  }

  /**
   * A file's text for the file viewer: documents as their extracted text,
   * other files as UTF-8. A text file over VIEWER_MAX_BYTES shows its start
   * with a note, so a huge log can't stall the window (the viewer never
   * saves, so nothing is lost). Binary files are refused.
   */
  async readFile(dialog: DialogAdapter | null, relativePath: string): Promise<string> {
    const fullPath = this.resolveReadableFile(relativePath)
    await this.confirmRead(dialog, relativePath)

    const documentText = await this.documentText(fullPath, relativePath)
    if (documentText !== null) return documentText

    const size = statSync(fullPath).size
    const head = readHead(fullPath, Math.min(size, VIEWER_MAX_BYTES))
    if (isBinary(head)) {
      throw new PathJailError('UNSUPPORTED_FILE', `"${relativePath}" is a binary file, so it can't be shown as text.`)
    }
    if (size <= VIEWER_MAX_BYTES) return decodeText(head)

    // Cut at the last full line, so no character or line is shown half.
    const text = new TextDecoder('utf-8').decode(head)
    const lastNewline = text.lastIndexOf('\n')
    const shown = lastNewline > 0 ? text.slice(0, lastNewline + 1) : text
    return `${shown}\n[Showing the first ${formatMegabytes(VIEWER_MAX_BYTES)} of ${formatMegabytes(size)}. Open the file in another app to see the rest.]\n`
  }

  /**
   * A page of a file for the read_file tool (see fileSlice.ts). Documents are
   * paged from their extracted text. Text files up to READ_FILE_LOAD_BYTES
   * are read whole; larger ones are paged by a worker that reads them line
   * by line, so any size works without loading it all. Binary files are
   * refused, since their bytes as text would only waste the model's context.
   */
  async readFileSlice(dialog: DialogAdapter | null, relativePath: string, options: SliceOptions = {}): Promise<FileSlice> {
    const fullPath = this.resolveReadableFile(relativePath)
    await this.confirmRead(dialog, relativePath)

    const documentText = await this.documentText(fullPath, relativePath)
    if (documentText !== null) return sliceFileContent(documentText, options)

    const size = statSync(fullPath).size
    if (isBinary(readHead(fullPath, BINARY_PROBE_BYTES))) {
      throw new PathJailError(
        'UNSUPPORTED_FILE',
        `"${relativePath}" is a binary file. read_file reads text files, PDFs, Word files and spreadsheets.`
      )
    }
    if (size <= READ_FILE_LOAD_BYTES) return sliceFileContent(decodeText(readFileSync(fullPath)), options)
    return runInBackground('sliceTextFile', { filePath: fullPath, options })
  }

  /**
   * A file's raw text for an exact-string edit. Documents (read as extracted
   * text), binary files and text that isn't valid UTF-8 are refused, since
   * writing the edited string back would replace the original bytes.
   */
  readTextForEdit(relativePath: string): string {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }

    const fullPath = resolveWorkspacePath(this.workspacePath, relativePath)
    if (!existsSync(fullPath)) {
      throw new PathJailError('FILE_NOT_FOUND', `File not found: ${relativePath}`)
    }
    if (isExtractedDocument(fullPath)) {
      throw new PathJailError(
        'UNSUPPORTED_FILE',
        `edit_file only edits plain text files, and "${relativePath}" is a document. `
          + 'Write a new file with write_file (or write_pdf) instead.'
      )
    }

    const raw = readFileSync(fullPath)
    if (raw.subarray(0, 4096).includes(0)) {
      throw new PathJailError('UNSUPPORTED_FILE', `edit_file only edits text files, and "${relativePath}" is binary.`)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
    } catch {
      throw new PathJailError(
        'UNSUPPORTED_FILE',
        `"${relativePath}" is not UTF-8 text, so edit_file can't change it without corrupting other characters.`
      )
    }
  }

  async writeFile(
    dialog: DialogAdapter | null,
    relativePath: string,
    content: string,
    append: boolean = false
  ): Promise<void> {
    const { fullPath, fileExists } = this.resolveWriteTarget(relativePath)
    if (append && fileExists && isExtractedDocument(fullPath)) {
      throw new PathJailError(
        'UNSUPPORTED_FILE',
        `Appending text to "${relativePath}" would corrupt the document. Write a new file instead.`
      )
    }
    await this.confirmWriteAllowed(dialog, relativePath, fullPath, fileExists, append)

    this.changeFiles([fullPath], () => {
      mkdirSync(dirname(fullPath), { recursive: true })
      if (append) {
        appendFileSync(fullPath, content, 'utf-8')
      } else {
        writeFileSync(fullPath, content, 'utf-8')
      }
    })
  }

  async editFile(
    dialog: DialogAdapter | null,
    relativePath: string,
    content: string
  ): Promise<void> {
    const { fullPath, fileExists } = this.resolveWriteTarget(relativePath)
    if (!fileExists) {
      throw new PathJailError('FILE_NOT_FOUND', `Cannot edit nonexistent file: ${relativePath}`)
    }

    if (dialog && this.getSettings().strictMode) {
      const confirmed = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Deny', 'Allow'],
        defaultId: 0,
        title: 'File Edit Request',
        message: `The assistant wants to edit: ${relativePath}`,
        detail: 'Do you want to allow this file edit?'
      })
      if (confirmed.response === 0) {
        throw new PathJailError('USER_DENIED', 'User denied file edit')
      }
    }

    this.changeFiles([fullPath], () => writeFileSync(fullPath, content, 'utf-8'))
  }

  async writeBinaryFile(
    dialog: DialogAdapter | null,
    relativePath: string,
    content: Buffer
  ): Promise<void> {
    const { fullPath, fileExists } = this.resolveWriteTarget(relativePath)
    await this.confirmWriteAllowed(dialog, relativePath, fullPath, fileExists, false)

    this.changeFiles([fullPath], () => {
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content)
    })
  }

  /**
   * Move or rename a file within the workspace. If `toRelative` is an existing
   * directory the file keeps its name inside it. Never overwrites: an existing
   * destination file is an error.
   */
  async moveFile(
    dialog: DialogAdapter | null,
    fromRelative: string,
    toRelative: string
  ): Promise<{ from: string; to: string }> {
    const { fullPath: fromPath, fileExists } = this.resolveWriteTarget(fromRelative)
    if (!fileExists) {
      throw new PathJailError('FILE_NOT_FOUND', `File not found: ${fromRelative}`)
    }
    if (statSync(fromPath).isDirectory()) {
      throw new Error(`move_file only moves files, and "${fromRelative}" is a directory`)
    }

    let { fullPath: toPath } = this.resolveWriteTarget(toRelative)
    let toDisplay = toRelative
    if (existsSync(toPath) && statSync(toPath).isDirectory()) {
      toDisplay = `${toRelative.replace(/[\\/]+$/, '')}/${basename(fromPath)}`
      toPath = this.resolveWriteTarget(toDisplay).fullPath
    }
    if (existsSync(toPath)) {
      throw new Error(`Destination already exists: ${toDisplay}. Choose a different name.`)
    }

    if (dialog && this.getSettings().strictMode) {
      const confirmed = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Deny', 'Allow'],
        defaultId: 0,
        title: 'File Move Request',
        message: `The assistant wants to move: ${fromRelative}`,
        detail: `New location: ${toDisplay}`
      })
      if (confirmed.response === 0) {
        throw new PathJailError('USER_DENIED', 'User denied file move')
      }
    }

    this.changeFiles([fromPath, toPath], () => {
      mkdirSync(dirname(toPath), { recursive: true })
      renameSync(fromPath, toPath)
    })
    return { from: fromRelative, to: toDisplay }
  }

  /** Strict Mode: a search returns file contents, so it is asked about like a read. */
  async confirmSearch(dialog: DialogAdapter | null, pattern: string, relativePath?: string): Promise<void> {
    if (!dialog || !this.getSettings().strictMode) return

    const confirmed = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Deny', 'Allow'],
      defaultId: 0,
      title: 'File Search Request',
      message: `The assistant wants to search ${relativePath ? `"${relativePath}"` : 'the workspace'} for: ${pattern}`,
      detail: 'Matching lines are sent to the model. Do you want to allow this search?'
    })
    if (confirmed.response === 0) {
      throw new PathJailError('USER_DENIED', 'User denied file search')
    }
  }

  /** Searches the workspace's files (see grep.ts). */
  grepFiles(options: GrepOptions): GrepMatch[] {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }
    return grepWorkspace(this.workspacePath, options)
  }

  /** Searches the workspace's files in a worker thread, so a big search doesn't hold up the app. */
  async searchFiles(options: GrepOptions): Promise<GrepMatch[]> {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }
    return runInBackground('grep', { workspaceRoot: this.workspacePath, options })
  }

  /** The workspace tree (or a folder's) for the sidebar, up to FILE_TREE_MAX_ENTRIES entries. */
  listFiles(relativePath?: string, options: { includeHidden?: boolean; maxEntries?: number } = {}): FileNode[] {
    return this.listFileTree(relativePath, options).nodes
  }

  /**
   * The tree under a folder, breadth first: every entry of a folder before
   * anything inside its subfolders, so a large workspace still shows its top
   * levels whole. Stops after `maxEntries`; folders not reached are marked
   * truncated (with no children), and so is a folder listed only in part.
   * Skips node_modules, .git, symlinks and .gitignore'd files, and dotfiles
   * unless asked for. Unreadable folders show as empty.
   */
  listFileTree(
    relativePath?: string,
    options: { includeHidden?: boolean; maxEntries?: number } = {}
  ): { nodes: FileNode[]; truncated: boolean; entries: number } {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }
    const rootPath = this.workspacePath
    const targetDir = relativePath ? resolveWorkspacePath(rootPath, relativePath) : rootPath
    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      throw new PathJailError('FILE_NOT_FOUND', 'Directory not found')
    }

    const includeHidden = options.includeHidden === true
    const maxEntries = Math.max(1, options.maxEntries ?? FILE_TREE_MAX_ENTRIES)
    const gitignoreRules = loadGitignoreRules(rootPath)
    const nodes: FileNode[] = []
    const queue: Array<{ dirPath: string; into: FileNode[]; node: FileNode | null }> = [{ dirPath: targetDir, into: nodes, node: null }]
    let entries = 0
    let truncated = false

    for (let next = 0; next < queue.length; next++) {
      const folder = queue[next]
      if (entries >= maxEntries) {
        // Not reached: the folder shows without contents, marked as not listed.
        if (folder.node) {
          folder.node.truncated = true
          delete folder.node.children
        }
        truncated = true
        continue
      }

      const listed = this.readFolder(folder.dirPath, rootPath, gitignoreRules, includeHidden)
      for (const { node, fullPath } of listed) {
        if (entries >= maxEntries) {
          if (folder.node) folder.node.truncated = true
          truncated = true
          break
        }
        folder.into.push(node)
        entries += 1
        if (node.type === 'directory') queue.push({ dirPath: fullPath, into: node.children!, node })
      }
    }

    return { nodes, truncated, entries }
  }

  /** One folder's entries, filtered and sorted (folders first, then by name). */
  private readFolder(
    dirPath: string,
    rootPath: string,
    gitignoreRules: GitignoreRule[],
    includeHidden: boolean
  ): Array<{ node: FileNode; fullPath: string }> {
    let dirEntries
    try {
      dirEntries = readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return []
    }

    const listed: Array<{ node: FileNode; fullPath: string }> = []
    for (const entry of dirEntries) {
      // Skip common ignore patterns always, and dotfiles unless asked for
      if (ALWAYS_SKIPPED.has(entry.name) || (!includeHidden && entry.name.startsWith('.'))) continue

      const fullPath = resolve(dirPath, entry.name)
      try {
        if (lstatSync(fullPath).isSymbolicLink()) continue
      } catch {
        continue
      }

      const relativePath = fullPath.slice(rootPath.length + 1).replace(/\\/g, '/')
      const isDir = entry.isDirectory()
      if (isIgnoredByGitignore(relativePath, isDir, gitignoreRules)) continue

      listed.push({
        fullPath,
        node: isDir
          ? { name: entry.name, path: relativePath, type: 'directory', children: [] }
          : { name: entry.name, path: relativePath, type: 'file' }
      })
    }

    return listed.sort((a, b) => {
      if (a.node.type !== b.node.type) return a.node.type === 'directory' ? -1 : 1
      return a.node.name.localeCompare(b.node.name)
    })
  }
}
