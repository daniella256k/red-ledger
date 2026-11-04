import { resolve } from 'path'
import { Script, createContext } from 'vm'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'fs'
import { resolveWorkspacePath, PathJailError } from './pathJail'
import { loadGitignoreRules, isIgnoredByGitignore, type GitignoreRule } from './gitignore'

/**
 * Workspace content search for grep_files. Pure Node, no Electron, so it can
 * run in a worker thread (see backgroundTasks): a search walks and reads many
 * files, which would otherwise hold up the main process.
 */

/** Never listed or searched, whatever .gitignore says. */
export const ALWAYS_SKIPPED = new Set([
  'node_modules',
  '.git',
  '.DS_Store',
  'Thumbs.db'
])

/** Files larger than this are skipped by searches. */
export const GREP_MAX_FILE_BYTES = 2_000_000

export interface GrepMatch {
  path: string
  line: number
  column: number
  text: string
}

export interface GrepOptions {
  pattern: string
  isRegex?: boolean
  caseSensitive?: boolean
  path?: string
  glob?: string
  maxResults?: number
  contextChars?: number
  /** Override for tests; defaults to GREP_REGEX_BUDGET_MS. */
  regexBudgetMs?: number
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
  return `${start > 0 ? '...' : ''}${line.slice(start, end)}${end < line.length ? '...' : ''}`
}

/** A grep regex as JavaScript source and flags, checked to compile. */
function parseGrepRegex(pattern: string, caseSensitive: boolean): { source: string; flags: string } {
  // JavaScript regexes have no inline flags; accept a leading (?i) anyway
  // since models (and people) reach for it out of habit.
  let source = pattern
  let ignoreCase = !caseSensitive
  if (source.startsWith('(?i)')) {
    source = source.slice(4)
    ignoreCase = true
  }

  const flags = ignoreCase ? 'i' : ''
  try {
    new RegExp(source, flags)
  } catch (err) {
    throw new PathJailError(
      'INVALID_INPUT',
      `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}. `
        + 'Patterns use JavaScript regex syntax, which has no inline flags like (?i) or (?s) mid-pattern; '
        + 'use case_sensitive: false for case-insensitive search.'
    )
  }
  return { source, flags }
}

/** Longest one grep_files call may spend running a regex, across all files. */
export const GREP_REGEX_BUDGET_MS = 5_000

/** Finds up to `limit` matching lines in a file: [line index, column] pairs. */
type LineScanner = (lines: string[], limit: number) => Array<[number, number]>

/**
 * Runs a regex over each file's lines inside a VM context with a time limit,
 * since a pattern like (a+)+$ can backtrack for minutes on one line.
 * Plain-text searches don't need it.
 */
function createRegexScanner(pattern: string, caseSensitive: boolean, budgetMs: number): LineScanner {
  const context = createContext(parseGrepRegex(pattern, caseSensitive))
  new Script(`
    const re = new RegExp(source, flags)
    function scan(lines, limit) {
      const found = []
      for (let i = 0; i < lines.length && found.length < limit; i++) {
        const m = re.exec(lines[i])
        if (m) found.push([i, m.index])
      }
      return found
    }
  `).runInContext(context)
  const run = new Script('scan(lines, limit)')
  const deadline = Date.now() + budgetMs

  return (lines, limit) => {
    context.lines = lines
    context.limit = limit
    try {
      return run.runInContext(context, { timeout: Math.max(1, deadline - Date.now()) }) as Array<[number, number]>
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new PathJailError(
          'TIMEOUT',
          `The regex took longer than ${budgetMs / 1000} s and was stopped. `
            + 'Simplify it: avoid nested quantifiers like (a+)+ or (.*)*, or search for literal text instead.'
        )
      }
      throw err
    } finally {
      context.lines = undefined
    }
  }
}

function createLineScanner(matcher: (line: string) => number): LineScanner {
  return (lines, limit) => {
    const found: Array<[number, number]> = []
    for (let i = 0; i < lines.length && found.length < limit; i++) {
      const column = matcher(lines[i])
      if (column !== -1) found.push([i, column])
    }
    return found
  }
}

export function buildGrepMatcher(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean
): (line: string) => number {
  if (isRegex) {
    const { source, flags } = parseGrepRegex(pattern, caseSensitive)
    const re = new RegExp(source, flags)
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

/** Searches the files of a workspace (or a folder in it) for a pattern. */
export function grepWorkspace(workspaceRoot: string, options: GrepOptions): GrepMatch[] {
  const targetDir = options.path
    ? resolveWorkspacePath(workspaceRoot, options.path)
    : workspaceRoot

  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    throw new PathJailError('FILE_NOT_FOUND', 'Directory not found')
  }

  const caseSensitive = options.caseSensitive !== false
  const scanner = options.isRegex === true
    ? createRegexScanner(options.pattern, caseSensitive, options.regexBudgetMs ?? GREP_REGEX_BUDGET_MS)
    : createLineScanner(buildGrepMatcher(options.pattern, false, caseSensitive))
  const globMatcher = options.glob ? buildGlobMatcher(options.glob) : null
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 200, 1000))
  const contextChars = Math.max(20, Math.min(options.contextChars ?? DEFAULT_GREP_CONTEXT_CHARS, 1000))
  const matches: GrepMatch[] = []

  walkForGrep(targetDir, workspaceRoot, matches, maxResults, scanner, globMatcher, contextChars, loadGitignoreRules(workspaceRoot))
  return matches
}

function walkForGrep(
  dirPath: string,
  rootPath: string,
  matches: GrepMatch[],
  maxResults: number,
  scanner: LineScanner,
  globMatcher: ((relativePath: string) => boolean) | null,
  contextChars: number,
  gitignoreRules: GitignoreRule[]
): void {
  if (matches.length >= maxResults) return

  let entries
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (matches.length >= maxResults) return
    if (entry.name.startsWith('.') || ALWAYS_SKIPPED.has(entry.name)) continue

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
      walkForGrep(fullPath, rootPath, matches, maxResults, scanner, globMatcher, contextChars, gitignoreRules)
      continue
    }

    if (globMatcher && !globMatcher(relativePath)) continue

    grepOneFile(fullPath, relativePath, scanner, matches, maxResults, contextChars)
  }
}

function grepOneFile(
  fullPath: string,
  relativePath: string,
  scanner: LineScanner,
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
  if (stat.size > GREP_MAX_FILE_BYTES) return

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

  for (const [lineIndex, column] of scanner(lines, Math.min(perFileCap, maxResults - matches.length))) {
    matches.push({
      path: relativePath,
      line: lineIndex + 1,
      column: column + 1,
      text: excerptAroundMatch(lines[lineIndex], column, contextChars)
    })
  }
}
