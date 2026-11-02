import { describe, it, expect } from 'vitest'
import { parseSearchFilters, searchFilterProperties } from '../searchShared'
import { PathJailError } from '../../../services/pathJail'

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
