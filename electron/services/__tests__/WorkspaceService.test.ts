import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
    lmstudio: { apiKey: '', baseUrl: 'http://localhost:1234', models: [], compatibility: 'openai' },
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
  lastWorkspacePath: null,
  providerSectionExpanded: true,
  searchSectionExpanded: true,
  advancedSectionExpanded: false,
  connectionsSectionExpanded: false,
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

  it('keeps the previous version as .bak when overwriting or editing', async () => {
    writeFileSync(join(workspaceRoot, 'notes.md'), 'v1')

    await service.writeFile(null, 'notes.md', 'v2', false)
    expect(readFileSync(join(workspaceRoot, 'notes.md.bak'), 'utf-8')).toBe('v1')

    await service.editFile(null, 'notes.md', 'v3')
    expect(readFileSync(join(workspaceRoot, 'notes.md.bak'), 'utf-8')).toBe('v2')
    expect(readFileSync(join(workspaceRoot, 'notes.md'), 'utf-8')).toBe('v3')
  })

  it('does not create a .bak for new files or appends', async () => {
    await service.writeFile(null, 'log.md', 'a', false)
    await service.writeFile(null, 'log.md', 'b', true)
    expect(existsSync(join(workspaceRoot, 'log.md.bak'))).toBe(false)
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
