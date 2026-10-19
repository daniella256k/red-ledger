import { basename, dirname, resolve } from 'path'
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, lstatSync, mkdirSync, copyFileSync, renameSync } from 'fs'
import { resolveWorkspacePath, PathJailError } from './pathJail'
import { loadGitignoreRules, isIgnoredByGitignore, type GitignoreRule } from './gitignore'
import { DocumentExtractionError, extractDocumentText } from './DocumentTextService'
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

export const DEFAULT_GREP_CONTEXT_CHARS = 200

/**
 * The part of a matched line shown in grep results: the whole line when it is
 * short, otherwise a window centered on the match so long prose lines still
 * show the sentence that matched.
 */
export function excerptAroundMatch(line: string, column: number, contextChars = DEFAULT_GREP_CONTEXT_CHARS): string {
  if (line.length <= contextChars * 2) return line

  const start = Math.max(0, column - contextChars)
  const end = Math.min(line.length, column + contextChars)
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

export function buildGrepMatcher(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean
): (line: string) => number {
  if (isRegex) {
    // JavaScript regexes have no inline flags; accept a leading (?i) anyway
    // since models (and people) reach for it out of habit.
    let source = pattern
    let ignoreCase = !caseSensitive
    if (source.startsWith('(?i)')) {
      source = source.slice(4)
      ignoreCase = true
    }

    let re: RegExp
    try {
      re = new RegExp(source, ignoreCase ? 'i' : '')
    } catch (err) {
      throw new PathJailError(
        'INVALID_INPUT',
        `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}. `
          + 'Patterns use JavaScript regex syntax, which has no inline flags like (?i) or (?s) mid-pattern; '
          + 'use case_sensitive: false for case-insensitive search.'
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

  /**
   * A copy fixed to the current folder. A chat's tool calls run against one so
   * switching chats (and so the active workspace) mid-reply can't redirect them.
   */
  snapshot(): WorkspaceService {
    const pinned = new WorkspaceService(this.getSettings)
    pinned.setWorkspacePath(this.workspacePath)
    return pinned
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
        message: 'Overwrite existing file? The previous version will be kept as a .bak file.',
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

    try {
      const documentText = await extractDocumentText(fullPath)
      if (documentText !== null) return documentText
    } catch (err) {
      if (err instanceof DocumentExtractionError) {
        throw new Error(`Could not extract text from ${relativePath}: ${err.message}`, { cause: err })
      }
      throw err
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
      if (fileExists) backupFile(fullPath)
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

    backupFile(fullPath)
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
    if (fileExists) backupFile(fullPath)
    writeFileSync(fullPath, content)
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

    mkdirSync(dirname(toPath), { recursive: true })
    renameSync(fromPath, toPath)
    return { from: fromRelative, to: toDisplay }
  }

  grepFiles(options: {
    pattern: string
    isRegex?: boolean
    caseSensitive?: boolean
    path?: string
    glob?: string
    maxResults?: number
    contextChars?: number
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
    const contextChars = Math.max(20, Math.min(options.contextChars ?? DEFAULT_GREP_CONTEXT_CHARS, 1000))
    const matches: GrepMatch[] = []

    this.walkForGrep(
      targetDir,
      this.workspacePath,
      matches,
      maxResults,
      matcher,
      globMatcher,
      contextChars
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
    contextChars: number,
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
        this.walkForGrep(fullPath, rootPath, matches, maxResults, matcher, globMatcher, contextChars, gitignoreRules)
        continue
      }

      if (globMatcher && !globMatcher(relativePath)) continue

      this.grepOneFile(fullPath, relativePath, matcher, matches, maxResults, contextChars)
    }
  }

  private grepOneFile(
    fullPath: string,
    relativePath: string,
    matcher: (line: string) => number,
    matches: GrepMatch[],
    maxResults: number,
    contextChars: number
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

      matches.push({
        path: relativePath,
        line: lineNum + 1,
        column: column + 1,
        text: excerptAroundMatch(line, column, contextChars)
      })
      perFileCount++
    }
  }

  listFiles(relativePath?: string, options: { includeHidden?: boolean } = {}): FileNode[] {
    if (!this.workspacePath) {
      throw new PathJailError('WORKSPACE_NOT_SET', 'No workspace directory selected')
    }

    const targetDir = relativePath
      ? resolveWorkspacePath(this.workspacePath, relativePath)
      : this.workspacePath

    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      throw new PathJailError('FILE_NOT_FOUND', 'Directory not found')
    }

    return this.listDirectory(targetDir, this.workspacePath, undefined, options.includeHidden === true)
  }

  // ─── Directory Listing ────────────────────────────────────────────────────

  private listDirectory(
    dirPath: string,
    rootPath: string,
    gitignoreRules?: GitignoreRule[],
    includeHidden = false
  ): FileNode[] {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    const nodes: FileNode[] = []

    // Load gitignore rules at the top-level call
    if (gitignoreRules === undefined) {
      gitignoreRules = loadGitignoreRules(rootPath)
    }

    for (const entry of entries) {
      // Skip common ignore patterns always, and dotfiles unless asked for
      if (SKIP_PATTERNS.has(entry.name) || (!includeHidden && entry.name.startsWith('.'))) {
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
          children: this.listDirectory(fullPath, rootPath, gitignoreRules, includeHidden)
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

/** Keep the previous version of a file as `<name>.bak` (replacing any older backup) before it is overwritten. */
function backupFile(fullPath: string): void {
  copyFileSync(fullPath, `${fullPath}.bak`)
}
