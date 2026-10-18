import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { DocumentExtractionError, extractDocumentText } from './DocumentTextService'
import type { Attachment, AttachmentParseResult, ImageAttachmentMimeType } from '../../src/types'

/**
 * Attachment parsing for files picked in the dialog or dropped on the chat.
 *
 * Images, PDFs, Word files and spreadsheets are recognized by extension;
 * documents are reduced to their extracted text (spreadsheets as CSV per
 * sheet). Everything else is accepted as long as the content is text, so scripts, configs and markup files
 * (.py, .yaml, .json, .xml, .css, Dockerfile, .env, ...) attach without
 * renaming them to .txt.
 */

export const IMAGE_MIME_BY_EXTENSION: Record<string, ImageAttachmentMimeType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/**
 * Common text formats, shown in the file dialog's default filter.
 * Not an allow-list: files with other (or no) extensions still attach when
 * their content is text.
 */
export const COMMON_TEXT_EXTENSIONS = [
  // Docs & plain text
  'txt', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'org', 'tex', 'bib', 'log', 'rtf', 'srt', 'vtt',
  // Data & config
  'csv', 'tsv', 'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'conf', 'config', 'properties', 'env', 'xml', 'xsd', 'xsl', 'xslt', 'plist', 'svg', 'graphql',
  'gql', 'proto', 'sql', 'prisma', 'ipynb',
  // Web
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro', 'hbs', 'ejs',
  'pug', 'njk', 'liquid', 'twig',
  // Code
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'pyi', 'rb', 'php', 'pl', 'lua', 'r',
  'jl', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'swift', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'fs', 'vb', 'dart', 'ex', 'exs', 'erl', 'hs', 'elm', 'clj', 'lisp', 'scm',
  'ml', 'nim', 'zig', 'sol', 'asm',
  // Shell & build
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'mk', 'cmake', 'tf', 'hcl', 'nix',
  'dockerfile', 'diff', 'patch', 'lock'
]

export const MAX_TEXT_ATTACHMENT_BYTES = 5 * 1024 * 1024
const SNIFF_BYTES = 8192
/** Share of control characters above which a buffer is treated as binary. */
const MAX_CONTROL_CHAR_RATIO = 0.1

export class AttachmentError extends Error {}

function hasUtf16Bom(buffer: Buffer): 'le' | 'be' | null {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'le'
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'be'
  return null
}

/**
 * Heuristic text check on the start of a file: UTF-16 with a BOM counts as
 * text; otherwise any NUL byte or a high share of control characters means
 * binary (images, archives, Office documents, executables).
 */
export function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  if (hasUtf16Bom(buffer)) return true

  const sample = buffer.subarray(0, SNIFF_BYTES)
  let controlChars = 0
  for (const byte of sample) {
    if (byte === 0) return false
    // Allow tab, LF, FF, CR and ESC (ANSI colors in logs).
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b) {
      controlChars += 1
    }
  }
  return controlChars / sample.length <= MAX_CONTROL_CHAR_RATIO
}

/** Decode text file bytes, honoring UTF-8 and UTF-16 byte order marks. */
export function decodeText(buffer: Buffer): string {
  const utf16 = hasUtf16Bom(buffer)
  if (utf16 === 'le') return buffer.subarray(2).toString('utf16le')
  if (utf16 === 'be') {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }

  const text = buffer.toString('utf-8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function parseAttachmentFile(filePath: string): Promise<Attachment> {
  const fileName = basename(filePath)
  const extension = extname(filePath).toLowerCase()
  const imageMime = IMAGE_MIME_BY_EXTENSION[extension]

  if (imageMime) {
    const base64Image = readFileSync(filePath).toString('base64')
    return {
      kind: 'image',
      name: fileName,
      mimeType: imageMime,
      dataUrl: `data:${imageMime};base64,${base64Image}`
    }
  }

  const documentText = await extractDocumentText(filePath)
  if (documentText !== null) {
    return { kind: 'text', name: fileName, content: documentText }
  }

  if (statSync(filePath).size > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new AttachmentError('too large')
  }

  const buffer = readFileSync(filePath)
  if (!looksLikeText(buffer)) {
    throw new AttachmentError('not a text file')
  }

  return {
    kind: 'text',
    name: fileName,
    content: decodeText(buffer)
  }
}

/**
 * Parse many files at once. Failures are reported as "name (reason)" so the
 * user can see why a file was skipped.
 */
export async function parseAttachmentPaths(filePaths: string[]): Promise<AttachmentParseResult> {
  const uniqueFilePaths = Array.from(new Set(filePaths))
  const parsed = await Promise.all(uniqueFilePaths.map(async (filePath) => {
    try {
      const attachment = await parseAttachmentFile(filePath)
      return { ok: true as const, attachment }
    } catch (err) {
      const reason = err instanceof AttachmentError || err instanceof DocumentExtractionError
        ? err.message
        : 'could not be read'
      return { ok: false as const, name: `${basename(filePath)} (${reason})` }
    }
  }))

  return {
    attachments: parsed
      .filter((result): result is { ok: true; attachment: Attachment } => result.ok)
      .map((result) => result.attachment),
    failed: parsed
      .filter((result): result is { ok: false; name: string } => !result.ok)
      .map((result) => result.name)
  }
}
