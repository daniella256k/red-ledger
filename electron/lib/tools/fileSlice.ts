import { createReadStream } from 'fs'
import { createInterface } from 'readline'

/**
 * Paging for read_file so a large file can't flood the model's context.
 *
 * - No offset/limit and the file is small: the raw content, unchanged.
 * - No offset/limit and the file is large: the first page, raw, marked truncated.
 * - offset/limit given: that range, each line prefixed with "N | " so the
 *   model can cite and target lines.
 *
 * Text already in memory goes through sliceFileContent; a file too large to
 * load whole goes through sliceTextFile, which reads it line by line and
 * keeps only the page. Both give the same result for the same text.
 */

export const READ_FILE_MAX_LINES = 2000
export const READ_FILE_MAX_CHARS = 100_000

export interface FileSlice {
  content: string
  total_lines: number
  /** Always present so "not truncated" is never confused with "not reported". */
  truncated: boolean
  start_line?: number
  end_line?: number
  next_offset?: number
  note?: string
}

export interface SliceOptions {
  offset?: number
  limit?: number
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Collects one page of lines as they come; every line is still counted. */
class PageBuilder {
  private readonly ranged: boolean
  private readonly startLine: number
  private readonly limit: number
  private out: string[] = []
  private chars = 0
  private clippedLine = false
  private full = false
  private seen = 0

  constructor(options: SliceOptions) {
    this.ranged = options.offset !== undefined || options.limit !== undefined
    this.startLine = Math.max(1, Math.floor(options.offset ?? 1))
    this.limit = Math.max(1, Math.min(Math.floor(options.limit ?? READ_FILE_MAX_LINES), READ_FILE_MAX_LINES))
  }

  add(rawLine: string): void {
    this.seen += 1
    if (this.full || this.seen < this.startLine) return

    let line = this.ranged ? `${this.seen} | ${rawLine}` : rawLine
    if (this.chars + line.length > READ_FILE_MAX_CHARS) {
      if (this.out.length > 0) {
        this.full = true
        return
      }
      // A single enormous line (minified code, data dumps): clip it.
      line = line.slice(0, READ_FILE_MAX_CHARS)
      this.clippedLine = true
    }

    this.out.push(line)
    this.chars += line.length + 1
    if (this.clippedLine || this.out.length >= this.limit) this.full = true
  }

  finish(): FileSlice {
    const totalLines = this.seen
    const { startLine } = this
    const endLine = startLine + this.out.length - 1
    const slice: FileSlice = {
      content: this.out.join('\n'),
      total_lines: totalLines,
      truncated: false,
      start_line: startLine,
      end_line: Math.max(endLine, startLine - 1)
    }

    const moreLinesAfter = endLine < totalLines
    if (moreLinesAfter || this.clippedLine) {
      slice.truncated = true
      if (moreLinesAfter) slice.next_offset = endLine + 1
      slice.note = this.clippedLine
        ? `Line ${endLine} is too long and was cut off after ${READ_FILE_MAX_CHARS} characters.`
        : `Showing lines ${startLine}-${endLine} of ${totalLines}. Call read_file with offset=${endLine + 1} to continue.`
    }

    if (startLine > totalLines && totalLines > 0) {
      slice.note = `offset ${startLine} is past the end of the file (${totalLines} lines).`
    }

    return slice
  }
}

export function sliceFileContent(text: string, options: SliceOptions = {}): FileSlice {
  const lines = splitLines(text)
  const ranged = options.offset !== undefined || options.limit !== undefined

  if (!ranged && lines.length <= READ_FILE_MAX_LINES && text.length <= READ_FILE_MAX_CHARS) {
    return { content: text, total_lines: lines.length, truncated: false }
  }

  const page = new PageBuilder(options)
  for (const line of lines) page.add(line)
  return page.finish()
}

/**
 * One page of a text file too large to load whole, read as UTF-8 line by
 * line. Only the page is kept in memory; the rest is read to count lines.
 */
export async function sliceTextFile(filePath: string, options: SliceOptions = {}): Promise<FileSlice> {
  const page = new PageBuilder(options)
  const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) page.add(line)
  return page.finish()
}
