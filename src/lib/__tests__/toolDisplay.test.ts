import { describe, it, expect } from 'vitest'
import {
  burstSummaryText,
  countToolStatuses,
  describeToolCall,
  formatCount,
  groupToolRuns,
  modelTextFor,
  shortUrl,
  summarizeToolResult,
  toolStatsLine,
  toolStatus
} from '../toolDisplay'
import type { ToolCall } from '../../types'

const search: ToolCall = {
  id: 'call_1',
  name: 'web_search',
  arguments: { query: 'Local 12 organizing', recency: 'month', topic: 'news', domains: ['reddit.com'] },
  result: {
    query: 'Local 12 organizing',
    backend: 'tavily',
    results: [{ title: 'Vote set', url: 'https://labornotes.org/a', domain: 'labornotes.org', snippet: 'x' }]
  },
  round: 2,
  durationMs: 640
}

const fetchCall: ToolCall = {
  id: 'call_2',
  name: 'fetch_url',
  arguments: { url: 'https://www.labornotes.org/2026/10/local-12-wins' },
  result: {
    url: 'https://www.labornotes.org/2026/10/local-12-wins',
    title: 'Local 12 Wins',
    content_type: 'text/html',
    extraction: 'article',
    content: 'a'.repeat(9_762),
    start_index: 0,
    end_index: 9_762,
    total_chars: 24_000,
    truncated: true,
    next_start_index: 9_762
  }
}

const refused: ToolCall = {
  id: 'call_3',
  name: 'fetch_url',
  arguments: { url: 'https://apnews.com/article/x' },
  result: { error: 'apnews.com returned HTTP 403: refused.', code: 'HTTP_ERROR', status: 403, retryable: false },
  round: 2,
  durationMs: 1_250
}

const running: ToolCall = { id: 'call_4', name: 'wiki_search', arguments: { query: 'Taft-Hartley Act' } }

describe('tool call lines', () => {
  it('describes searches by query, with filters kept apart', () => {
    expect(describeToolCall(search)).toEqual({ subject: '"Local 12 organizing"', filters: 'past month, news, reddit.com' })
    expect(describeToolCall(running)).toEqual({ subject: '"Taft-Hartley Act"' })
  })

  it('describes fetches and file tools by what they acted on', () => {
    expect(describeToolCall(fetchCall)).toEqual({ subject: 'labornotes.org/2026/10/local-12-wins' })
    expect(describeToolCall({ ...fetchCall, arguments: { url: 'https://x.org/a', start_index: 9762 } }))
      .toEqual({ subject: 'x.org/a', filters: 'from char 9.8k' })
    expect(describeToolCall({ id: 'r', name: 'read_file', arguments: { path: 'notes.md', offset: 100, limit: 50 } }))
      .toEqual({ subject: 'notes.md', filters: 'lines 100-149' })
    expect(describeToolCall({ id: 'm', name: 'move_file', arguments: { source: 'a.md', destination: 'b/a.md' } }))
      .toEqual({ subject: 'a.md -> b/a.md' })
    expect(describeToolCall({ id: 'x', name: 'crm__lookup', arguments: { name: 'Ana', limit: 3 } }))
      .toEqual({ subject: 'name: Ana, limit: 3' })
  })

  it('sums up results briefly', () => {
    expect(summarizeToolResult(search)).toBe('1 result')
    expect(summarizeToolResult(fetchCall)).toBe('9.8k chars')
    expect(summarizeToolResult(refused)).toBe('HTTP 403')
    expect(summarizeToolResult(running)).toBe('running...')
    expect(summarizeToolResult({ id: 'd', name: 'read_file', arguments: {}, result: { error: 'no', code: 'USER_DENIED' } })).toBe('declined')
    expect(summarizeToolResult({ id: 'f', name: 'read_file', arguments: {}, result: { content: '', total_lines: 5400, truncated: true, start_line: 1, end_line: 2000 } }))
      .toBe('lines 1-2000 of 5400')
    expect(summarizeToolResult({ id: 'g', name: 'read_file', arguments: {}, result: { content: '', total_lines: 12, truncated: false } })).toBe('12 lines')
    expect(summarizeToolResult({ id: 'l', name: 'list_files', arguments: {}, result: [{ name: 'a', children: [{ name: 'b' }] }] })).toBe('2 items')
    expect(summarizeToolResult({ id: 'w', name: 'web_search', arguments: {}, result: [] })).toBe('no results')
  })

  it('never uses dot or dash separators', () => {
    const text = [search, fetchCall, refused, running]
      .flatMap((tc) => [JSON.stringify(describeToolCall(tc)), summarizeToolResult(tc), toolStatsLine(tc)])
      .join('\n') + burstSummaryText([search, refused, running])
    expect(text).not.toMatch(/[·•–—…]/)
  })
})

describe('bursts', () => {
  it('counts calls, and mentions failures only when something failed', () => {
    expect(burstSummaryText([search, fetchCall])).toBe('2 calls')
    expect(burstSummaryText([search, fetchCall, refused])).toBe('3 calls | 1 failed')
    expect(burstSummaryText([search, running])).toBe('2 calls | 1 running')
    expect(countToolStatuses([search, refused, running])).toEqual({ total: 3, ok: 1, failed: 1, running: 1 })
    expect(toolStatus(running)).toBe('running')
  })

  it('merges consecutive tool calls and keeps text between them', () => {
    const items = [
      { kind: 'tool', toolCall: search },
      { kind: 'tool', toolCall: fetchCall },
      { kind: 'text', text: 'Now the NLRB site.' },
      { kind: 'tool', toolCall: refused }
    ] as const
    const grouped = groupToolRuns([...items], (item) => (item.kind === 'tool' ? item.toolCall : undefined))

    expect(grouped).toEqual([[search, fetchCall], items[2], [refused]])
  })
})

describe('details', () => {
  it('shows the exact text sent to the model, and JSON for errors and other tools', () => {
    expect(modelTextFor(search)).toContain('<search_results>')
    expect(modelTextFor(fetchCall)).toContain('<page_content>')
    expect(modelTextFor(refused)).toBe(JSON.stringify(refused.result))
    expect(modelTextFor(running)).toBe('')
  })

  it('puts power-user stats on one line separated by bars', () => {
    expect(toolStatsLine(search)).toMatch(/^call_1 \| round 2 \| 640 ms \| Tavily \| [\d,]+ chars to model \(~[\d,]+ tokens\)$/)
    expect(toolStatsLine(fetchCall)).toContain('text/html | article | chars 0-9762 of 24000')
    expect(toolStatsLine(refused)).toContain('round 2 | 1.3 s | HTTP_ERROR | HTTP 403 | retryable: no')
    expect(toolStatsLine(running)).toBe('call_4')
  })

  it('formats counts and URLs compactly', () => {
    expect(formatCount(950)).toBe('950')
    expect(formatCount(9_762)).toBe('9.8k')
    expect(formatCount(24_500)).toBe('25k')
    expect(shortUrl('https://www.nlrb.gov/')).toBe('nlrb.gov')
    expect(shortUrl(`https://example.com/${'a'.repeat(80)}`)).toHaveLength(60)
    expect(shortUrl('not a url')).toBe('not a url')
  })
})
