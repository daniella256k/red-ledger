import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as XLSX from 'xlsx'
import { DocumentExtractionError, extractDocumentText, isExtractedDocument } from '../DocumentTextService'
import { formatWorkbook } from '../SpreadsheetAttachmentService'
import { WORD_EMPTY_TEXT_NOTICE } from '../WordAttachmentService'
import { parseAttachmentPaths } from '../AttachmentService'

function buildWorkbook(): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new()

  const summary = XLSX.utils.aoa_to_sheet([
    ['Item', 'Qty', 'Price', 'Total'],
    ['Widget, large', 2, 9.5, null],
    ['Gadget [new]', 3, 4, null]
  ])
  summary.D2 = { t: 'n', f: 'B2*C2', v: 19 }
  summary.D3 = { t: 'n', f: 'B3*C3', v: 12 }
  summary.A3.l = { Target: 'https://example.com/gadget?id=7' }
  XLSX.utils.book_append_sheet(workbook, summary, 'Summary')

  // Data that starts away from A1, with a blank row in the middle.
  const offset = XLSX.utils.sheet_add_aoa(XLSX.utils.aoa_to_sheet([]), [
    ['When', 'Note'],
    [],
    [new Date(2024, 0, 5), 'says "hi"'],
    [new Date(2024, 0, 5, 14, 30), 'with a time']
  ], { origin: 'B3', cellDates: true })
  XLSX.utils.book_append_sheet(workbook, offset, 'Log')

  // A link whose text already shows the URL is left as is.
  const archive = XLSX.utils.aoa_to_sheet([['secret, see https://example.com/archive']])
  archive.A1.l = { Target: 'https://example.com/archive' }
  XLSX.utils.book_append_sheet(workbook, archive, 'Archive')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Blank')

  workbook.Workbook = {
    Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }, { Hidden: 0 }],
    Names: [{ Name: 'Totals', Ref: 'Summary!$D$2:$D$3' }]
  }
  return workbook
}

/** Minimal .docx: a zip with a content types part and a document part. */
function buildDocx(bodyXml: string): Buffer {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" '
    + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>'
  const document = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${bodyXml}</w:body></w:document>`

  const zip = XLSX.CFB.utils.cfb_new()
  XLSX.CFB.utils.cfb_add(zip, '[Content_Types].xml', Buffer.from(contentTypes))
  XLSX.CFB.utils.cfb_add(zip, 'word/document.xml', Buffer.from(document))
  return Buffer.from(XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }))
}

const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

describe('isExtractedDocument', () => {
  it('recognizes PDF, Word and spreadsheet extensions case-insensitively', () => {
    expect(isExtractedDocument('a.pdf')).toBe(true)
    expect(isExtractedDocument('a.DOCX')).toBe(true)
    expect(isExtractedDocument('a.doc')).toBe(true)
    expect(isExtractedDocument('a.xlsx')).toBe(true)
    expect(isExtractedDocument('a.xls')).toBe(true)
    expect(isExtractedDocument('a.ods')).toBe(true)
    expect(isExtractedDocument('a.csv')).toBe(false)
    expect(isExtractedDocument('a.txt')).toBe(false)
  })
})

describe('formatWorkbook', () => {
  it('renders each sheet as CSV with its range, formulas, visibility and named ranges', () => {
    const text = formatWorkbook(XLSX, buildWorkbook(), 'budget.xlsx')

    expect(text).toContain('Workbook "budget.xlsx": 4 sheets (Summary, Log, Archive [hidden], Blank)')
    expect(text).toContain([
      '## Sheet 1: Summary',
      'Range A1:D3 (3 rows x 4 columns)',
      '',
      'Item,Qty,Price,Total',
      '"Widget, large",2,9.5,19',
      '[Gadget \\[new\\]](https://example.com/gadget?id=7),3,4,12'
    ].join('\n'))
    expect(text).toContain('"secret, see https://example.com/archive"')
    expect(text).toContain('Formulas:\nD2: =B2*C2\nD3: =B3*C3')

    // Blank rows are kept so CSV rows line up with sheet rows; dates are ISO.
    expect(text).toContain([
      'Range B3:C6 (4 rows x 2 columns)',
      '',
      'When,Note',
      '',
      '2024-01-05,"says ""hi"""',
      '2024-01-05 14:30,with a time'
    ].join('\n'))

    expect(text).toContain('## Sheet 3: Archive [hidden]')
    expect(text).toContain('## Sheet 4: Blank\n(empty sheet)')
    expect(text).toContain('## Named ranges\nTotals: Summary!$D$2:$D$3')
  })

  it('truncates at a row boundary when the output limit is reached', () => {
    const workbook = XLSX.utils.book_new()
    const rows = Array.from({ length: 100 }, (_, index) => [`row-${index + 1}`, index])
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Big')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['later']]), 'Later')

    const text = formatWorkbook(XLSX, workbook, 'big.xlsx', 400)

    expect(text).toMatch(/\[Truncated: showing the first \d+ of 100 rows; spreadsheet output limit reached\.\]/)
    expect(text).not.toContain('row-100')
    expect(text).toContain('## Sheet 2: Later\nRange A1 (1 row x 1 column)\n[Omitted: spreadsheet output limit reached.]')
  })
})

describe('extractDocumentText', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'red-ledger-docs-'))
    const workbook = buildWorkbook()
    writeFileSync(join(dir, 'budget.xlsx'), XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    writeFileSync(join(dir, 'budget.xls'), XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }))
    writeFileSync(join(dir, 'budget.ods'), XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }))

    writeFileSync(join(dir, 'memo.docx'), buildDocx(
      paragraph('Quarterly memo')
      + paragraph('Revenue is   up.   ')
      + '<w:tbl><w:tr><w:tc>' + paragraph('Region') + '</w:tc><w:tc>' + paragraph('Sales') + '</w:tc></w:tr>'
      + '<w:tr><w:tc>' + paragraph('North') + '</w:tc><w:tc>' + paragraph('42') + '</w:tc></w:tr></w:tbl>'
    ))
    writeFileSync(join(dir, 'empty.docx'), buildDocx(''))
    writeFileSync(join(dir, 'broken.docx'), Buffer.from('not really a word file'))
    writeFileSync(join(dir, 'data.csv'), 'a,b\n1,2\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // SheetJS does not write formulas to .xls or sheet visibility to .ods, so
  // those fixtures carry less than the .xlsx one.
  it.each([
    ['budget.xlsx', 'Archive [hidden]', true],
    ['budget.xls', 'Archive [hidden]', false],
    ['budget.ods', 'Archive', true]
  ])('extracts sheets from %s', async (fileName, archiveLabel, hasFormulas) => {
    const text = await extractDocumentText(join(dir, fileName))
    expect(text).toContain(`Workbook "${fileName}": 4 sheets (Summary, Log, ${archiveLabel}, Blank)`)
    expect(text).toContain('"Widget, large",2,9.5,19')
    expect(text).toContain('[Gadget \\[new\\]](https://example.com/gadget?id=7),3,4,12')
    expect(text).toContain('2024-01-05,"says ""hi"""')
    if (hasFormulas) expect(text).toContain('Formulas:\nD2: =B2*C2')
  })

  it('extracts body text and tables from a .docx', async () => {
    const text = await extractDocumentText(join(dir, 'memo.docx'))
    expect(text).toBe('Quarterly memo\nRevenue is   up.\nRegion\tSales\nNorth\t42')
  })

  it('uses a placeholder for a Word file with no text', async () => {
    expect(await extractDocumentText(join(dir, 'empty.docx'))).toBe(WORD_EMPTY_TEXT_NOTICE)
  })

  it('reports unreadable documents with a short reason', async () => {
    await expect(extractDocumentText(join(dir, 'broken.docx'))).rejects.toThrow(DocumentExtractionError)
    await expect(extractDocumentText(join(dir, 'broken.docx'))).rejects.toThrow('could not be read')
  })

  it('returns null for files that are not extracted documents', async () => {
    expect(await extractDocumentText(join(dir, 'data.csv'))).toBeNull()
  })

  it('attaches documents as text and keeps CSV unchanged', async () => {
    const result = await parseAttachmentPaths([
      join(dir, 'memo.docx'),
      join(dir, 'budget.xlsx'),
      join(dir, 'data.csv'),
      join(dir, 'broken.docx')
    ])

    expect(result.attachments.map((attachment) => attachment.name)).toEqual(['memo.docx', 'budget.xlsx', 'data.csv'])
    expect(result.attachments.every((attachment) => attachment.kind === 'text')).toBe(true)
    const csv = result.attachments[2]
    expect(csv.kind === 'text' && csv.content).toBe('a,b\n1,2\n')
    expect(result.failed).toEqual(['broken.docx (could not be read)'])
  })
})
