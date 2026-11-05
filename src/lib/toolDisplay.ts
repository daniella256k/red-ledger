import type { FetchUrlResult, SearchRecency, SearchResponse, ToolCall } from '../types'
import { displayDomain, formatFetchUrlResult, formatSearchResponse } from './toolResultText'

/**
 * What the chat shows for a tool call: a one-line description, a short
 * result, burst counts and the details' stats line. Pure, so it can be tested
 * without React. Separators are plain "|" and "-", never dots or dashes.
 */

export type ToolStatus = 'running' | 'ok' | 'failed'

export interface ToolErrorResult {
  error: string
  code?: string
  status?: number
  retryable?: boolean
}

const SEARCH_TOOLS = new Set(['web_search', 'org_search', 'wiki_search'])
/** Matches the main process's estimate, so the numbers agree with the context meter. */
const CHARS_PER_TOKEN = 4

const RECENCY_LABELS: Record<SearchRecency, string> = {
  day: 'past day',
  week: 'past week',
  month: 'past month',
  year: 'past year'
}

const BACKEND_LABELS: Record<SearchResponse['backend'], string> = {
  tavily: 'Tavily',
  serpapi: 'SerpAPI',
  wikipedia: 'Wikipedia'
}

const ERROR_LABELS: Record<string, string> = {
  TIMEOUT: 'timed out',
  USER_DENIED: 'declined',
  LIMIT_REACHED: 'not run',
  PERMISSION_DENIED: 'unavailable',
  NO_SEARCH_KEY: 'no search key',
  BLOCKED_HOST: 'blocked',
  UNSUPPORTED_TYPE: 'unsupported type',
  NOT_FOUND: 'not found'
}

export function toolError(toolCall: ToolCall): ToolErrorResult | null {
  const result = toolCall.result
  if (!result || typeof result !== 'object' || !('error' in result)) return null
  const { error, code, status, retryable } = result as Record<string, unknown>
  return {
    error: typeof error === 'string' ? error : JSON.stringify(error),
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {})
  }
}

export function toolStatus(toolCall: ToolCall): ToolStatus {
  if (toolCall.result === undefined) return 'running'
  return toolError(toolCall) ? 'failed' : 'ok'
}

/** 950, 9.8k, 25k. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(n / 1000)}k`
}

/** Host without "www." plus path, cut to fit a row. */
export function shortUrl(raw: string, maxChars = 60): string {
  let text = raw
  try {
    const url = new URL(raw)
    const path = `${url.pathname}${url.search}`
    text = displayDomain(url.hostname) + (path === '/' ? '' : path)
  } catch {
    // Not a URL: show it as the model sent it.
  }
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Arguments of a tool we have no description for, as "key: value" pairs. */
function argumentsPreview(args: Record<string, unknown>): string {
  const pairs = Object.entries(args).map(([key, value]) => {
    const shown = typeof value === 'string' ? value : JSON.stringify(value)
    return `${key}: ${shown}`
  })
  const text = pairs.join(', ').replace(/\s+/g, ' ')
  return text.length > 100 ? `${text.slice(0, 97)}...` : text
}

/**
 * The call's one-line description: what it acted on, plus its filters or
 * range when it had any (shown in parentheses after it).
 */
export function describeToolCall(toolCall: ToolCall): { subject: string; filters?: string } {
  const args = toolCall.arguments ?? {}

  if (SEARCH_TOOLS.has(toolCall.name)) {
    const domains = Array.isArray(args.domains)
      ? args.domains.filter((d): d is string => typeof d === 'string')
      : typeof args.domains === 'string' ? args.domains.split(',').map((d) => d.trim()).filter(Boolean) : []
    const recency = str(args.recency)?.toLowerCase() as SearchRecency | undefined
    const filters = [
      recency && RECENCY_LABELS[recency] ? RECENCY_LABELS[recency] : undefined,
      str(args.topic)?.toLowerCase() === 'news' ? 'news' : undefined,
      ...domains
    ].filter((part): part is string => !!part)
    return { subject: `"${str(args.query) ?? ''}"`, ...(filters.length ? { filters: filters.join(', ') } : {}) }
  }

  switch (toolCall.name) {
    case 'fetch_url': {
      const start = num(args.start_index)
      return {
        subject: shortUrl(str(args.url) ?? ''),
        ...(start ? { filters: `from char ${formatCount(start)}` } : {})
      }
    }
    case 'read_file': {
      const offset = num(args.offset)
      const limit = num(args.limit)
      const range = offset && limit
        ? `lines ${offset}-${offset + limit - 1}`
        : offset ? `from line ${offset}` : limit ? `first ${limit} lines` : undefined
      return { subject: str(args.path) ?? '', ...(range ? { filters: range } : {}) }
    }
    case 'write_file':
    case 'append_file':
    case 'edit_file':
    case 'write_pdf':
      return { subject: str(args.path) ?? '' }
    case 'list_files':
      return { subject: str(args.path) ?? '.' }
    case 'move_file':
      return { subject: `${str(args.source) ?? ''} -> ${str(args.destination) ?? ''}` }
    case 'grep_files': {
      const path = str(args.path)
      return { subject: `"${str(args.pattern) ?? ''}"`, ...(path ? { filters: `in ${path}` } : {}) }
    }
    default:
      return { subject: argumentsPreview(args) }
  }
}

function countNodes(nodes: unknown): number {
  if (!Array.isArray(nodes)) return 0
  return nodes.reduce((total: number, node) => {
    const children = node && typeof node === 'object' ? (node as { children?: unknown }).children : undefined
    return total + 1 + countNodes(children)
  }, 0)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The short result at the end of a call's line. */
export function summarizeToolResult(toolCall: ToolCall): string {
  const status = toolStatus(toolCall)
  if (status === 'running') return 'running...'

  const error = toolError(toolCall)
  if (error) {
    if (error.status !== undefined) return `HTTP ${error.status}`
    return (error.code && ERROR_LABELS[error.code]) ?? 'failed'
  }

  const result = toolCall.result as Record<string, unknown> | unknown[]

  if (SEARCH_TOOLS.has(toolCall.name)) {
    const results = Array.isArray(result) ? result : (result as Partial<SearchResponse>).results
    const count = Array.isArray(results) ? results.length : 0
    return count === 0 ? 'no results' : plural(count, 'result')
  }

  if (Array.isArray(result)) return toolCall.name === 'list_files' ? plural(countNodes(result), 'item') : 'done'

  switch (toolCall.name) {
    case 'list_files':
      // A listing cut off at its entry limit: { entries, truncated, note }.
      return `${plural(countNodes((result as { entries?: unknown }).entries), 'item')} (more not listed)`
    case 'fetch_url': {
      const content = typeof result.content === 'string' ? result.content : ''
      return `${formatCount(content.length)} chars`
    }
    case 'read_file': {
      const total = num(result.total_lines) ?? 0
      const start = num(result.start_line)
      const end = num(result.end_line)
      return start !== undefined && end !== undefined && (start > 1 || end < total)
        ? `lines ${start}-${end} of ${total}`
        : plural(total, 'line')
    }
    case 'grep_files':
      return plural(num(result.count) ?? 0, 'match')
    case 'write_file':
    case 'write_pdf':
      return 'written'
    case 'append_file':
      return 'appended'
    case 'edit_file':
      return 'edited'
    case 'move_file':
      return 'moved'
    default:
      return 'done'
  }
}

export interface BurstCounts {
  total: number
  ok: number
  failed: number
  running: number
}

export function countToolStatuses(toolCalls: ToolCall[]): BurstCounts {
  const counts: BurstCounts = { total: toolCalls.length, ok: 0, failed: 0, running: 0 }
  for (const toolCall of toolCalls) counts[toolStatus(toolCall)] += 1
  return counts
}

/** "14 calls", "14 calls | 1 failed", "5 calls | 1 running". */
export function burstSummaryText(toolCalls: ToolCall[]): string {
  const { total, failed, running } = countToolStatuses(toolCalls)
  const parts = [plural(total, 'call')]
  if (failed > 0) parts.push(`${failed} failed`)
  if (running > 0) parts.push(`${running} running`)
  return parts.join(' | ')
}

/** The exact text the model was sent for this result, as the main process builds it. */
export function modelTextFor(toolCall: ToolCall): string {
  const result = toolCall.result
  if (result === undefined) return ''
  if (!toolError(toolCall)) {
    try {
      if (toolCall.name === 'fetch_url') return formatFetchUrlResult(result)
      if (SEARCH_TOOLS.has(toolCall.name)) return formatSearchResponse(result)
    } catch {
      // Unexpected shape: the main process falls back to JSON too.
    }
  }
  return JSON.stringify(result) ?? 'null'
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** The details' stats line: id, round, timing, source, error fields and size sent to the model. */
export function toolStatsLine(toolCall: ToolCall): string {
  const parts: string[] = []
  if (toolCall.id) parts.push(toolCall.id)
  if (toolCall.round !== undefined) parts.push(`round ${toolCall.round}`)
  if (toolCall.durationMs !== undefined) parts.push(formatDuration(toolCall.durationMs))

  const error = toolError(toolCall)
  const result = toolCall.result
  if (!error && result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Partial<SearchResponse & FetchUrlResult>
    if (SEARCH_TOOLS.has(toolCall.name) && record.backend) parts.push(BACKEND_LABELS[record.backend] ?? record.backend)
    if (toolCall.name === 'fetch_url') {
      if (record.content_type) parts.push(record.content_type)
      if (record.extraction) parts.push(record.extraction)
      if (record.total_chars !== undefined) {
        parts.push(`chars ${record.start_index ?? 0}-${record.end_index ?? record.total_chars} of ${record.total_chars}`)
      }
    }
  }
  if (error) {
    if (error.code) parts.push(error.code)
    if (error.status !== undefined) parts.push(`HTTP ${error.status}`)
    if (error.retryable !== undefined) parts.push(`retryable: ${error.retryable ? 'yes' : 'no'}`)
  }

  if (result !== undefined) {
    const chars = modelTextFor(toolCall).length
    parts.push(`${chars.toLocaleString('en-US')} chars to model (~${estimateTokens(chars).toLocaleString('en-US')} tokens)`)
  }
  return parts.join(' | ')
}

/**
 * Items in order, with each run of consecutive tool calls merged into one
 * array: a burst the chat shows as a single collapsible block.
 */
export function groupToolRuns<T>(items: T[], toolCallOf: (item: T) => ToolCall | undefined): Array<T | ToolCall[]> {
  const out: Array<T | ToolCall[]> = []
  for (const item of items) {
    const toolCall = toolCallOf(item)
    if (!toolCall) {
      out.push(item)
      continue
    }
    const last = out[out.length - 1]
    if (Array.isArray(last)) last.push(toolCall)
    else out.push([toolCall])
  }
  return out
}
