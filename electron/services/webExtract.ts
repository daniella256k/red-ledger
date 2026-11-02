import { parseHTML } from 'linkedom'
import { Readability, isProbablyReaderable } from '@mozilla/readability'
import TurndownService from 'turndown'

/**
 * Turns a fetched HTML page into what a model reads best: the main content as
 * Markdown, with links as [text](absolute url), plus the page's metadata.
 * Pure (no network, no Electron) so it can be tested on fixtures.
 */

export interface ExtractedPage {
  title: string
  site_name?: string
  byline?: string
  published?: string
  markdown: string
  /** "article": the main content was found; "page": the whole page with its chrome removed. */
  extraction: 'article' | 'page'
}

/** Readability results shorter than this are usually a wrong guess (a teaser, a caption). */
const MIN_ARTICLE_CHARS = 250
/** Below this, stripping navigation removed the page itself (e.g. a home page that is all links). */
const MIN_PAGE_CHARS = 200

/** Never text the model can use. Images are dropped too: it can't see them from here. */
const NEVER_CONTENT_TAGS = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
  'link', 'meta', 'img', 'picture', 'video', 'audio', 'source'
] as const
const NEVER_CONTENT_SELECTOR = NEVER_CONTENT_TAGS.join(', ')
const PAGE_CHROME_SELECTOR = [
  'nav', 'header', 'footer', 'aside', 'form', 'dialog', 'button',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
  '[aria-hidden="true"]', '[hidden]'
].join(', ')

type Doc = Document
type El = Element

function parse(html: string): Doc {
  return parseHTML(html).document as unknown as Doc
}

function clean(text: string | null | undefined): string | undefined {
  const value = (text ?? '').replace(/\s+/g, ' ').trim()
  return value || undefined
}

function metaContent(doc: Doc, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const value = clean(doc.querySelector(selector)?.getAttribute('content'))
    if (value) return value
  }
  return undefined
}

function readMetadata(doc: Doc): Omit<ExtractedPage, 'markdown' | 'extraction'> {
  return {
    title: metaContent(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]'])
      ?? clean(doc.querySelector('title')?.textContent)
      ?? '',
    site_name: metaContent(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]']),
    byline: metaContent(doc, ['meta[name="author"]', 'meta[property="article:author"]']),
    published: metaContent(doc, [
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[name="dc.date"]',
      'meta[name="DC.date.issued"]',
      'meta[itemprop="datePublished"]'
    ]) ?? clean(doc.querySelector('time[datetime]')?.getAttribute('datetime'))
  }
}

/**
 * Makes every link absolute (http/https/mailto/tel) so the Markdown can be
 * followed; links that go nowhere useful (fragments, javascript:) lose their href.
 */
function absolutizeLinks(doc: Doc, baseUrl: string): void {
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const href = (anchor.getAttribute('href') ?? '').trim()
    let resolved: URL | null = null
    if (href && !href.startsWith('#')) {
      try {
        resolved = new URL(href, baseUrl)
      } catch {
        resolved = null
      }
    }

    if (resolved && (resolved.protocol === 'http:' || resolved.protocol === 'https:')) {
      resolved.hash = ''
      anchor.setAttribute('href', resolved.toString())
    } else if (resolved && (resolved.protocol === 'mailto:' || resolved.protocol === 'tel:')) {
      anchor.setAttribute('href', resolved.toString())
    } else {
      anchor.removeAttribute('href')
    }
  }
}

function removeAll(root: Doc | El, selector: string): void {
  for (const node of [...root.querySelectorAll(selector)]) node.remove()
}

function textLength(node: El | null | undefined): number {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim().length
}

/** Not a layout table: has no table inside it and isn't inside one. */
function isDataTable(table: El | null): boolean {
  if (!table) return false
  return !table.querySelector('table') && !table.parentElement?.closest('table')
}

function closestTable(node: TurndownService.Node): El | null {
  return (node as unknown as El).closest('table')
}

function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    hr: '---'
  })
  // The model reads this text; escaping "1." or "*" only adds noise.
  turndown.escape = (text: string) => text
  turndown.remove((node) => (NEVER_CONTENT_TAGS as readonly string[]).includes(node.nodeName.toLowerCase()))

  turndown.addRule('dropLinklessAnchors', {
    filter: (node) => node.nodeName === 'A' && !node.getAttribute('href'),
    replacement: (content) => content
  })
  turndown.addRule('dropEmptyLinks', {
    filter: (node) => node.nodeName === 'A' && !!node.getAttribute('href') && !(node.textContent ?? '').trim(),
    replacement: () => ''
  })

  // Data tables as Markdown tables, which keep figures lined up with their headers.
  turndown.addRule('tableSection', {
    filter: (node) => ['THEAD', 'TBODY', 'TFOOT'].includes(node.nodeName) && isDataTable(closestTable(node)),
    replacement: (content) => content
  })
  turndown.addRule('tableCell', {
    filter: (node) => (node.nodeName === 'TH' || node.nodeName === 'TD') && isDataTable(closestTable(node)),
    replacement: (content) => ` ${content.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim()} |`
  })
  turndown.addRule('tableRow', {
    filter: (node) => node.nodeName === 'TR' && isDataTable(closestTable(node)),
    replacement: (content, node) => {
      const row = node as unknown as El
      const table = closestTable(node)
      const isFirst = table?.querySelector('tr') === row
      const cells = Array.from(row.childNodes).filter((child) => child.nodeName === 'TH' || child.nodeName === 'TD').length
      const separator = isFirst && cells > 0 ? `\n|${' --- |'.repeat(cells)}` : ''
      return `\n|${content}${separator}`
    }
  })
  turndown.addRule('table', {
    filter: (node) => node.nodeName === 'TABLE' && isDataTable(node as unknown as El),
    replacement: (content) => `\n\n${content.replace(/\n{2,}/g, '\n').trim()}\n\n`
  })
  turndown.addRule('caption', {
    filter: 'caption',
    replacement: (content) => `\n\n${content.trim()}\n\n`
  })

  return turndown
}

function toMarkdown(html: string): string {
  return createTurndown()
    .turndown(html)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The main content if the page reads as an article (the check browsers use to
 * offer reader view), or null. Hub and listing pages fail it, and go whole
 * instead, so their links aren't cut as clutter.
 */
function extractArticle(html: string, baseUrl: string): { html: string; meta: Partial<ExtractedPage> } | null {
  // Scripts stay in: Readability reads publish dates and bylines from JSON-LD, then drops them.
  const doc = parse(html)
  absolutizeLinks(doc, baseUrl)

  let article: ReturnType<Readability['parse']>
  try {
    if (!isProbablyReaderable(doc)) return null
    article = new Readability(doc, { charThreshold: 500 }).parse()
  } catch {
    return null
  }
  if (!article?.content || (article.textContent ?? '').trim().length < MIN_ARTICLE_CHARS) return null

  return {
    html: article.content,
    meta: {
      title: clean(article.title),
      site_name: clean(article.siteName),
      byline: clean(article.byline),
      published: clean(article.publishedTime)
    }
  }
}

/** The page's main region, or its body without navigation, headers and footers. */
function extractPage(html: string, baseUrl: string): string {
  const doc = parse(html)
  absolutizeLinks(doc, baseUrl)
  removeAll(doc, NEVER_CONTENT_SELECTOR)

  const main = doc.querySelector('main, [role="main"], article')
  if (main && textLength(main) >= MIN_PAGE_CHARS) {
    removeAll(main, PAGE_CHROME_SELECTOR)
    return main.innerHTML
  }

  const body = doc.body ?? doc.documentElement
  const fullHtml = body?.innerHTML ?? ''
  if (!body) return fullHtml
  removeAll(body, PAGE_CHROME_SELECTOR)
  return textLength(body) >= MIN_PAGE_CHARS ? body.innerHTML : fullHtml
}

export function extractHtmlPage(html: string, baseUrl: string): ExtractedPage {
  const meta = readMetadata(parse(html))
  const article = extractArticle(html, baseUrl)

  if (article) {
    return {
      title: article.meta.title || meta.title,
      site_name: article.meta.site_name ?? meta.site_name,
      byline: article.meta.byline ?? meta.byline,
      published: article.meta.published ?? meta.published,
      markdown: toMarkdown(article.html),
      extraction: 'article'
    }
  }

  return { ...meta, markdown: toMarkdown(extractPage(html, baseUrl)), extraction: 'page' }
}
