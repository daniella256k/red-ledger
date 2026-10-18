import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decodeText, looksLikeText, parseAttachmentPaths } from '../AttachmentService'

describe('looksLikeText', () => {
  it('accepts plain, code, and empty content', () => {
    expect(looksLikeText(Buffer.from(''))).toBe(true)
    expect(looksLikeText(Buffer.from('key: value\nlist:\n  - a\n'))).toBe(true)
    expect(looksLikeText(Buffer.from('def main():\n\tprint("hi")\r\n'))).toBe(true)
    expect(looksLikeText(Buffer.from('\u001b[31mred log line\u001b[0m\n'))).toBe(true)
  })

  it('accepts UTF-16 files with a BOM', () => {
    expect(looksLikeText(Buffer.from('﻿hello', 'utf16le'))).toBe(true)
  })

  it('rejects binary content', () => {
    expect(looksLikeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(false)
    expect(looksLikeText(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x41]))).toBe(false)
  })
})

describe('decodeText', () => {
  it('strips a UTF-8 BOM', () => {
    expect(decodeText(Buffer.from('﻿name: test', 'utf-8'))).toBe('name: test')
  })

  it('decodes UTF-16 LE and BE', () => {
    expect(decodeText(Buffer.from('﻿hello', 'utf16le'))).toBe('hello')

    const be = Buffer.from('﻿hello', 'utf16le')
    be.swap16()
    expect(decodeText(be)).toBe('hello')
  })
})

describe('parseAttachmentPaths', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'red-ledger-attach-'))
    writeFileSync(join(dir, 'config.yaml'), 'name: red-ledger\n')
    writeFileSync(join(dir, 'script.py'), 'print("hello")\n')
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\n')
    writeFileSync(join(dir, 'notes.weird-ext'), 'plain text with an unusual extension')
    writeFileSync(join(dir, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('attaches text files regardless of extension and reports binaries', async () => {
    const result = await parseAttachmentPaths([
      join(dir, 'config.yaml'),
      join(dir, 'script.py'),
      join(dir, 'Dockerfile'),
      join(dir, 'notes.weird-ext'),
      join(dir, 'archive.zip'),
      join(dir, 'missing.txt')
    ])

    expect(result.attachments.map((a) => a.name)).toEqual([
      'config.yaml',
      'script.py',
      'Dockerfile',
      'notes.weird-ext'
    ])
    expect(result.attachments[0]).toEqual({ kind: 'text', name: 'config.yaml', content: 'name: red-ledger\n' })
    expect(result.failed).toEqual([
      'archive.zip (not a text file)',
      'missing.txt (could not be read)'
    ])
  })
})
