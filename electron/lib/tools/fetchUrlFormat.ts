import type { FetchUrlResult } from '../../../src/types'

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
