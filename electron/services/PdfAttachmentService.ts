import { readFileSync } from 'fs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
export const PDF_EMPTY_TEXT_NOTICE = '[No extractable text found in PDF.]'

interface CanvasGeometryModule {
  DOMMatrix: unknown
  DOMPoint: unknown
  DOMRect: unknown
}

interface PdfParseResult {
  text: string
}

interface PdfParser {
  getText(): Promise<PdfParseResult>
  destroy(): Promise<void>
}

type PdfParseCtor = new (options: { data: Uint8Array | Buffer }) => PdfParser

let parserCtorPromise: Promise<PdfParseCtor> | null = null
let polyfillsApplied = false

function ensurePdfGlobals(): void {
  if (polyfillsApplied) return

  const runtime = globalThis as Record<string, unknown>

  if (runtime.DOMMatrix === undefined || runtime.DOMPoint === undefined || runtime.DOMRect === undefined) {
    try {
      const geometry = require('@napi-rs/canvas/geometry') as CanvasGeometryModule
      if (runtime.DOMMatrix === undefined) runtime.DOMMatrix = geometry.DOMMatrix
      if (runtime.DOMPoint === undefined) runtime.DOMPoint = geometry.DOMPoint
      if (runtime.DOMRect === undefined) runtime.DOMRect = geometry.DOMRect
    } catch {
      // Best-effort: if geometry cannot be loaded, pdf-parse import may still work.
    }
  }

  if (runtime.ImageData === undefined) {
    runtime.ImageData = class ImageData {
      data: Uint8ClampedArray
      width: number
      height: number

      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data
        this.width = width
        this.height = height
      }
    }
  }

  if (runtime.Path2D === undefined) {
    runtime.Path2D = class Path2D {}
  }

  polyfillsApplied = true
}

async function loadPdfParserCtor(): Promise<PdfParseCtor> {
  if (!parserCtorPromise) {
    ensurePdfGlobals()
    parserCtorPromise = import('pdf-parse').then((mod) => mod.PDFParse as PdfParseCtor)
  }
  return parserCtorPromise
}

/**
 * Extract text from a local PDF file using pdf-parse v2.
 * Import is intentionally lazy to avoid startup-time crashes.
 */
export async function extractPdfText(filePath: string): Promise<string> {
  return extractPdfTextFromBuffer(readFileSync(filePath))
}

/** Extract text from PDF bytes already in memory, e.g. a fetched web page. */
export async function extractPdfTextFromBuffer(data: Uint8Array | Buffer): Promise<string> {
  const PDFParse = await loadPdfParserCtor()
  const parser = new PDFParse({ data })

  try {
    const parsed = await parser.getText()
    return parsed.text.trim()
  } finally {
    await parser.destroy().catch(() => {
      // Ignore cleanup errors.
    })
  }
}

/**
 * Extract text from a PDF and normalize empty extraction
 * to the shared placeholder used by attachment parsing.
 */
export async function extractPdfTextWithFallback(filePath: string): Promise<string> {
  const text = await extractPdfText(filePath)
  return text.length > 0 ? text : PDF_EMPTY_TEXT_NOTICE
}
