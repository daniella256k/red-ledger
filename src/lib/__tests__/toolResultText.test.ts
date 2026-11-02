import { describe, it, expect } from 'vitest'
import { formatFetchUrlResult, formatSearchResponse } from '../toolResultText'
import type { FetchUrlResult, SearchResponse } from '../../types'

const PART: FetchUrlResult = {
  url: 'https://news.example.org/story',
  title: 'Union Wins Vote',
  site_name: 'Daily News',
  published: '2026-10-20',
  content_type: 'text/html',
  extraction: 'article',
  content: '## What comes next\n\nBargaining starts in May.',
  start_index: 0,
  end_index: 10_000,
  total_chars: 24_500,
  truncated: true,
  next_start_index: 10_000
}

describe('formatFetchUrlResult', () => {
  it('puts a short header first, the content in page_content tags, then how to read on', () => {
    expect(formatFetchUrlResult(PART)).toBe([
      'URL: https://news.example.org/story',
      'Title: Union Wins Vote',
      'Site: Daily News',
      'Published: 2026-10-20',
      'Characters 0-10000 of 24500 (main content)',
      '',
      '<page_content>',
      '## What comes next\n\nBargaining starts in May.',
      '</page_content>',
      '',
      '[14500 more characters. Call fetch_url with start_index=10000 to read the next part.]'
    ].join('\n'))
  })

  it('has no read-on line for the last part, and passes notes through', () => {
    const text = formatFetchUrlResult({
      ...PART,
      content: '',
      start_index: 30_000,
      end_index: 30_000,
      truncated: false,
      next_start_index: undefined,
      note: 'start_index 30000 is past the end of the document (24500 characters).'
    })

    expect(text).toContain('<page_content>\n(no text content)\n</page_content>')
    expect(text).toContain('Note: start_index 30000 is past the end')
    expect(text).not.toContain('Call fetch_url')
  })

  it('reads results saved before 1.8 and leaves out their links array', () => {
    const text = formatFetchUrlResult({
      url: 'https://old.example.org/',
      title: 'Old Page',
      content: 'Old text (https://old.example.org/a)',
      links: [{ text: 'A', url: 'https://old.example.org/a', isInternal: true }],
      truncated: true,
      contentType: 'text/html'
    })

    expect(text).toBe([
      'URL: https://old.example.org/',
      'Title: Old Page',
      '',
      '<page_content>',
      'Old text (https://old.example.org/a)',
      '</page_content>',
      '',
      '[The content was cut off here.]'
    ].join('\n'))
  })

  it('throws on anything else, so the caller falls back to JSON', () => {
    expect(() => formatFetchUrlResult({ results: [] })).toThrow()
    expect(() => formatFetchUrlResult(null)).toThrow()
  })
})

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
      '   apnews.com | published 2026-10-28',
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

