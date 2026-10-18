import type WordExtractor from 'word-extractor'

export const WORD_EMPTY_TEXT_NOTICE = '[No extractable text found in document.]'

let extractorPromise: Promise<WordExtractor> | null = null

async function loadWordExtractor(): Promise<WordExtractor> {
  if (!extractorPromise) {
    extractorPromise = import('word-extractor').then((mod) => new mod.default())
  }
  return extractorPromise
}

/** Trim trailing whitespace per line and collapse runs of blank lines. */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\xa0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract text from a Word file (.doc or .docx; the format is detected from
 * the file signature, not the extension). The body comes first; headers,
 * footers, footnotes, endnotes, text boxes and comments follow under their
 * own labels when present. Table cells come through tab separated.
 */
export async function extractWordText(filePath: string): Promise<string> {
  const extractor = await loadWordExtractor()
  const doc = await extractor.extract(filePath)

  const sections: Array<[label: string | null, text: string]> = [
    [null, doc.getBody()],
    ['Text boxes', doc.getTextboxes({ includeHeadersAndFooters: false, includeBody: true })],
    ['Headers and footers', doc.getHeaders({ includeFooters: true })],
    ['Footnotes', doc.getFootnotes()],
    ['Endnotes', doc.getEndnotes()],
    ['Comments', doc.getAnnotations()]
  ]

  return sections
    .map(([label, text]) => [label, normalizeExtractedText(text)] as const)
    .filter(([, text]) => text.length > 0)
    .map(([label, text]) => (label ? `--- ${label} ---\n${text}` : text))
    .join('\n\n')
}

export async function extractWordTextWithFallback(filePath: string): Promise<string> {
  const text = await extractWordText(filePath)
  return text.length > 0 ? text : WORD_EMPTY_TEXT_NOTICE
}
