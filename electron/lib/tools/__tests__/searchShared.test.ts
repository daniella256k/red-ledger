import { describe, it, expect } from 'vitest'
import { formatSearchResponse, parseSearchFilters, searchFilterProperties } from '../searchShared'
import { PathJailError } from '../../../services/pathJail'
import type { SearchResponse } from '../../../../src/types'

const RESPONSE: SearchResponse = {
  query: 'nurses strike',
  backend: 'tavily',
  recency: 'week',
  topic: 'news',
  results: [
    {
      title: 'Nurses walk out',
      url: 'https://apnews.com/article/nurses',
      domain: 'apnews.com',
      published: '2026-10-28',
      snippet: 'Thousands of nurses walked off the job on Tuesday.'
    },
    { title: 'Hall meeting', url: 'https://local12.example.org/', domain: 'local12.example.org', snippet: '' }
  ]
}

describe('formatSearchResponse', () => {
  it('lists what was searched, then each result between search_results tags', () => {
    expect(formatSearchResponse(RESPONSE)).toBe([
      '2 results for "nurses strike" (past week, news) from Tavily:',
      '',
      '<search_results>',
      '1. Nurses walk out',
      '   https://apnews.com/article/nurses',
      '   apnews.com · published 2026-10-28',
      '   Thousands of nurses walked off the job on Tuesday.',
      '',
      '2. Hall meeting',
      '   https://local12.example.org/',
      '   local12.example.org',
      '</search_results>'
    ].join('\n'))
  })

  it('names the sites searched and passes notes through', () => {
    const text = formatSearchResponse({
      ...RESPONSE,
      backend: 'serpapi',
      recency: undefined,
      topic: undefined,
      domains: ['nlrb.gov', 'bls.gov'],
      note: 'Tavily failed (timeout); these results are from SerpAPI.'
    })

    expect(text.split('\n')[0]).toBe('2 results for "nurses strike" (sites: nlrb.gov, bls.gov) from Google via SerpAPI:')
    expect(text.endsWith('Note: Tavily failed (timeout); these results are from SerpAPI.')).toBe(true)
  })

  it('suggests broadening a search with no results', () => {
    expect(formatSearchResponse({ ...RESPONSE, results: [] })).toBe(
      'No results for "nurses strike" (past week, news). Try a broader query or a longer time range.'
    )
    expect(formatSearchResponse({ query: 'x', backend: 'wikipedia', results: [] })).toBe(
      'No results for "x". Try a broader query.'
    )
  })

  it('reads results saved before 1.8, which were a bare array without domains', () => {
    expect(formatSearchResponse([
      { title: 'Old', url: 'https://www.example.com/old', snippet: 'Old\nsnippet' }
    ])).toBe([
      '1 result for this search:',
      '',
      '<search_results>',
      '1. Old',
      '   https://www.example.com/old',
      '   example.com',
      '   Old snippet',
      '</search_results>'
    ].join('\n'))
  })

  it('throws on anything else, so the caller falls back to JSON', () => {
    expect(() => formatSearchResponse({ content: 'page' })).toThrow()
    expect(() => formatSearchResponse(null)).toThrow()
  })
})

describe('parseSearchFilters', () => {
  it('reads recency, topic and domains, normalizing sites', () => {
    expect(parseSearchFilters(
      { recency: 'Week', topic: 'news', domains: ['https://www.NLRB.gov/news', 'site:bls.gov', 'nlrb.gov'] },
      'web_search',
      { domains: true }
    )).toEqual({ recency: 'week', topic: 'news', domains: ['nlrb.gov', 'bls.gov'] })
  })

  it('accepts domains sent as one comma-separated string', () => {
    expect(parseSearchFilters({ domains: 'apnews.com, reuters.com' }, 'web_search', { domains: true }))
      .toEqual({ domains: ['apnews.com', 'reuters.com'] })
  })

  it('leaves out filters that are absent or empty, and domains where the tool takes none', () => {
    expect(parseSearchFilters({ recency: '', domains: [] }, 'web_search', { domains: true })).toEqual({})
    expect(parseSearchFilters({ domains: ['nlrb.gov'] }, 'org_search', { domains: false })).toEqual({})
  })

  it('rejects values the model can correct', () => {
    expect(() => parseSearchFilters({ recency: 'hour' }, 'web_search', { domains: true }))
      .toThrow('web_search "recency" must be one of: day, week, month, year')
    expect(() => parseSearchFilters({ domains: ['not a site'] }, 'web_search', { domains: true }))
      .toThrow(PathJailError)
    expect(() => parseSearchFilters({ domains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'] }, 'web_search', { domains: true }))
      .toThrow('takes at most 5 items')
    expect(() => parseSearchFilters({ domains: [42] }, 'web_search', { domains: true }))
      .toThrow('must be a list of strings')
  })

  it('declares domains in the schema only for tools that take them', () => {
    expect(Object.keys(searchFilterProperties({ domains: true }))).toEqual(['recency', 'topic', 'domains'])
    expect(Object.keys(searchFilterProperties({ domains: false }))).toEqual(['recency', 'topic'])
  })
})
