import type { ErrorCode } from '@/types'

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  PATH_TRAVERSAL: 'Access denied: path is outside workspace',
  FILE_NOT_FOUND: 'File not found',
  PERMISSION_DENIED: 'Permission denied',
  WORKSPACE_NOT_SET: 'No workspace folder selected. Open one in Settings.',
  API_ERROR: 'The AI provider returned an error',
  NETWORK_ERROR: 'Network error — check your connection',
  INVALID_INPUT: 'Invalid input',
  DATABASE_ERROR: 'Database error',
  USER_DENIED: 'Operation cancelled by user',
  MCP_ERROR: 'A connected tool server returned an error',
  UNKNOWN: 'An unexpected error occurred'
}

/**
 * Format any error shape into a user-friendly string.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    // Check for RedLedgerError shape (code property)
    const code = (err as Error & { code?: string }).code as ErrorCode | undefined
    if (code && code in ERROR_MESSAGES) {
      return ERROR_MESSAGES[code]
    }
    return err.message
  }

  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.code === 'string' && obj.code in ERROR_MESSAGES) {
      return ERROR_MESSAGES[obj.code as ErrorCode]
    }
  }

  return 'An unexpected error occurred'
}
