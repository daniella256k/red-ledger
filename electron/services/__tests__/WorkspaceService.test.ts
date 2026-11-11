import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WorkspaceService, type DialogAdapter } from '../WorkspaceService'
import type { Settings } from '../../../src/types'

const BASE_SETTINGS: Settings = {
  activeProvider: 'openai',
  providers: {
    openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', models: [] },
    openrouter: { apiKey: '', baseUrl: 'https://openrouter.ai/api/v1', models: [] },
    ollama: { apiKey: '', baseUrl: 'http://localhost:11434', models: [] },
    lmstudio: { apiKey: '', baseUrl: 'http://localhost:1234', models: [] },
    custom: { apiKey: '', baseUrl: 'http://localhost:8080/v1', models: [] }
  },
  defaultModel: 'gpt-4',
  reasoningEnabled: true,
  temperatureEnabled: false,
  temperature: 0.7,
  maxTokensEnabled: false,
  maxTokens: 4096,
  strictMode: false,
  darkMode: false,
  tavilyApiKey: '',
  serpApiKey: '',
  orgSite: '',
  searchToolsEnabled: true,
  offlineMode: false,
  autoCompact: true,
  lastWorkspacePath: null,
  providerSectionExpanded: true,
  searchSectionExpanded: true,
  advancedSectionExpanded: false,
  connectionsSectionExpanded: false,
  customToolsSectionExpanded: false,
  mcpServers: []
}

describe('WorkspaceService.writeFile', () => {
  let workspaceRoot: string
  let service: WorkspaceService

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'red-ledger-workspace-'))
    service = new WorkspaceService(() => BASE_SETTINGS)
    service.setWorkspacePath(workspaceRoot)
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('creates parent directories for nested write paths', async () => {
    await service.writeFile(null, 'reports/file.md', '# Report\n', false)

    const filePath = join(workspaceRoot, 'reports', 'file.md')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('# Report\n')
  })

  it('creates parent directories when appending to a nested path', async () => {
    const filePath = join(workspaceRoot, 'logs', 'daily', 'run.log')

    await service.writeFile(null, 'logs/daily/run.log', 'line1\n', true)
    await service.writeFile(null, 'logs/daily/run.log', 'line2\n', true)

    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('line1\nline2\n')
  })

  it('writes binary files and creates parent directories', async () => {
    const filePath = join(workspaceRoot, 'exports', 'report.pdf')
    const content = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

    await service.writeBinaryFile(null, 'exports/report.pdf', content)

    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath)).toEqual(content)
  })

  it('requires confirmation before appending to an existing file in strict mode', async () => {
    const strictService = new WorkspaceService(() => ({
      ...BASE_SETTINGS,
      strictMode: true
    }))
    strictService.setWorkspacePath(workspaceRoot)

    await strictService.writeFile(null, 'logs/app.log', 'line1\n', true)

    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    const dialog: DialogAdapter = { showMessageBox }

    await strictService.writeFile(dialog, 'logs/app.log', 'line2\n', true)

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(workspaceRoot, 'logs', 'app.log'), 'utf-8')).toBe('line1\nline2\n')
  })
})

describe('WorkspaceService.listFiles', () => {
  let workspaceRoot: string
  let service: WorkspaceService

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'red-ledger-list-'))
    mkdirSync(join(workspaceRoot, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(workspaceRoot, '.git'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'node_modules'), { recursive: true })
    writeFileSync(join(workspaceRoot, '.github', 'workflows', 'ci.yml'), 'on: push\n')
    writeFileSync(join(workspaceRoot, '.env.example'), 'KEY=\n')
    writeFileSync(join(workspaceRoot, 'README.md'), '# Hi\n')
    service = new WorkspaceService(() => BASE_SETTINGS)
    service.setWorkspacePath(workspaceRoot)
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('hides dotfiles by default', () => {
    expect(service.listFiles().map((node) => node.name)).toEqual(['README.md'])
  })

  it('includes dotfiles when asked, but never .git or node_modules', () => {
    const nodes = service.listFiles(undefined, { includeHidden: true })
    expect(nodes.map((node) => node.name)).toEqual(['.github', '.env.example', 'README.md'])
    expect(nodes[0].children?.[0].children?.[0].path).toBe('.github/workflows/ci.yml')
  })
})

describe('WorkspaceService backups and moves', () => {
  let workspaceRoot: string
  let service: WorkspaceService

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'red-ledger-workspace-'))
    service = new WorkspaceService(() => BASE_SETTINGS)
    service.setWorkspacePath(workspaceRoot)
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('renames a file and creates missing parent directories', async () => {
    writeFileSync(join(workspaceRoot, 'draft.md'), 'x')

    const moved = await service.moveFile(null, 'draft.md', 'archive/2026/final.md')

    expect(moved.to).toBe('archive/2026/final.md')
    expect(existsSync(join(workspaceRoot, 'draft.md'))).toBe(false)
    expect(readFileSync(join(workspaceRoot, 'archive', '2026', 'final.md'), 'utf-8')).toBe('x')
  })

  it('moves a file into an existing directory keeping its name', async () => {
    writeFileSync(join(workspaceRoot, 'minutes.md'), 'x')
    mkdirSync(join(workspaceRoot, 'meetings'))

    const moved = await service.moveFile(null, 'minutes.md', 'meetings/')

    expect(moved.to).toBe('meetings/minutes.md')
    expect(existsSync(join(workspaceRoot, 'meetings', 'minutes.md'))).toBe(true)
  })

  it('refuses to overwrite an existing destination or escape the workspace', async () => {
    writeFileSync(join(workspaceRoot, 'a.md'), 'a')
    writeFileSync(join(workspaceRoot, 'b.md'), 'b')

    await expect(service.moveFile(null, 'a.md', 'b.md')).rejects.toThrow(/already exists/)
    await expect(service.moveFile(null, 'a.md', '../outside.md')).rejects.toThrow()
    expect(readFileSync(join(workspaceRoot, 'b.md'), 'utf-8')).toBe('b')
  })
})

/** File symlinks need Developer Mode or admin rights on Windows; junctions don't. */
function canCreateFileSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'red-ledger-link-probe-'))
  try {
    symlinkSync(join(dir, 'missing'), join(dir, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('WorkspaceService symbolic links', () => {
  let workspaceRoot: string
  let outsideRoot: string
  let service: WorkspaceService

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'red-ledger-workspace-'))
    outsideRoot = mkdtempSync(join(tmpdir(), 'red-ledger-outside-'))
    service = new WorkspaceService(() => BASE_SETTINGS)
    service.setWorkspacePath(workspaceRoot)
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
  })

  it('refuses to write through a junction whose target does not exist yet', async () => {
    const target = join(outsideRoot, 'not-yet')
    symlinkSync(target, join(workspaceRoot, 'linked'), 'junction')

    await expect(service.writeFile(null, 'linked/escape.txt', 'x', false)).rejects.toThrow(/Symbolic links/)
    expect(existsSync(target)).toBe(false)
  })

  it.runIf(canCreateFileSymlinks())('refuses to write through a broken file link', async () => {
    const target = join(outsideRoot, 'escape.txt')
    symlinkSync(target, join(workspaceRoot, 'note.txt'), 'file')

    await expect(service.writeFile(null, 'note.txt', 'x', false)).rejects.toThrow(/Symbolic links/)
    expect(existsSync(target)).toBe(false)
  })
})

describe('WorkspaceService.readTextForEdit', () => {
  let workspaceRoot: string
  let service: WorkspaceService

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'red-ledger-workspace-'))
    service = new WorkspaceService(() => BASE_SETTINGS)
    service.setWorkspacePath(workspaceRoot)
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('returns UTF-8 text as is, byte order mark included', () => {
    writeFileSync(join(workspaceRoot, 'notes.md'), '\uFEFFcaf\u00e9\r\n')
    expect(service.readTextForEdit('notes.md')).toBe('\uFEFFcaf\u00e9\r\n')
  })

  it('refuses documents, binary files and text that is not UTF-8', () => {
    writeFileSync(join(workspaceRoot, 'report.docx'), 'PK\x03\x04')
    writeFileSync(join(workspaceRoot, 'image.bin'), Buffer.from([1, 0, 2]))
    writeFileSync(join(workspaceRoot, 'latin1.txt'), Buffer.from('caf\u00e9', 'latin1'))

    expect(() => service.readTextForEdit('report.docx')).toThrow(/is a document/)
    expect(() => service.readTextForEdit('image.bin')).toThrow(/is binary/)
    expect(() => service.readTextForEdit('latin1.txt')).toThrow(/not UTF-8/)
  })

  it('refuses to append text to a document', async () => {
    writeFileSync(join(workspaceRoot, 'report.pdf'), '%PDF-1.7')
    await expect(service.writeFile(null, 'report.pdf', 'more', true)).rejects.toThrow(/corrupt the document/)
    expect(readFileSync(join(workspaceRoot, 'report.pdf'), 'utf-8')).toBe('%PDF-1.7')
  })
})

describe('WorkspaceService.snapshot', () => {
  it('stays on the folder it was taken in when the active workspace changes', () => {
    const service = new WorkspaceService(() => BASE_SETTINGS)
    service.setWorkspacePath('/chats/a')

    const pinned = service.snapshot()
    service.setWorkspacePath('/chats/b')

    expect(pinned.getWorkspacePath()).toBe('/chats/a')
    expect(service.getWorkspacePath()).toBe('/chats/b')
  })
})

describe('WorkspaceService.grepFiles', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'red-ledger-workspace-'))
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('finds regex matches with their line and column', () => {
    writeFileSync(join(workspaceRoot, 'notes.md'), 'alpha\nbeta 42\ngamma 7\n')
    const service = new WorkspaceService(() => BASE_SETTINGS)
    service.setWorkspacePath(workspaceRoot)

    const matches = service.grepFiles({ pattern: '[0-9]+', isRegex: true })

    expect(matches.map(({ line, column }) => [line, column])).toEqual([[2, 6], [3, 7]])
  })

  it('stops a regex that backtracks too long instead of freezing', () => {
    writeFileSync(join(workspaceRoot, 'slow.txt'), `${'a'.repeat(40)}b\n`)
    const service = new WorkspaceService(() => BASE_SETTINGS)
    service.setWorkspacePath(workspaceRoot)

    const started = Date.now()
    expect(() => service.grepFiles({ pattern: '(a+)+$', isRegex: true, regexBudgetMs: 200 }))
      .toThrow(expect.objectContaining({ code: 'TIMEOUT' }))
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('asks before searching in strict mode', async () => {
    const service = new WorkspaceService(() => ({ ...BASE_SETTINGS, strictMode: true }))
    service.setWorkspacePath(workspaceRoot)
    const dialog: DialogAdapter = { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) }

    await expect(service.confirmSearch(dialog, 'password')).rejects.toMatchObject({ code: 'USER_DENIED' })
    expect(dialog.showMessageBox).toHaveBeenCalledOnce()
    await expect(service.confirmSearch(null, 'password')).resolves.toBeUndefined()
  })
})

describe('WorkspaceService reading and listing limits', () => {
  let workspaceRoot: string
  let service: WorkspaceService

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'red-ledger-limits-'))
    service = new WorkspaceService(() => BASE_SETTINGS)
    service.setWorkspacePath(workspaceRoot)
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists breadth first within the entry budget, marking what it did not reach', () => {
    for (const folder of ['a', 'b']) {
      mkdirSync(join(workspaceRoot, folder, 'deep'), { recursive: true })
      for (let i = 0; i < 5; i++) writeFileSync(join(workspaceRoot, folder, `f${i}.txt`), '')
      writeFileSync(join(workspaceRoot, folder, 'deep', 'x.txt'), '')
    }
    writeFileSync(join(workspaceRoot, 'top.txt'), '')

    const tree = service.listFileTree(undefined, { maxEntries: 10 })
    expect(tree.truncated).toBe(true)
    expect(tree.entries).toBe(10)
    // Top level whole, then a's contents, then b's only in part.
    expect(tree.nodes.map((n) => n.name)).toEqual(['a', 'b', 'top.txt'])
    const [a, b] = tree.nodes
    expect(a.children?.map((n) => n.name)).toEqual(['deep', 'f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt'])
    expect(a.truncated).toBeUndefined()
    expect(b.truncated).toBe(true)
    expect(b.children?.map((n) => n.name)).toEqual(['deep'])
    // Folders never reached show without contents.
    expect(a.children?.[0]).toMatchObject({ name: 'deep', truncated: true })
    expect(a.children?.[0].children).toBeUndefined()

    const whole = service.listFileTree()
    expect(whole.truncated).toBe(false)
    expect(whole.entries).toBe(17)
  })

  it('pages a large text file without loading it whole, matching a small file read', async () => {
    const lines = Array.from({ length: 400_000 }, (_, i) => `row ${i + 1} ${'x'.repeat(20)}`)
    writeFileSync(join(workspaceRoot, 'big.log'), lines.join('\n') + '\n')

    const first = await service.readFileSlice(null, 'big.log')
    expect(first).toMatchObject({ total_lines: 400_000, truncated: true, start_line: 1, next_offset: 2001 })
    expect(first.content.split('\n')[0]).toBe(lines[0])

    const later = await service.readFileSlice(null, 'big.log', { offset: 399_999, limit: 5 })
    expect(later.content).toBe(`399999 | ${lines[399_998]}\n400000 | ${lines[399_999]}`)
    expect(later.truncated).toBe(false)
  })

  it('refuses binary files and folders, and reads UTF-16 text', async () => {
    writeFileSync(join(workspaceRoot, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]))
    mkdirSync(join(workspaceRoot, 'folder'))
    writeFileSync(join(workspaceRoot, 'wide.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo\n', 'utf16le')]))

    await expect(service.readFileSlice(null, 'image.bin')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
    await expect(service.readFileSlice(null, 'folder')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
    expect((await service.readFileSlice(null, 'wide.txt')).content).toBe('héllo\n')
  })

  it('shows the viewer the start of a huge file with a note', async () => {
    writeFileSync(join(workspaceRoot, 'huge.txt'), 'line of text\n'.repeat(300_000))

    const shown = await service.readFile(null, 'huge.txt')
    expect(shown.length).toBeLessThan(2.2 * 1024 * 1024)
    expect(shown.startsWith('line of text\n')).toBe(true)
    expect(shown).toMatch(/\[Showing the first 2 MB of 3\.\d MB\./)
    // Cut at a line end, never in the middle of a line.
    expect(shown.split('\n[Showing')[0].endsWith('line of text\n')).toBe(true)
  })

  it('asks in Strict Mode before the assistant reads, and not for the viewer', async () => {
    writeFileSync(join(workspaceRoot, 'notes.md'), 'hi\n')
    const strict = new WorkspaceService(() => ({ ...BASE_SETTINGS, strictMode: true }))
    strict.setWorkspacePath(workspaceRoot)
    const dialog: DialogAdapter = { showMessageBox: vi.fn(async () => ({ response: 0 })) }

    await expect(strict.readFileSlice(dialog, 'notes.md')).rejects.toMatchObject({ code: 'USER_DENIED' })
    expect(await strict.readFile(null, 'notes.md')).toBe('hi\n')
  })

  it('searches in the background with the same results as the direct search', async () => {
    writeFileSync(join(workspaceRoot, 'a.md'), 'alpha\nbeta needle\n')
    expect(await service.searchFiles({ pattern: 'needle' })).toEqual(service.grepFiles({ pattern: 'needle' }))
  })
})
