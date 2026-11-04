import { describe, expect, it } from 'vitest'
import { READ_FILE_MAX_CHARS, READ_FILE_MAX_LINES, sliceFileContent } from '../fileSlice'

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
}

describe('sliceFileContent', () => {
  it('returns small files unchanged', () => {
    const text = 'a: 1\nb: 2\n'
    expect(sliceFileContent(text)).toEqual({ content: text, total_lines: 2, truncated: false })
    expect(sliceFileContent('')).toEqual({ content: '', total_lines: 0, truncated: false })
  })

  it('pages large files without line numbers and points to the next page', () => {
    const slice = sliceFileContent(makeLines(READ_FILE_MAX_LINES + 500))

    expect(slice.truncated).toBe(true)
    expect(slice.start_line).toBe(1)
    expect(slice.end_line).toBe(READ_FILE_MAX_LINES)
    expect(slice.next_offset).toBe(READ_FILE_MAX_LINES + 1)
    expect(slice.total_lines).toBe(READ_FILE_MAX_LINES + 500)
    expect(slice.content.startsWith('line 1\n')).toBe(true)
    expect(slice.note).toContain(`offset=${READ_FILE_MAX_LINES + 1}`)
  })

  it('numbers lines for an explicit range', () => {
    const slice = sliceFileContent(makeLines(10), { offset: 4, limit: 3 })

    expect(slice.content).toBe('4 | line 4\n5 | line 5\n6 | line 6')
    expect(slice).toMatchObject({ start_line: 4, end_line: 6, next_offset: 7, truncated: true, total_lines: 10 })
  })

  it('is not truncated when the range reaches the end', () => {
    const slice = sliceFileContent(makeLines(10), { offset: 8 })
    expect(slice.content).toBe('8 | line 8\n9 | line 9\n10 | line 10')
    expect(slice.truncated).toBe(false)
    expect(slice.next_offset).toBeUndefined()
  })

  it('handles an offset past the end', () => {
    const slice = sliceFileContent(makeLines(3), { offset: 10 })
    expect(slice.content).toBe('')
    expect(slice.note).toContain('past the end')
  })

  it('caps characters, including one enormous line', () => {
    const slice = sliceFileContent('x'.repeat(READ_FILE_MAX_CHARS * 2))
    expect(slice.content.length).toBe(READ_FILE_MAX_CHARS)
    expect(slice.truncated).toBe(true)
    expect(slice.note).toContain('too long')
  })
})

describe('sliceTextFile', () => {
  it('gives the same pages as sliceFileContent, reading the file line by line', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { sliceTextFile } = await import('../fileSlice')
    const dir = mkdtempSync(join(tmpdir(), 'rl-slice-'))
    try {
      const cases: Array<[string, { offset?: number; limit?: number }]> = [
        [makeLines(READ_FILE_MAX_LINES + 500), {}],
        [makeLines(10), { offset: 4, limit: 3 }],
        [makeLines(10), { offset: 8 }],
        [makeLines(3), { offset: 10 }],
        ['x'.repeat(READ_FILE_MAX_CHARS * 2), {}],
        ['a\r\nb\r\nc\r\n', { offset: 2 }]
      ]
      for (const [i, [text, options]] of cases.entries()) {
        const file = join(dir, `case${i}.txt`)
        writeFileSync(file, text)
        expect(await sliceTextFile(file, options)).toEqual(sliceFileContent(text, options))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
