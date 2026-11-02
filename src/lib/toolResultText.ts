import type { FetchUrlResult, SearchRecency, SearchResponse, SearchResult } from '../types'

/**
 * The text the model reads for a fetch_url or search result. Shared by the
 * main process (which sends it) and the chat's tool calls (which show it as
 * "Sent to model"), so the two never drift apart. Pure: no Node or DOM APIs.
 */

/** "www.nlrb.gov" becomes "nlrb.gov". */
export function displayDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

const EXTRACTION_LABELS: Record<FetchUrlResult['extraction'], string> = {
  article: 'main content',
  page: 'whole page, navigation removed',
  pdf: 'text extracted from a PDF',
  text: 'as sent'
}

/**
 * A fetch_url result as the model reads it: a short header, the content
 * between <page_content> tags (so page text is never mistaken for the
 * conversation), then how to read on. Also reads results saved before 1.8,
 * which had a links array (left out) and no character counts.
 */
export function formatFetchUrlResult(result: unknown): string {
  const page = result as Partial<FetchUrlResult>
  if (typeof page?.url !== 'string' || typeof page.content !== 'string') {
    throw new Error('Not a fetch_url result')
  }

  const header = [`URL: ${page.url}`]
  if (page.title) header.push(`Title: ${page.title}`)
  if (page.site_name) header.push(`Site: ${page.site_name}`)
  if (page.byline) header.push(`By: ${page.byline}`)
  if (page.published) header.push(`Published: ${page.published}`)
  if (typeof page.total_chars === 'number') {
    const label = page.extraction ? EXTRACTION_LABELS[page.extraction] : undefined
    header.push(`Characters ${page.start_index ?? 0}-${page.end_index ?? page.total_chars} of ${page.total_chars}${label ? ` (${label})` : ''}`)
  }

  const parts = [header.join('\n'), `<page_content>\n${page.content || '(no text content)'}\n</page_content>`]
  if (page.note) parts.push(`Note: ${page.note}`)
  if (typeof page.next_start_index === 'number' && typeof page.total_chars === 'number') {
    parts.push(
      `[${page.total_chars - page.next_start_index} more characters. `
      + `Call fetch_url with start_index=${page.next_start_index} to read the next part.]`
    )
  } else if (page.truncated && typeof page.total_chars !== 'number') {
    parts.push('[The content was cut off here.]')
  }
  return parts.join('\n\n')
}

const RECENCY_LABELS: Record<SearchRecency, string> = {
  day: 'past day',
  week: 'past week',
  month: 'past month',
  year: 'past year'
}

const BACKEND_LABELS: Record<SearchResponse['backend'], string> = {
  tavily: 'Tavily',
  serpapi: 'Google via SerpAPI',
  wikipedia: 'Wikipedia'
}

function domainOf(result: Partial<SearchResult>): string {
  if (result.domain) return result.domain
  try {
    return displayDomain(new URL(String(result.url)).hostname)
  } catch {
    return ''
  }
}

/**
 * A search result as the model reads it: what was searched, then a numbered
 * list (title, URL, site and date, snippet) between <search_results> tags, so
 * snippet text is never mistaken for the conversation. Also reads results
 * saved before 1.8, which were a bare array.
 */
export function formatSearchResponse(result: unknown): string {
  const response: Partial<SearchResponse> = Array.isArray(result)
    ? { results: result as SearchResult[] }
    : (result ?? {}) as Partial<SearchResponse>
  if (!Array.isArray(response.results)) throw new Error('Not a search result')

  const filters = [
    response.recency ? RECENCY_LABELS[response.recency] : null,
    response.topic === 'news' ? 'news' : null,
    response.domains?.length ? `sites: ${response.domains.join(', ')}` : null
  ].filter((label): label is string => !!label)
  const scope = filters.length > 0 ? ` (${filters.join(', ')})` : ''
  const searched = typeof response.query === 'string' ? `"${response.query}"${scope}` : `this search${scope}`

  if (response.results.length === 0) {
    const broaden = response.recency ? 'a broader query or a longer time range' : 'a broader query'
    const lines = [`No results for ${searched}. Try ${broaden}.`]
    if (response.note) lines.push(`Note: ${response.note}`)
    return lines.join('\n\n')
  }

  const source = response.backend ? ` from ${BACKEND_LABELS[response.backend]}` : ''
  const items = response.results.map((item, index) => {
    const meta = [domainOf(item), item.published ? `published ${item.published}` : null]
      .filter((part): part is string => !!part)
      .join(' | ')
    return [
      `${index + 1}. ${item.title || domainOf(item) || 'Untitled'}`,
      `   ${item.url}`,
      ...(meta ? [`   ${meta}`] : []),
      ...(item.snippet ? [`   ${String(item.snippet).replace(/\s+/g, ' ').trim()}`] : [])
    ].join('\n')
  })

  const parts = [
    `${response.results.length} result${response.results.length === 1 ? '' : 's'} for ${searched}${source}:`,
    `<search_results>\n${items.join('\n\n')}\n</search_results>`
  ]
  if (response.note) parts.push(`Note: ${response.note}`)
  return parts.join('\n\n')
}
