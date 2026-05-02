import { dirname, resolve } from 'path'
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, lstatSync, mkdirSync } from 'fs'
import { resolveWorkspacePath, PathJailError } from './pathJail'
import { loadGitignoreRules, isIgnoredByGitignore, type GitignoreRule } from './gitignore'
import { extractPdfTextWithFallback } from './PdfAttachmentService'
import type { FileNode, Settings } from '../../src/types'

// Re-export so IPC handlers can use the error type
export { PathJailError } from './pathJail'

const SKIP_PATTERNS = new Set([
  'node_modules',
  '.git',
  '.DS_Store',
  'Thumbs.db'
])

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

  constructor(getSettings: () => Settings) {
    this.getSettings = getSettings
  }

  getWorkspacePath(): string | null {
    return this.workspacePath
  }

  setWorkspacePath(path: string | null): void {
    this.workspacePath = path
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
        message: 'Overwrite existing file? This cannot be undone.',
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

  async readFile(dialog: DialogAdapter | null, relativePath: string): Promise<string> {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }

    const fullPath = resolveWorkspacePath(this.workspacePath, relativePath)

    // Strict mode check
    if (dialog) {
      const settings = this.getSettings()
      if (settings.strictMode) {
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
    }

    if (!existsSync(fullPath)) {
      throw new PathJailError('FILE_NOT_FOUND', `File not found: ${relativePath}`)
    }

    if (relativePath.toLowerCase().endsWith('.pdf')) {
      return extractPdfTextWithFallback(fullPath)
    }

    return readFileSync(fullPath, 'utf-8')
  }

  async writeFile(
    dialog: DialogAdapter | null,
    relativePath: string,
    content: string,
    append: boolean = false
  ): Promise<void> {
    const { fullPath, fileExists } = this.resolveWriteTarget(relativePath)
    await this.confirmWriteAllowed(dialog, relativePath, fullPath, fileExists, append)

    mkdirSync(dirname(fullPath), { recursive: true })

    if (append) {
      appendFileSync(fullPath, content, 'utf-8')
    } else {
      writeFileSync(fullPath, content, 'utf-8')
    }
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

    writeFileSync(fullPath, content, 'utf-8')
  }

  async writeBinaryFile(
    dialog: DialogAdapter | null,
    relativePath: string,
    content: Buffer
  ): Promise<void> {
    const { fullPath, fileExists } = this.resolveWriteTarget(relativePath)
    await this.confirmWriteAllowed(dialog, relativePath, fullPath, fileExists, false)

    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
  }

  listFiles(relativePath?: string): FileNode[] {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }

    const targetDir = relativePath
      ? resolveWorkspacePath(this.workspacePath, relativePath)
      : this.workspacePath

    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      throw new PathJailError('FILE_NOT_FOUND', 'Directory not found')
    }

    return this.listDirectory(targetDir, this.workspacePath)
  }

  // ─── Directory Listing ────────────────────────────────────────────────────

  private listDirectory(
    dirPath: string,
    rootPath: string,
    gitignoreRules?: GitignoreRule[]
  ): FileNode[] {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    const nodes: FileNode[] = []

    // Load gitignore rules at the top-level call
    if (gitignoreRules === undefined) {
      gitignoreRules = loadGitignoreRules(rootPath)
    }

    for (const entry of entries) {
      // Skip dotfiles and common ignore patterns
      if (entry.name.startsWith('.') || SKIP_PATTERNS.has(entry.name)) {
        continue
      }

      const fullPath = resolve(dirPath, entry.name)

      // Skip symlinks
      try {
        const stat = lstatSync(fullPath)
        if (stat.isSymbolicLink()) continue
      } catch {
        continue
      }

      const relativePath = fullPath
        .slice(rootPath.length + 1)
        .replace(/\\/g, '/')

      const isDir = entry.isDirectory()

      // Check gitignore rules
      if (isIgnoredByGitignore(relativePath, isDir, gitignoreRules)) {
        continue
      }

      if (isDir) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'directory',
          children: this.listDirectory(fullPath, rootPath, gitignoreRules)
        })
      } else {
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'file'
        })
      }
    }

    // Sort: directories first, then alphabetical
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }
}
