import { existsSync, readFileSync, writeFileSync } from 'fs'
import type {
  Settings,
  ProviderName,
  ProviderSettings,
  LMStudioCompatibility
} from '../../src/types'

const DEFAULT_FALLBACK_MODEL = 'moonshotai/kimi-k2.5'
const DEFAULT_MAX_TOOL_CALLS = 25
const MIN_MAX_TOOL_CALLS = 1
const MAX_MAX_TOOL_CALLS = 25

const DEFAULT_SETTINGS: Settings = {
  activeProvider: 'openrouter',
  providers: {
    openai: {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      models: []
    },
    openrouter: {
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [],
      selectedModel: DEFAULT_FALLBACK_MODEL
    },
    ollama: {
      apiKey: '',
      baseUrl: 'http://localhost:11434',
      models: []
    },
    lmstudio: {
      apiKey: '',
      baseUrl: 'http://localhost:1234',
      models: [],
      compatibility: 'openai'
    }
  },
  defaultModel: DEFAULT_FALLBACK_MODEL,
  reasoningEnabled: true,
  temperatureEnabled: false,
  temperature: 1.0,
  maxTokensEnabled: false,
  maxTokens: 8192,
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  strictMode: false,
  darkMode: false,
  tavilyApiKey: '',
  serpApiKey: '',
  orgSite: '',
  searchToolsEnabled: true,
  lastWorkspacePath: null,
  providerSectionExpanded: true,
  searchSectionExpanded: true,
  advancedSectionExpanded: false
}

const PROVIDER_NAMES: ProviderName[] = ['openai', 'openrouter', 'ollama', 'lmstudio']
const VALID_PROVIDERS = new Set<ProviderName>(PROVIDER_NAMES)

const LMSTUDIO_COMPATIBILITY = new Set<LMStudioCompatibility>(['openai', 'lmstudio'])

function sanitizeCompatibility(
  value: unknown,
  fallback?: LMStudioCompatibility
): LMStudioCompatibility | undefined {
  if (typeof value === 'string' && LMSTUDIO_COMPATIBILITY.has(value as LMStudioCompatibility)) {
    return value as LMStudioCompatibility
  }
  return fallback
}

/**
 * Domain service for application settings.
 * Owns load/save/sanitize logic. No Electron imports.
 *
 * The caller (IPC handler) is responsible for applying side effects
 * like setting the workspace path — this service just manages data.
 */
export class SettingsService {
  private settingsPath: string
  private currentSettings: Settings

  constructor(settingsPath: string) {
    this.settingsPath = settingsPath
    this.currentSettings = this.loadFromDisk()
  }

  getCurrent(): Settings {
    return this.currentSettings
  }

  load(): Settings {
    this.currentSettings = this.loadFromDisk()
    return this.currentSettings
  }

  save(settings: Settings): Settings {
    const sanitized = sanitizeSettings(settings)
    writeFileSync(this.settingsPath, JSON.stringify(sanitized, null, 2), 'utf-8')
    this.currentSettings = sanitized
    return sanitized
  }

  private loadFromDisk(): Settings {
    try {
      if (existsSync(this.settingsPath)) {
        const raw = readFileSync(this.settingsPath, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<Settings>
        return sanitizeSettings(parsed)
      }
    } catch {
      // Corrupted settings file — use defaults
    }
    return sanitizeSettings(undefined)
  }
}

// ─── Sanitization (exported for testing) ────────────────────────────────────

function sanitizeProviderSettings(value: unknown, defaults: ProviderSettings): ProviderSettings {
  const raw = value && typeof value === 'object'
    ? value as Partial<ProviderSettings>
    : {}

  const models = Array.isArray(raw.models)
    ? raw.models.filter((m): m is string => typeof m === 'string')
    : defaults.models

  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : defaults.apiKey,
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.trim().length > 0
      ? raw.baseUrl
      : defaults.baseUrl,
    models,
    compatibility: sanitizeCompatibility(raw.compatibility, defaults.compatibility),
    selectedModel: typeof raw.selectedModel === 'string'
      ? raw.selectedModel
      : defaults.selectedModel
  }
}

export function sanitizeSettings(settings: Partial<Settings> | undefined): Settings {
  const s = settings ?? {}

  const providers = PROVIDER_NAMES.reduce((acc, providerName) => {
    acc[providerName] = sanitizeProviderSettings(
      s.providers?.[providerName],
      DEFAULT_SETTINGS.providers[providerName]
    )
    return acc
  }, {} as Record<ProviderName, ProviderSettings>)

  const activeProvider = VALID_PROVIDERS.has(s.activeProvider as ProviderName)
    ? (s.activeProvider as ProviderName)
    : DEFAULT_SETTINGS.activeProvider

  const defaultModel = typeof s.defaultModel === 'string' && s.defaultModel.trim().length > 0
    ? s.defaultModel
    : DEFAULT_SETTINGS.defaultModel

  const activeRawSelectedModel = typeof s.providers?.[activeProvider]?.selectedModel === 'string'

  // Backward compatibility: migrate legacy global defaultModel into the
  // active provider's selectedModel when no explicit per-provider value exists.
  if (!activeRawSelectedModel) {
    providers[activeProvider] = {
      ...providers[activeProvider],
      selectedModel: defaultModel
    }
  }

  // Clamp temperature: 0–2
  const temperature = typeof s.temperature === 'number' && !isNaN(s.temperature)
    ? Math.round(Math.max(0, Math.min(2, s.temperature)) * 10) / 10
    : DEFAULT_SETTINGS.temperature

  const temperatureEnabled = typeof s.temperatureEnabled === 'boolean'
    ? s.temperatureEnabled
    : DEFAULT_SETTINGS.temperatureEnabled

  const reasoningEnabled = typeof s.reasoningEnabled === 'boolean'
    ? s.reasoningEnabled
    : DEFAULT_SETTINGS.reasoningEnabled

  // Clamp maxTokens: 1–128000
  const maxTokens = typeof s.maxTokens === 'number' && !isNaN(s.maxTokens)
    ? Math.max(1, Math.min(128000, Math.floor(s.maxTokens)))
    : DEFAULT_SETTINGS.maxTokens

  const maxToolCalls = typeof s.maxToolCalls === 'number' && !isNaN(s.maxToolCalls)
    ? Math.max(MIN_MAX_TOOL_CALLS, Math.min(MAX_MAX_TOOL_CALLS, Math.floor(s.maxToolCalls)))
    : DEFAULT_SETTINGS.maxToolCalls

  const maxTokensEnabled = typeof s.maxTokensEnabled === 'boolean'
    ? s.maxTokensEnabled
    : DEFAULT_SETTINGS.maxTokensEnabled

  return {
    activeProvider,
    providers,
    defaultModel,
    reasoningEnabled,
    temperatureEnabled,
    temperature,
    maxTokensEnabled,
    maxTokens,
    maxToolCalls,
    strictMode: typeof s.strictMode === 'boolean' ? s.strictMode : DEFAULT_SETTINGS.strictMode,
    darkMode: typeof s.darkMode === 'boolean' ? s.darkMode : DEFAULT_SETTINGS.darkMode,
    tavilyApiKey: typeof s.tavilyApiKey === 'string' ? s.tavilyApiKey : DEFAULT_SETTINGS.tavilyApiKey,
    serpApiKey: typeof s.serpApiKey === 'string' ? s.serpApiKey : DEFAULT_SETTINGS.serpApiKey,
    orgSite: typeof s.orgSite === 'string' ? s.orgSite : DEFAULT_SETTINGS.orgSite,
    searchToolsEnabled: typeof s.searchToolsEnabled === 'boolean'
      ? s.searchToolsEnabled
      : DEFAULT_SETTINGS.searchToolsEnabled,
    lastWorkspacePath: typeof s.lastWorkspacePath === 'string'
      ? s.lastWorkspacePath
      : null,
    providerSectionExpanded: typeof s.providerSectionExpanded === 'boolean'
      ? s.providerSectionExpanded
      : DEFAULT_SETTINGS.providerSectionExpanded,
    searchSectionExpanded: typeof s.searchSectionExpanded === 'boolean'
      ? s.searchSectionExpanded
      : DEFAULT_SETTINGS.searchSectionExpanded,
    advancedSectionExpanded: typeof s.advancedSectionExpanded === 'boolean'
      ? s.advancedSectionExpanded
      : DEFAULT_SETTINGS.advancedSectionExpanded
  }
}

/**
 * Resolve the settings.json path, checking for portable mode first.
 */
export function resolveSettingsPath(resourcesPath: string, userDataPath: string): string {
  const portablePath = `${resourcesPath}/settings.json`
  if (existsSync(portablePath)) {
    return portablePath
  }
  return `${userDataPath}/settings.json`
}

/**
 * Resolve the database path, checking for portable mode first.
 */
export function resolveDbPath(resourcesPath: string, userDataPath: string): string {
  const settingsPath = `${resourcesPath}/settings.json`
  if (existsSync(settingsPath)) {
    return `${resourcesPath}/conversations.db`
  }
  return `${userDataPath}/conversations.db`
}
