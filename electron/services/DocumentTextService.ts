import { statSync } from 'fs'
import { extname } from 'path'
import { extractPdfTextWithFallback } from './PdfAttachmentService'
import { extractWordTextWithFallback } from './WordAttachmentService'
import { extractSpreadsheetText } from './SpreadsheetAttachmentService'

/**
 * Binary document formats whose text is extracted before it reaches the
 * model: PDFs, Word files and spreadsheets. Used both for chat attachments
 * and for the read_file tool.
 *
 * CSV and TSV are not listed: they are already plain text in the format
 * spreadsheets are converted to, so they attach unchanged.
 */

export const WORD_EXTENSIONS = ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm']

export const SPREADSHEET_EXTENSIONS = [
  // Excel
  'xlsx', 'xlsm', 'xlsb', 'xltx', 'xltm', 'xls', 'xlt', 'xlw',
  // OpenDocument and Apple Numbers
  'ods', 'fods', 'ots', 'numbers',
  // Older and interchange formats
  'wk1', 'wk2', 'wk3', 'wk4', 'wks', '123', 'qpw', 'wb1', 'wb2', 'wb3', 'dbf', 'slk', 'sylk', 'dif'
]

export const EXTRACTED_DOCUMENT_EXTENSIONS = ['pdf', ...WORD_EXTENSIONS, ...SPREADSHEET_EXTENSIONS]

/** Input size cap for Word and spreadsheet files; parsing runs in the main process. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

export class DocumentExtractionError extends Error {}

type Extractor = (filePath: string) => Promise<string>

const EXTRACTOR_BY_EXTENSION = new Map<string, Extractor>([
  ['pdf', extractPdfTextWithFallback],
  ...WORD_EXTENSIONS.map((extension) => [extension, extractWordTextWithFallback] as const),
  ...SPREADSHEET_EXTENSIONS.map((extension) => [extension, extractSpreadsheetText] as const)
])

export function isExtractedDocument(filePath: string): boolean {
  return EXTRACTOR_BY_EXTENSION.has(extname(filePath).slice(1).toLowerCase())
}

function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return /password|encrypt/i.test(message) ? 'password-protected' : 'could not be read'
}

/**
 * Extract the text of a PDF, Word or spreadsheet file, or return null when
 * the file is not one of those formats. Failures throw
 * DocumentExtractionError with a short reason ("too large",
 * "password-protected", "could not be read").
 */
export async function extractDocumentText(filePath: string): Promise<string | null> {
  const extension = extname(filePath).slice(1).toLowerCase()
  const extractor = EXTRACTOR_BY_EXTENSION.get(extension)
  if (!extractor) return null

  if (extension !== 'pdf' && statSync(filePath).size > MAX_DOCUMENT_BYTES) {
    throw new DocumentExtractionError('too large')
  }

  try {
    return await extractor(filePath)
  } catch (err) {
    throw new DocumentExtractionError(describeFailure(err))
  }
}
