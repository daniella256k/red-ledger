import { describe, it, expect } from 'vitest'
import { formatFetchUrlResult } from '../fetchUrlFormat'
import type { FetchUrlResult } from '../../../../src/types'

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
