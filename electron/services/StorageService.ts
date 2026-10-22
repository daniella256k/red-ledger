import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { ConversationService } from './ConversationService'
import type { CompactResult, StorageOverview } from '../../src/types'

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
 * Domain service for what the app keeps on disk: the database file and the
 * browser caches. Nothing here runs on its own; every change is something
 * the user asked for.
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
      )
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
