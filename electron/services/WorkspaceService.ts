import { dirname, resolve } from 'path'
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, lstatSync, mkdirSync, renameSync } from 'fs'
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

export interface GrepMatch {
  path: string
  line: number
  column: number
  text: string
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildGrepMatcher(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean
): (line: string) => number {
  if (isRegex) {
    let re: RegExp
    try {
      re = new RegExp(pattern, caseSensitive ? '' : 'i')
    } catch (err) {
      throw new PathJailError(
        'INVALID_INPUT',
        `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return (line) => {
      const m = re.exec(line)
      return m ? m.index : -1
    }
  }

  if (caseSensitive) {
    return (line) => line.indexOf(pattern)
  }

  const needle = pattern.toLowerCase()
  return (line) => line.toLowerCase().indexOf(needle)
}

export function buildGlobMatcher(glob: string): (relativePath: string) => boolean {
  const trimmed = glob.trim()
  if (!trimmed) return () => true

  const isPathAware = trimmed.includes('/')

  let compiled = ''
  let i = 0
  while (i < trimmed.length) {
    const ch = trimmed[i]
    const next = trimmed[i + 1]
    const after = trimmed[i + 2]

    if (ch === '*' && next === '*' && after === '/') {
      // **/ — zero or more directory segments (matches "" or "a/" or "a/b/")
      compiled += '(?:.*/)?'
      i += 3
    } else if (ch === '*' && next === '*') {
      // ** — match across directories
      compiled += '.*'
      i += 2
    } else if (ch === '*') {
      compiled += '[^/]*'
      i += 1
    } else if (ch === '?') {
      compiled += '[^/]'
      i += 1
    } else {
      compiled += escapeRegex(ch)
      i += 1
    }
  }

  const pattern = isPathAware ? `^${compiled}$` : `(?:^|/)${compiled}$`
  const re = new RegExp(pattern)
  return (relativePath) => re.test(relativePath)
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

  async moveFile(
    dialog: DialogAdapter | null,
    fromPath: string,
    toPath: string
  ): Promise<void> {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }

    const fromFull = resolveWorkspacePath(this.workspacePath, fromPath)
    const toFull = resolveWorkspacePath(this.workspacePath, toPath)

    if (!existsSync(fromFull)) {
      throw new PathJailError('FILE_NOT_FOUND', `Source file not found: ${fromPath}`)
    }

    if (fromFull === toFull) {
      throw new PathJailError('INVALID_INPUT', 'Source and destination are the same')
    }

    const destExists = existsSync(toFull)

    if (dialog) {
      const settings = this.getSettings()
      if (destExists) {
        const confirmed = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Overwrite'],
          defaultId: 0,
          title: 'Overwrite File',
          message: `Overwrite existing file at: ${toPath}? This cannot be undone.`,
          detail: toFull
        })
        if (confirmed.response === 0) {
          throw new PathJailError('USER_DENIED', 'User cancelled file overwrite')
        }
      } else if (settings.strictMode) {
        const confirmed = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Deny', 'Allow'],
          defaultId: 0,
          title: 'File Move Request',
          message: `The assistant wants to move: ${fromPath} → ${toPath}`,
          detail: 'Do you want to allow this file move?'
        })
        if (confirmed.response === 0) {
          throw new PathJailError('USER_DENIED', 'User denied file move')
        }
      }
    }

    mkdirSync(dirname(toFull), { recursive: true })
    renameSync(fromFull, toFull)
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

  grepFiles(options: {
    pattern: string
    isRegex?: boolean
    caseSensitive?: boolean
    path?: string
    glob?: string
    maxResults?: number
  }): GrepMatch[] {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }

    const targetDir = options.path
      ? resolveWorkspacePath(this.workspacePath, options.path)
      : this.workspacePath

    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      throw new PathJailError('FILE_NOT_FOUND', 'Directory not found')
    }

    const matcher = buildGrepMatcher(options.pattern, options.isRegex === true, options.caseSensitive !== false)
    const globMatcher = options.glob ? buildGlobMatcher(options.glob) : null
    const maxResults = Math.max(1, Math.min(options.maxResults ?? 200, 1000))
    const matches: GrepMatch[] = []

    this.walkForGrep(
      targetDir,
      this.workspacePath,
      matches,
      maxResults,
      matcher,
      globMatcher
    )

    return matches
  }

  private walkForGrep(
    dirPath: string,
    rootPath: string,
    matches: GrepMatch[],
    maxResults: number,
    matcher: (line: string) => number,
    globMatcher: ((relativePath: string) => boolean) | null,
    gitignoreRules?: GitignoreRule[]
  ): void {
    if (matches.length >= maxResults) return

    if (gitignoreRules === undefined) {
      gitignoreRules = loadGitignoreRules(rootPath)
    }

    let entries
    try {
      entries = readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) return
      if (entry.name.startsWith('.') || SKIP_PATTERNS.has(entry.name)) continue

      const fullPath = resolve(dirPath, entry.name)

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

      if (isIgnoredByGitignore(relativePath, isDir, gitignoreRules)) continue

      if (isDir) {
        this.walkForGrep(fullPath, rootPath, matches, maxResults, matcher, globMatcher, gitignoreRules)
        continue
      }

      if (globMatcher && !globMatcher(relativePath)) continue

      this.grepOneFile(fullPath, relativePath, matcher, matches, maxResults)
    }
  }

  private grepOneFile(
    fullPath: string,
    relativePath: string,
    matcher: (line: string) => number,
    matches: GrepMatch[],
    maxResults: number
  ): void {
    let stat
    try {
      stat = statSync(fullPath)
    } catch {
      return
    }
    if (stat.size > 2_000_000) return

    let raw: Buffer
    try {
      raw = readFileSync(fullPath)
    } catch {
      return
    }

    const probeLength = Math.min(raw.length, 4096)
    for (let i = 0; i < probeLength; i++) {
      if (raw[i] === 0) return
    }

    const text = raw.toString('utf-8')
    const lines = text.split(/\r?\n/)
    const perFileCap = 30
    let perFileCount = 0

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      if (matches.length >= maxResults) return
      if (perFileCount >= perFileCap) return

      const line = lines[lineNum]
      const column = matcher(line)
      if (column === -1) continue

      const display = line.length > 400 ? line.slice(0, 400) + '…' : line
      matches.push({
        path: relativePath,
        line: lineNum + 1,
        column: column + 1,
        text: display
      })
      perFileCount++
    }
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
