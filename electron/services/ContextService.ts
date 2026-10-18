import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'fs'
import type { ContextType } from '../ipc/contract'
import type { ContextProfile } from '../../src/types'

const CONTEXT_FILES: Record<ContextType, string> = {
  system: 'system.md',
  user: 'user.md',
  org: 'org.md'
}

const CONTEXT_TYPES: ContextType[] = ['system', 'user', 'org']
const PROFILES_DIR_NAME = 'profiles'
const PROFILE_STATE_FILE = 'profiles.json'
const PROFILE_NAME_MAX_LENGTH = 48
const DEFAULT_PROFILE: ContextProfile = {
  id: 'default',
  name: 'Default'
}

type ProfileSeedMode = 'bundled' | 'blank'

interface PersistedProfileState {
  profiles?: Array<Partial<ContextProfile>>
  activeProfileId?: string
}

export interface ContextProfileState {
  profiles: ContextProfile[]
  activeProfileId: string
}

/**
 * Domain service for context files (system/user/org prompts).
 * Manages named local profiles and an active profile pointer.
 * No Electron imports.
 */
export class ContextService {
  private contextDir: string
  private bundledDir: string
  private profileState: ContextProfileState

  constructor(contextDir: string, bundledDir: string) {
    this.contextDir = contextDir
    this.bundledDir = bundledDir
    this.ensureDirectory(this.contextDir)
    this.ensureDirectory(this.getProfilesDir())
    this.profileState = this.loadProfileState()
    this.ensureAllProfileContextFiles()
  }

  getActiveProfileId(): string {
    return this.profileState.activeProfileId
  }

  /**
   * The profile a chat's prompt is built from: its own when it still exists,
   * otherwise the active one (legacy chats, or a profile since deleted).
   */
  resolveProfileId(profileId?: string | null): string {
    if (profileId && this.profileState.profiles.some((profile) => profile.id === profileId)) {
      return profileId
    }
    return this.profileState.activeProfileId
  }

  listProfiles(): ContextProfileState {
    return {
      activeProfileId: this.profileState.activeProfileId,
      profiles: this.profileState.profiles.map((profile) => ({ ...profile }))
    }
  }

  createProfile(name: string): ContextProfileState {
    const normalizedName = normalizeProfileName(name)
    if (!normalizedName) {
      throw new Error('Profile name cannot be empty')
    }

    const nameTaken = this.profileState.profiles.some(
      (profile) => profile.name.toLowerCase() === normalizedName.toLowerCase()
    )
    if (nameTaken) {
      throw new Error(`Profile "${normalizedName}" already exists`)
    }

    const newProfile: ContextProfile = {
      id: this.createUniqueProfileId(normalizedName),
      name: normalizedName
    }

    this.profileState = {
      activeProfileId: newProfile.id,
      profiles: [...this.profileState.profiles, newProfile]
    }
    this.ensureProfileContextFiles(newProfile.id, 'blank')
    this.persistProfileState()
    return this.listProfiles()
  }

  setActiveProfile(profileId: string): ContextProfileState {
    const exists = this.profileState.profiles.some((profile) => profile.id === profileId)
    if (!exists) {
      throw new Error(`Profile "${profileId}" was not found`)
    }

    if (this.profileState.activeProfileId === profileId) {
      return this.listProfiles()
    }

    this.profileState = {
      ...this.profileState,
      activeProfileId: profileId
    }
    this.persistProfileState()
    return this.listProfiles()
  }

  /**
   * Rename only; the id (and so its folder and every chat bound to it) stays.
   */
  renameProfile(profileId: string, name: string): ContextProfileState {
    const target = this.profileState.profiles.find((profile) => profile.id === profileId)
    if (!target) {
      throw new Error(`Profile "${profileId}" was not found`)
    }

    const normalizedName = normalizeProfileName(name)
    if (!normalizedName) {
      throw new Error('Profile name cannot be empty')
    }

    const nameTaken = this.profileState.profiles.some(
      (profile) => profile.id !== profileId && profile.name.toLowerCase() === normalizedName.toLowerCase()
    )
    if (nameTaken) {
      throw new Error(`Profile "${normalizedName}" already exists`)
    }

    this.profileState = {
      ...this.profileState,
      profiles: this.profileState.profiles.map((profile) =>
        profile.id === profileId ? { ...profile, name: normalizedName } : profile
      )
    }
    this.persistProfileState()
    return this.listProfiles()
  }

  deleteProfile(profileId: string): ContextProfileState {
    const target = this.profileState.profiles.find((profile) => profile.id === profileId)
    if (!target) {
      throw new Error(`Profile "${profileId}" was not found`)
    }
    if (target.id === DEFAULT_PROFILE.id) {
      throw new Error('The Default profile cannot be deleted')
    }

    const remainingProfiles = this.profileState.profiles.filter((profile) => profile.id !== profileId)
    const nextActiveProfileId = this.profileState.activeProfileId === profileId
      ? (remainingProfiles.find((profile) => profile.id === DEFAULT_PROFILE.id)?.id || remainingProfiles[0].id)
      : this.profileState.activeProfileId

    const profileDir = this.getProfileDir(profileId)
    if (existsSync(profileDir)) {
      rmSync(profileDir, { recursive: true, force: true })
    }

    this.profileState = {
      profiles: remainingProfiles,
      activeProfileId: nextActiveProfileId
    }
    this.persistProfileState()
    return this.listProfiles()
  }

  load(type: ContextType): string {
    try {
      const filePath = this.getActiveProfileContextPath(type)
      if (!existsSync(filePath)) {
        return ''
      }
      return readFileSync(filePath, 'utf-8')
    } catch {
      return ''
    }
  }

  save(type: ContextType, content: string): void {
    const filePath = this.getActiveProfileContextPath(type)
    writeFileSync(filePath, content, 'utf-8')
  }

  loadDefault(type: ContextType): string {
    try {
      const bundledPath = this.getBundledContextPath(type)
      if (existsSync(bundledPath)) {
        return readFileSync(bundledPath, 'utf-8')
      }
      return ''
    } catch {
      return ''
    }
  }

  /**
   * Assemble the full system prompt from a profile's context files.
   * Used by LlmService to build the conversation's system message, from the
   * conversation's own profile (see resolveProfileId for the fallback).
   */
  assembleSystemPrompt(profileId?: string | null): string {
    const resolvedProfileId = this.resolveProfileId(profileId)
    const parts: string[] = []

    const systemContent = this.readContextTrimmed(resolvedProfileId, 'system')
    if (systemContent) {
      parts.push(systemContent)
    }

    const userContent = this.readContextTrimmed(resolvedProfileId, 'user')
    if (userContent && !isPlaceholderComment(userContent)) {
      parts.push(`\n## User Context\n${userContent}`)
    }

    const orgContent = this.readContextTrimmed(resolvedProfileId, 'org')
    if (orgContent && !isPlaceholderComment(orgContent)) {
      parts.push(`\n## Organization Context\n${orgContent}`)
    }

    return parts.join('\n') || 'You are a helpful assistant.'
  }

  private getProfilesDir(): string {
    return join(this.contextDir, PROFILES_DIR_NAME)
  }

  private getProfileStatePath(): string {
    return join(this.contextDir, PROFILE_STATE_FILE)
  }

  private getBundledContextPath(type: ContextType): string {
    return join(this.bundledDir, CONTEXT_FILES[type])
  }

  private getLegacyContextPath(type: ContextType): string {
    return join(this.contextDir, CONTEXT_FILES[type])
  }

  private getProfileDir(profileId: string): string {
    return join(this.getProfilesDir(), profileId)
  }

  private getProfileContextPath(profileId: string, type: ContextType): string {
    return join(this.getProfileDir(profileId), CONTEXT_FILES[type])
  }

  private getActiveProfileContextPath(type: ContextType): string {
    return this.getProfileContextPath(this.profileState.activeProfileId, type)
  }

  private loadProfileState(): ContextProfileState {
    const statePath = this.getProfileStatePath()

    if (!existsSync(statePath)) {
      return this.createInitialProfileState()
    }

    try {
      const raw = readFileSync(statePath, 'utf-8')
      const parsed = JSON.parse(raw) as PersistedProfileState
      const sanitized = sanitizeProfileState(parsed)
      this.persistProfileState(sanitized)
      return sanitized
    } catch {
      return this.createInitialProfileState()
    }
  }

  private createInitialProfileState(): ContextProfileState {
    const initial: ContextProfileState = {
      profiles: [{ ...DEFAULT_PROFILE }],
      activeProfileId: DEFAULT_PROFILE.id
    }

    this.initializeDefaultProfileFromLegacyOrBundled()
    this.persistProfileState(initial)
    return initial
  }

  private initializeDefaultProfileFromLegacyOrBundled(): void {
    const defaultProfileDir = this.getProfileDir(DEFAULT_PROFILE.id)
    this.ensureDirectory(defaultProfileDir)

    for (const type of CONTEXT_TYPES) {
      const targetPath = this.getProfileContextPath(DEFAULT_PROFILE.id, type)
      if (existsSync(targetPath)) continue

      const legacyPath = this.getLegacyContextPath(type)
      if (existsSync(legacyPath)) {
        copyFileSync(legacyPath, targetPath)
        continue
      }

      const bundledPath = this.getBundledContextPath(type)
      if (existsSync(bundledPath)) {
        copyFileSync(bundledPath, targetPath)
      } else {
        writeFileSync(targetPath, '', 'utf-8')
      }
    }
  }

  private ensureAllProfileContextFiles(): void {
    for (const profile of this.profileState.profiles) {
      const seedMode: ProfileSeedMode = profile.id === DEFAULT_PROFILE.id ? 'bundled' : 'blank'
      this.ensureProfileContextFiles(profile.id, seedMode)
    }
  }

  private ensureProfileContextFiles(profileId: string, seedMode: ProfileSeedMode): void {
    const profileDir = this.getProfileDir(profileId)
    this.ensureDirectory(profileDir)

    for (const type of CONTEXT_TYPES) {
      const targetPath = this.getProfileContextPath(profileId, type)
      if (existsSync(targetPath)) continue

      if (seedMode === 'bundled') {
        const bundledPath = this.getBundledContextPath(type)
        if (existsSync(bundledPath)) {
          copyFileSync(bundledPath, targetPath)
          continue
        }
      }

      writeFileSync(targetPath, '', 'utf-8')
    }
  }

  private readContextTrimmed(profileId: string, type: ContextType): string {
    try {
      const filePath = this.getProfileContextPath(profileId, type)
      if (existsSync(filePath)) {
        return readFileSync(filePath, 'utf-8').trim()
      }
    } catch {
      // ignore
    }
    return ''
  }

  private createUniqueProfileId(name: string): string {
    const existingIds = new Set(this.profileState.profiles.map((profile) => profile.id))
    const base = slugifyProfileName(name) || 'profile'
    let candidate = base
    let suffix = 2

    while (existingIds.has(candidate)) {
      candidate = `${base}-${suffix}`
      suffix++
    }

    return candidate
  }

  private persistProfileState(state: ContextProfileState = this.profileState): void {
    writeFileSync(this.getProfileStatePath(), JSON.stringify(state, null, 2), 'utf-8')
  }

  private ensureDirectory(path: string): void {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true })
    }
  }
}

function sanitizeProfileState(raw: unknown): ContextProfileState {
  const source = raw && typeof raw === 'object'
    ? raw as PersistedProfileState
    : {}

  const profiles: ContextProfile[] = []
  const seenIds = new Set<string>()
  const rawProfiles = Array.isArray(source.profiles) ? source.profiles : []

  for (const candidate of rawProfiles) {
    if (!candidate || typeof candidate !== 'object') continue

    const id = sanitizeProfileId(candidate.id)
    const name = normalizeProfileName(candidate.name)
    if (!id || !name || seenIds.has(id)) continue

    profiles.push({ id, name })
    seenIds.add(id)
  }

  if (!seenIds.has(DEFAULT_PROFILE.id)) {
    profiles.unshift({ ...DEFAULT_PROFILE })
    seenIds.add(DEFAULT_PROFILE.id)
  }

  if (profiles.length === 0) {
    profiles.push({ ...DEFAULT_PROFILE })
  }

  const requestedActive = sanitizeProfileId(source.activeProfileId)
  const activeProfileId = requestedActive && seenIds.has(requestedActive)
    ? requestedActive
    : (profiles.find((profile) => profile.id === DEFAULT_PROFILE.id)?.id || profiles[0].id)

  return { profiles, activeProfileId }
}

function sanitizeProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0) return null
  if (!/^[a-z0-9-]+$/.test(trimmed)) return null
  return trimmed
}

function slugifyProfileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

function normalizeProfileName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, PROFILE_NAME_MAX_LENGTH)
}

/**
 * Check if content is only HTML comments (the default placeholder).
 * We skip these to avoid injecting empty sections into the system prompt.
 */
function isPlaceholderComment(content: string): boolean {
  return content.replace(/<!--[\s\S]*?-->/g, '').trim().length === 0
}
