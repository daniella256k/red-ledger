import { readFileSync } from 'fs'
import { basename } from 'path'
import type { CellObject, WorkBook, WorkSheet } from 'xlsx'

type XlsxModule = typeof import('xlsx')

/**
 * Spreadsheet text extraction.
 *
 * Every sheet is rendered as CSV under a "## Sheet" heading that names its
 * cell range, so row 1 of the CSV is the first row of that range. Cell values
 * are the formatted text a person sees in the app (currency, percentages,
 * thousands separators), except dates, which become unambiguous ISO
 * yyyy-mm-dd (with hh:mm[:ss] when the cell has a time), and hyperlinked
 * cells, which become Markdown links [text](url). Formulas and
 * named ranges follow the values, since the values alone hide how a sheet is
 * computed. CSV is compact and is the tabular format models read best.
 */

/** Upper bound on the rendered text, matching the plain text attachment cap. */
export const MAX_SPREADSHEET_TEXT_CHARS = 5 * 1024 * 1024
const MAX_FORMULAS_PER_SHEET = 200
const MAX_DEFINED_NAMES = 100

let xlsxPromise: Promise<XlsxModule> | null = null

async function loadXlsx(): Promise<XlsxModule> {
  if (!xlsxPromise) {
    xlsxPromise = Promise.all([import('xlsx'), import('xlsx/dist/cpexcel.full.mjs')])
      .then(([xlsx, cpexcel]) => {
        // Code pages for legacy .xls/.dbf files that are not UTF-16.
        xlsx.set_cptable(cpexcel)
        return xlsx
      })
  }
  return xlsxPromise
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvRow(cells: unknown[]): string {
  let end = cells.length
  while (end > 0 && (cells[end - 1] === '' || cells[end - 1] == null)) end -= 1
  return cells.slice(0, end).map((cell) => csvField(cell == null ? '' : String(cell))).join(',')
}

function hasContent(cell: CellObject): boolean {
  return Boolean(cell.f) || (cell.v !== undefined && cell.v !== null && cell.v !== '')
}

const pad = (value: number) => String(value).padStart(2, '0')

/**
 * ISO text for a date cell. SheetJS builds dates whose UTC fields hold the
 * value stored in the sheet, whatever the machine's time zone. Time-only
 * cells (day 0, which lands in 1899) keep their formatted text.
 */
function isoDateText(date: Date): string | null {
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1900) return null
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const [hours, minutes, seconds] = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
  if (hours === 0 && minutes === 0 && seconds === 0) return day
  return `${day} ${pad(hours)}:${pad(minutes)}${seconds === 0 ? '' : `:${pad(seconds)}`}`
}

/**
 * Markdown link for a hyperlinked cell, so the URL stays next to its label.
 * Text that already shows the URL is left alone; internal links keep their
 * "#Sheet!A1" target.
 */
function linkedText(text: string, target: string): string {
  if (text === '' || text === target) return target
  if (text.includes(target)) return text
  const label = text.replace(/[[\]]/g, (char) => `\\${char}`)
  const url = target.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `[${label}](${url})`
}

/** Rewrite date and hyperlink cells' display text, which the CSV is built from. */
function normalizeDisplayText(sheet: WorkSheet): void {
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue
    const cell = sheet[address] as CellObject
    if (cell.t === 'd' && cell.v instanceof Date) {
      const text = isoDateText(cell.v)
      if (text) cell.w = text
    }
    const target = cell.l?.Target
    if (target) {
      cell.w = linkedText(cell.w ?? (cell.v == null ? '' : String(cell.v)), target)
    }
  }
}

interface CellRange {
  s: { r: number; c: number }
  e: { r: number; c: number }
}

/** The smallest range holding every non-empty cell, or null for an empty sheet. */
function usedRange(xlsx: XlsxModule, sheet: WorkSheet): CellRange | null {
  let range: CellRange | null = null
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue
    if (!hasContent(sheet[address] as CellObject)) continue
    const { r, c } = xlsx.utils.decode_cell(address)
    if (!range) {
      range = { s: { r, c }, e: { r, c } }
      continue
    }
    range.s.r = Math.min(range.s.r, r)
    range.s.c = Math.min(range.s.c, c)
    range.e.r = Math.max(range.e.r, r)
    range.e.c = Math.max(range.e.c, c)
  }
  return range
}

function formulaLines(xlsx: XlsxModule, sheet: WorkSheet, range: CellRange): string[] {
  const lines: string[] = []
  let total = 0
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const address = xlsx.utils.encode_cell({ r, c })
      const cell = sheet[address] as CellObject | undefined
      if (!cell?.f) continue
      total += 1
      if (lines.length < MAX_FORMULAS_PER_SHEET) lines.push(`${address}: =${cell.f}`)
    }
  }
  if (total > lines.length) lines.push(`... and ${total - lines.length} more`)
  return lines
}

function visibilityLabel(workbook: WorkBook, index: number): string {
  const hidden = workbook.Workbook?.Sheets?.[index]?.Hidden
  if (hidden === 1) return ' [hidden]'
  if (hidden === 2) return ' [very hidden]'
  return ''
}

function definedNameLines(workbook: WorkBook): string[] {
  const names = (workbook.Workbook?.Names ?? [])
    // _xlnm.* are Excel's built-ins (print areas, filter ranges).
    .filter((name) => !name.Name.startsWith('_xlnm.'))
  const lines = names.slice(0, MAX_DEFINED_NAMES).map((name) => {
    const scope = name.Sheet === undefined ? '' : ` (sheet: ${workbook.SheetNames[name.Sheet] ?? name.Sheet})`
    return `${name.Name}${scope}: ${name.Ref}`
  })
  if (names.length > lines.length) lines.push(`... and ${names.length - lines.length} more`)
  return lines
}

/**
 * Render a parsed workbook (read with cellDates) as plain text. Rewrites the
 * display text of date and hyperlink cells in place. Exported for tests.
 */
export function formatWorkbook(
  xlsx: XlsxModule,
  workbook: WorkBook,
  fileName: string,
  maxChars: number = MAX_SPREADSHEET_TEXT_CHARS
): string {
  const sheetNames = workbook.SheetNames
  const sheetList = sheetNames.map((name, index) => `${name}${visibilityLabel(workbook, index)}`).join(', ')
  const parts: string[] = [
    `Workbook "${fileName}": ${plural(sheetNames.length, 'sheet')} (${sheetList})`
  ]
  let remaining = maxChars - parts[0].length

  sheetNames.forEach((name, index) => {
    const sheet = workbook.Sheets[name]
    const heading = `## Sheet ${index + 1}: ${name}${visibilityLabel(workbook, index)}`
    const range = sheet ? usedRange(xlsx, sheet) : null

    if (!sheet || !range) {
      parts.push(`${heading}\n(empty sheet)`)
      return
    }

    normalizeDisplayText(sheet)
    const rowCount = range.e.r - range.s.r + 1
    const columnCount = range.e.c - range.s.c + 1
    const header = `${heading}\nRange ${xlsx.utils.encode_range(range)} (${plural(rowCount, 'row')} x ${plural(columnCount, 'column')})`

    if (remaining <= 0) {
      parts.push(`${header}\n[Omitted: spreadsheet output limit reached.]`)
      return
    }

    const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      range,
      raw: false,
      defval: '',
      blankrows: true
    })

    const csvLines: string[] = []
    remaining -= header.length
    for (const row of rows) {
      const line = csvRow(row)
      if (line.length + 1 > remaining) break
      csvLines.push(line)
      remaining -= line.length + 1
    }

    const sections = [header, csvLines.join('\n')]
    if (csvLines.length < rows.length) {
      sections.push(`[Truncated: showing the first ${csvLines.length} of ${rows.length} rows; spreadsheet output limit reached.]`)
      remaining = 0
    }

    const formulas = formulaLines(xlsx, sheet, range)
    if (formulas.length > 0 && remaining > 0) {
      const block = `Formulas:\n${formulas.join('\n')}`
      sections.push(block)
      remaining -= block.length
    }

    parts.push(sections.join('\n\n'))
  })

  const names = definedNameLines(workbook)
  if (names.length > 0) parts.push(`## Named ranges\n${names.join('\n')}`)

  return parts.join('\n\n')
}

/**
 * Extract text from any spreadsheet format SheetJS reads: Excel
 * (.xlsx/.xlsm/.xlsb/.xls and templates), OpenDocument (.ods/.fods), Apple
 * Numbers, Lotus, Quattro Pro, dBASE, SYLK and DIF.
 */
export async function extractSpreadsheetText(filePath: string): Promise<string> {
  const xlsx = await loadXlsx()
  const workbook = xlsx.read(readFileSync(filePath), {
    type: 'buffer',
    cellDates: true,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false
  })
  return formatWorkbook(xlsx, workbook, basename(filePath))
}
