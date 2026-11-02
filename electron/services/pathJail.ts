import { resolve, normalize, sep, relative } from 'path'
import { lstatSync } from 'fs'

/**
 * Path jail — pure utility for workspace containment and symlink rejection.
 * No Electron imports. Directly testable.
 *
 * Ensures all resolved paths stay inside the workspace root and
 * no path component is a symbolic link.
 */

export class PathJailError extends Error {
  code: string
  details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'PathJailError'
    this.code = code
    this.details = details
  }
}

// Patterns that indicate path traversal or escape attempts
const TRAVERSAL_PATTERNS = [
  /\.\.\//,        // ../
  /\.\.\\/,        // ..\
  /^~\//,          // ~/
  /^~\\/,          // ~\
  /^\//,           // Absolute Unix
  /^[A-Za-z]:[/\\]/, // Absolute Windows (C:\ or C:/)
  /^\\\\/,         // UNC paths (\\server\share)
  /^\/\/\*\//      // Alternative UNC
]

// eslint-disable-next-line no-control-regex -- intentional: rejects control chars in paths
const CONTROL_CHARS = /[\x00-\x1F\x80-\x9F]/
const WINDOWS_INVALID = /[<>:"|?*]/

/**
 * Walk every component of the path from root to target and reject symlinks.
 */
export function assertNoSymlinksInPath(workspaceRoot: string, targetPath: string): void {
  const relativeTarget = relative(workspaceRoot, targetPath)
  const parts = relativeTarget === '' ? [] : relativeTarget.split(sep).filter(Boolean)
  let current = workspaceRoot

  const pathsToCheck = [current]
  for (const part of parts) {
    current = resolve(current, part)
    pathsToCheck.push(current)
  }

  for (const pathToCheck of pathsToCheck) {
    try {
      // lstat, not exists: a link to a missing target "doesn't exist", yet
      // writing through it creates the target outside the workspace.
      const stat = lstatSync(pathToCheck, { throwIfNoEntry: false })
      if (!stat) {
        // For write targets, final components may not exist yet.
        break
      }
      if (stat.isSymbolicLink()) {
        throw new PathJailError('PATH_TRAVERSAL', 'Symbolic links are not allowed')
      }
    } catch (err) {
      if (err instanceof PathJailError) throw err
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        break
      }
      throw new PathJailError(
        'PERMISSION_DENIED',
        'Unable to verify path safety before file access'
      )
    }
  }
}

/**
 * Resolve a relative path within a workspace, rejecting anything unsafe.
 * Returns the normalized absolute path if safe.
 * Throws PathJailError for any traversal, escape, or symlink attempt.
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  // Reject empty/null paths
  if (!relativePath || !workspaceRoot) {
    throw new PathJailError('INVALID_INPUT', 'Path cannot be empty')
  }

  // Reject null bytes
  if (relativePath.includes('\0') || workspaceRoot.includes('\0')) {
    throw new PathJailError('PATH_TRAVERSAL', 'Path contains null bytes')
  }

  // Reject control characters
  if (CONTROL_CHARS.test(relativePath)) {
    throw new PathJailError('PATH_TRAVERSAL', 'Path contains control characters')
  }

  // Reject Windows-invalid characters (on Windows)
  if (process.platform === 'win32' && WINDOWS_INVALID.test(relativePath)) {
    throw new PathJailError('PATH_TRAVERSAL', 'Path contains invalid characters')
  }

  // Reject traversal patterns
  for (const pattern of TRAVERSAL_PATTERNS) {
    if (pattern.test(relativePath)) {
      throw new PathJailError('PATH_TRAVERSAL', `Path contains disallowed pattern: ${relativePath}`)
    }
  }

  // Resolve the full path
  const resolved = resolve(workspaceRoot, relativePath)
  const normalizedResolved = normalize(resolved)
  const normalizedRoot = normalize(workspaceRoot)

  // Containment check (case-insensitive on Windows)
  const compareFn = process.platform === 'win32'
    ? (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase())
    : (a: string, b: string) => a.startsWith(b)

  if (!compareFn(normalizedResolved, normalizedRoot + sep) && normalizedResolved !== normalizedRoot) {
    throw new PathJailError('PATH_TRAVERSAL', 'Path escapes workspace directory')
  }

  // Symlink rejection: every existing path component must be non-symlink.
  assertNoSymlinksInPath(normalizedRoot, normalizedResolved)

  return normalizedResolved
}
