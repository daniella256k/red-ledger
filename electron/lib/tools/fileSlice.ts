/**
 * Paging for read_file so a large file can't flood the model's context.
 *
 * - No offset/limit and the file is small: the raw content, unchanged.
 * - No offset/limit and the file is large: the first page, raw, marked truncated.
 * - offset/limit given: that range, each line prefixed with "N | " so the
 *   model can cite and target lines.
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

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function sliceFileContent(
  text: string,
  options: { offset?: number; limit?: number } = {}
): FileSlice {
  const lines = splitLines(text)
  const totalLines = lines.length
  const ranged = options.offset !== undefined || options.limit !== undefined

  if (!ranged && totalLines <= READ_FILE_MAX_LINES && text.length <= READ_FILE_MAX_CHARS) {
    return { content: text, total_lines: totalLines, truncated: false }
  }

  const startLine = Math.max(1, Math.floor(options.offset ?? 1))
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? READ_FILE_MAX_LINES), READ_FILE_MAX_LINES))

  const out: string[] = []
  let chars = 0
  let clippedLine = false
  for (let index = startLine - 1; index < totalLines && out.length < limit; index++) {
    const lineNumber = index + 1
    let line = ranged ? `${lineNumber} | ${lines[index]}` : lines[index]

    if (chars + line.length > READ_FILE_MAX_CHARS) {
      if (out.length > 0) break
      // A single enormous line (minified code, data dumps): clip it.
      line = line.slice(0, READ_FILE_MAX_CHARS)
      clippedLine = true
    }

    out.push(line)
    chars += line.length + 1
    if (clippedLine) break
  }

  const endLine = startLine + out.length - 1
  const slice: FileSlice = {
    content: out.join('\n'),
    total_lines: totalLines,
    truncated: false,
    start_line: startLine,
    end_line: Math.max(endLine, startLine - 1)
  }

  const moreLinesAfter = endLine < totalLines
  if (moreLinesAfter || clippedLine) {
    slice.truncated = true
    if (moreLinesAfter) slice.next_offset = endLine + 1
    slice.note = clippedLine
      ? `Line ${endLine} is too long and was cut off after ${READ_FILE_MAX_CHARS} characters.`
      : `Showing lines ${startLine}-${endLine} of ${totalLines}. Call read_file with offset=${endLine + 1} to continue.`
  }

  if (startLine > totalLines && totalLines > 0) {
    slice.note = `offset ${startLine} is past the end of the file (${totalLines} lines).`
  }

  return slice
}
