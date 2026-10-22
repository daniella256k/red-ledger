import { readdirSync, statSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { ConversationService } from './ConversationService'
import type { CompactResult, StorageBackup, StorageOverview } from '../../src/types'

/** Chromium's cache folders in the app profile; everything in them is rebuilt as needed. */
export const CACHE_DIRECTORIES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'Service Worker',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache'
]

/** Clears the browser caches; wraps Electron's session in production. */
export interface CacheCleaner {
  clear(): Promise<void>
}

/**
 * Domain service for what the app keeps on disk: the database and its
 * backups, and the browser caches. Nothing here runs on its own; every
 * deletion is something the user asked for.
 * No Electron imports — the cache cleaner is injected.
 */
export class StorageService {
  constructor(private readonly deps: {
    conversations: ConversationService
    dbPath: string
    /** The Chromium profile folder (app userData), where the caches live. */
    profilePath: string
    cacheCleaner: CacheCleaner
  }) {}

  getOverview(): StorageOverview {
    const pages = this.deps.conversations.getPageStats()
    return {
      databaseBytes: this.databaseBytes(),
      reclaimableBytes: pages.freePages * pages.pageSize,
      imageBytes: this.deps.conversations.getStoredImageBytes(),
      cacheBytes: CACHE_DIRECTORIES.reduce(
        (total, name) => total + directorySize(join(this.deps.profilePath, name)),
        0
      ),
      backups: this.listBackups()
    }
  }

  compact(): CompactResult {
    const beforeBytes = this.databaseBytes()
    this.deps.conversations.compact()
    return { beforeBytes, afterBytes: this.databaseBytes() }
  }

  clearCaches(): Promise<void> {
    return this.deps.cacheCleaner.clear()
  }

  /** Copies of the database made before migrations: `<name>.pre-<tag>.db` next to it. */
  listBackups(): StorageBackup[] {
    const directory = dirname(this.deps.dbPath)
    const prefix = `${basename(this.deps.dbPath).replace(/\.db$/i, '')}.pre-`

    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return []
    }

    return names
      .filter((name) => name.startsWith(prefix) && name.toLowerCase().endsWith('.db'))
      .flatMap((name) => {
        try {
          const stats = statSync(join(directory, name))
          return stats.isFile() ? [{ name, bytes: stats.size, modifiedAt: stats.mtimeMs }] : []
        } catch {
          return []
        }
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
  }

  /** A backup's full path. Only names that listBackups returns are accepted. */
  backupPath(name: string): string {
    if (!this.listBackups().some((backup) => backup.name === name)) {
      throw new Error(`Backup not found: ${name}`)
    }
    return join(dirname(this.deps.dbPath), name)
  }

  deleteBackup(name: string): void {
    unlinkSync(this.backupPath(name))
  }

  private databaseBytes(): number {
    return fileSize(this.deps.dbPath) + fileSize(`${this.deps.dbPath}-wal`)
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function directorySize(path: string): number {
  let total = 0
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) total += directorySize(entryPath)
    else if (entry.isFile()) total += fileSize(entryPath)
  }
  return total
}
