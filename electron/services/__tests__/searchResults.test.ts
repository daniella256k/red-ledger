import { describe, it, expect } from 'vitest'
import { capSnippet, finishResults, normalizePublished, normalizeSiteHost, toSearchResult } from '../searchResults'

describe('normalizePublished', () => {
  it('reads dates into YYYY-MM-DD', () => {
    expect(normalizePublished('2026-10-20T09:00:00-05:00')).toBe('2026-10-20')
    expect(normalizePublished('Mon, 20 Oct 2025 23:30:00 GMT')).toBe('2025-10-20')
    // A date without a zone is taken as written, whatever this computer's zone is.
    expect(normalizePublished('Oct 20, 2025')).toBe('2025-10-20')
  })

  it('keeps dates it cannot read as given, and drops empty ones', () => {
    expect(normalizePublished('3 days ago')).toBe('3 days ago')
    expect(normalizePublished('  ')).toBeUndefined()
    expect(normalizePublished(42)).toBeUndefined()
  })
})

describe('capSnippet', () => {
  it('collapses whitespace and leaves short text alone', () => {
    expect(capSnippet('  Workers\n\nvoted   yes. ')).toBe('Workers voted yes.')
  })

  it('cuts long text at a word break with an ellipsis', () => {
    expect(capSnippet('one two three four five six', 14)).toBe('one two three…')
  })
})

describe('normalizeSiteHost', () => {
  it('finds the hostname however the site is written', () => {
    expect(normalizeSiteHost('nlrb.gov')).toBe('nlrb.gov')
    expect(normalizeSiteHost('site:NLRB.gov')).toBe('nlrb.gov')
    expect(normalizeSiteHost('https://www.nlrb.gov/news?x=1')).toBe('www.nlrb.gov')
    expect(normalizeSiteHost('  ')).toBeNull()
    expect(normalizeSiteHost(undefined)).toBeNull()
  })
})

describe('toSearchResult and finishResults', () => {
  it('keeps the first copy of each page, skips unusable URLs and stops at the count', () => {
    const results = finishResults([
      toSearchResult({ title: 'A', url: 'https://example.com/a/', snippet: 'first' }),
      toSearchResult({ title: 'A again', url: 'https://example.com/a', snippet: 'second' }),
      toSearchResult({ title: 'Bad', url: 'ftp://example.com/file' }),
      toSearchResult({ title: 'No URL' }),
      toSearchResult({ title: 'B', url: 'https://example.com/b' }),
      toSearchResult({ title: 'C', url: 'https://example.com/c' })
    ], 2)

    expect(results.map((r) => r.title)).toEqual(['A', 'B'])
  })
})
