import { useState, useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, CircleHelp, Moon, Star, Sun } from 'lucide-react'
import { useSettingsStore } from '@/store'
import type { ProviderName } from '@/types'

const PROVIDERS: { id: ProviderName; label: string }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'lmstudio', label: 'LM Studio' }
]

const PROVIDERS_ALLOW_BLANK_MODEL = new Set<ProviderName>([
  'openai',
  'openrouter',
  'ollama',
  'lmstudio'
])

const PROVIDER_PREFERRED_MODELS: Partial<Record<ProviderName, string>> = {
  openai: 'moonshotai/kimi-k2.5',
  openrouter: 'moonshotai/kimi-k2.5'
}

const PROVIDER_DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234'
}

function resolveProviderModel(
  provider: ProviderName,
  currentModel: string | undefined,
  availableModels: string[]
): string | undefined {
  if (availableModels.length === 0) return currentModel

  if (currentModel && availableModels.includes(currentModel)) {
    return currentModel
  }

  const preferred = PROVIDER_PREFERRED_MODELS[provider]
  if (preferred && availableModels.includes(preferred)) {
    return preferred
  }

  return availableModels[0]
}

export function SettingsPanel() {
  const settings = useSettingsStore((s) => s.settings)
  const isLoading = useSettingsStore((s) => s.isLoading)
  const error = useSettingsStore((s) => s.error)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const saveSettings = useSettingsStore((s) => s.saveSettings)

  const [models, setModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsFetchFailed, setModelsFetchFailed] = useState(false)
  const [modelsRefreshNonce, setModelsRefreshNonce] = useState(0)
  const lastSyncedModelFetchKeyRef = useRef('')
  const activeProviderConfig = settings
    ? settings.providers[settings.activeProvider]
    : null
  const modelFetchKey = settings && activeProviderConfig
    ? `${settings.activeProvider}|${activeProviderConfig.baseUrl}|${activeProviderConfig.apiKey}|${activeProviderConfig.compatibility || ''}`
    : ''
  const activeProviderName = settings?.activeProvider
  const activeProviderModel = activeProviderConfig
    ? (activeProviderConfig.selectedModel !== undefined
      ? activeProviderConfig.selectedModel
      : (activeProviderName ? (PROVIDER_PREFERRED_MODELS[activeProviderName] || '') : ''))
    : ''
  const refreshModels = () => setModelsRefreshNonce((n) => n + 1)

  // Fetch models when provider identity/config changes.
  useEffect(() => {
    if (!settings || !window.redLedger) return
    let cancelled = false
    const didConfigChange = lastSyncedModelFetchKeyRef.current !== modelFetchKey
    lastSyncedModelFetchKeyRef.current = modelFetchKey

    setModels([])
    setModelsFetchFailed(false)
    setModelsLoading(true)

    const timer = setTimeout(() => {
      ;(async () => {
        if (didConfigChange) {
          await window.redLedger.saveSettings(settings)
        }
        return window.redLedger.listModels(settings.activeProvider)
      })()
        .then((list) => {
          if (cancelled) return
          setModels(list)
          setModelsFetchFailed(false)
        })
        .catch(() => {
          if (cancelled) return
          setModelsFetchFailed(true)
        })
        .finally(() => {
          if (!cancelled) setModelsLoading(false)
        })
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelFetchKey, settings?.activeProvider, modelsRefreshNonce])

  // Keep the active provider's selected model sane relative to the latest list.
  useEffect(() => {
    if (!settings || !activeProviderConfig || modelsLoading || modelsFetchFailed || models.length === 0) {
      return
    }

    const resolvedModel = resolveProviderModel(
      settings.activeProvider,
      activeProviderConfig.selectedModel,
      models
    )

    if (!resolvedModel) return

    // Favorites that the provider no longer offers are dropped silently.
    const currentFavorites = activeProviderConfig.favoriteModels ?? []
    const availableFavorites = currentFavorites.filter((m) => models.includes(m))

    const sameSelected = activeProviderConfig.selectedModel === resolvedModel
    const sameDefault = settings.defaultModel === resolvedModel
    const sameModels = JSON.stringify(activeProviderConfig.models) === JSON.stringify(models)
    const sameFavorites = availableFavorites.length === currentFavorites.length
    if (sameSelected && sameDefault && sameModels && sameFavorites) {
      return
    }

    saveSettings({
      ...settings,
      defaultModel: resolvedModel,
      providers: {
        ...settings.providers,
        [settings.activeProvider]: {
          ...activeProviderConfig,
          models,
          selectedModel: resolvedModel,
          favoriteModels: availableFavorites
        }
      }
    })
  }, [
    settings,
    activeProviderConfig,
    models,
    modelsLoading,
    modelsFetchFailed,
    saveSettings
  ])

  if (!settings) {
    return (
      <div className="p-4 text-sm text-soft-charcoal/50 space-y-2">
        {isLoading ? (
          <div className="flex items-center gap-2">
            <span className="loading loading-spinner loading-xs text-rca-red" />
            <span>Loading settings...</span>
          </div>
        ) : error ? (
          <>
            <p className="text-error text-xs">{error}</p>
            <button onClick={() => loadSettings()} className="btn btn-xs btn-primary">
              Retry
            </button>
          </>
        ) : (
          <span>Loading settings...</span>
        )}
      </div>
    )
  }

  const activeProvider = settings.providers[settings.activeProvider]
  const saveActiveProviderModel = (model: string) => {
    const trimmed = model.trim()
    const allowBlank = PROVIDERS_ALLOW_BLANK_MODEL.has(settings.activeProvider)
    if (!allowBlank && trimmed.length === 0) return
    const nextModel = trimmed

    saveSettings({
      ...settings,
      ...(nextModel ? { defaultModel: nextModel } : {}),
      providers: {
        ...settings.providers,
        [settings.activeProvider]: {
          ...activeProvider,
          selectedModel: nextModel
        }
      }
    })
  }

  const favoriteModels = activeProvider.favoriteModels ?? []
  const isActiveModelFavorite = favoriteModels.includes(activeProviderModel)
  // Follow the (already sorted) model list order rather than starring order.
  const listedFavoriteModels = models.filter((m) => favoriteModels.includes(m))
  const otherModels = models.filter((m) => !favoriteModels.includes(m))
  const toggleActiveModelFavorite = () => {
    const model = activeProviderModel.trim()
    if (!model) return

    saveSettings({
      ...settings,
      providers: {
        ...settings.providers,
        [settings.activeProvider]: {
          ...activeProvider,
          favoriteModels: isActiveModelFavorite
            ? favoriteModels.filter((m) => m !== model)
            : [...favoriteModels, model]
        }
      }
    })
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <button
          type="button"
          aria-expanded={settings.providerSectionExpanded}
          onClick={() =>
            saveSettings({
              ...settings,
              providerSectionExpanded: !settings.providerSectionExpanded
            })
          }
          className="divider text-[10px] text-soft-charcoal/30 uppercase tracking-widest my-1 w-full cursor-pointer bg-transparent border-0 p-0 hover:text-soft-charcoal/50 transition-colors"
        >
          <span className="inline-flex items-center gap-1">
            {settings.providerSectionExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Provider
          </span>
        </button>

        {settings.providerSectionExpanded && (
          <>
            {/* Provider Selection */}
            <div>
              <label className="text-[11px] font-medium text-soft-charcoal/60 mb-1 block uppercase tracking-wide">
                Provider
              </label>
              <select
                value={settings.activeProvider}
                onChange={(e) => {
                  const nextProvider = e.target.value as ProviderName
                  const remembered = settings.providers[nextProvider].selectedModel
                  saveSettings({
                    ...settings,
                    activeProvider: nextProvider,
                    ...(remembered ? { defaultModel: remembered } : {})
                  })
                }}
                className="select select-sm select-bordered w-full bg-base-100"
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>

            {/* API Key */}
            {settings.activeProvider !== 'ollama' && settings.activeProvider !== 'lmstudio' && (
              <div>
                <label className="text-[11px] font-medium text-soft-charcoal/60 mb-1 block uppercase tracking-wide">
                  API Key
                </label>
                <input
                  type="password"
                  value={activeProvider.apiKey}
                  onChange={(e) =>
                    saveSettings({
                      ...settings,
                      providers: {
                        ...settings.providers,
                        [settings.activeProvider]: {
                          ...activeProvider,
                          apiKey: e.target.value
                        }
                      }
                    })
                  }
                  placeholder="sk-..."
                  className="input input-sm input-bordered w-full bg-base-100"
                />
              </div>
            )}

            {/* LM Studio Compatibility */}
            {settings.activeProvider === 'lmstudio' && (
              <div>
                <label className="text-[11px] font-medium text-soft-charcoal/60 mb-1 block uppercase tracking-wide">
                  Compatibility
                </label>
                <select
                  value={activeProvider.compatibility || 'openai'}
                  onChange={(e) =>
                    saveSettings({
                      ...settings,
                      providers: {
                        ...settings.providers,
                        lmstudio: {
                          ...activeProvider,
                          compatibility: e.target.value as 'openai' | 'lmstudio'
                        }
                      }
                    })
                  }
                  className="select select-sm select-bordered w-full bg-base-100"
                >
                  <option value="openai">OpenAI Endpoints</option>
                  <option value="lmstudio">LM Studio Endpoints</option>
                </select>
              </div>
            )}

            {/* Base URL */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide">
                  Base URL
                </label>
                <button
                  type="button"
                  onClick={() => {
                    refreshModels()
                    saveSettings({
                      ...settings,
                      providers: {
                        ...settings.providers,
                        [settings.activeProvider]: {
                          ...activeProvider,
                          baseUrl: PROVIDER_DEFAULT_BASE_URLS[settings.activeProvider]
                        }
                      }
                    })
                  }}
                  className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-[10px] uppercase tracking-wide"
                >
                  Reset
                </button>
              </div>
              <input
                type="text"
                value={activeProvider.baseUrl}
                onChange={(e) =>
                  saveSettings({
                    ...settings,
                    providers: {
                      ...settings.providers,
                      [settings.activeProvider]: {
                        ...activeProvider,
                        baseUrl: e.target.value
                      }
                    }
                  })
                }
                className="input input-sm input-bordered w-full bg-base-100 text-xs"
              />
            </div>

            {/* Default Model */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide">
                  Model
                </label>
                <button
                  type="button"
                  onClick={refreshModels}
                  disabled={modelsLoading}
                  className="btn btn-ghost btn-xs h-6 min-h-0 px-2 text-[10px] uppercase tracking-wide"
                >
                  Refresh
                </button>
              </div>
              {modelsLoading ? (
                <div className="flex items-center gap-2 h-8">
                  <span className="loading loading-spinner loading-xs text-rca-red" />
                  <span className="text-xs text-soft-charcoal/40">Loading models...</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  {modelsFetchFailed || models.length === 0 ? (
                    <input
                      type="text"
                      value={activeProviderModel}
                      onChange={(e) => saveActiveProviderModel(e.target.value)}
                      placeholder="moonshotai/kimi-k2.5"
                      className="input input-sm input-bordered flex-1 min-w-0 bg-base-100"
                    />
                  ) : (
                    <select
                      value={activeProviderModel}
                      onChange={(e) => saveActiveProviderModel(e.target.value)}
                      className="select select-sm select-bordered flex-1 min-w-0 bg-base-100"
                    >
                      {!models.includes(activeProviderModel) && activeProviderModel && (
                        <option value={activeProviderModel}>{activeProviderModel}</option>
                      )}
                      {listedFavoriteModels.length > 0 ? (
                        <>
                          <optgroup label="Favorites">
                            {listedFavoriteModels.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </optgroup>
                          <optgroup label="All models">
                            {otherModels.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </optgroup>
                        </>
                      ) : (
                        models.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))
                      )}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={toggleActiveModelFavorite}
                    disabled={!activeProviderModel.trim()}
                    aria-pressed={isActiveModelFavorite}
                    title={isActiveModelFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    className={`btn btn-ghost btn-sm h-8 min-h-0 w-8 p-0 shrink-0 ${isActiveModelFavorite ? 'text-rca-red' : 'text-soft-charcoal/40 hover:text-soft-charcoal/70'}`}
                  >
                    <Star size={14} fill={isActiveModelFavorite ? 'currentColor' : 'none'} />
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        <button
          type="button"
          aria-expanded={settings.searchSectionExpanded}
          onClick={() =>
            saveSettings({
              ...settings,
              searchSectionExpanded: !settings.searchSectionExpanded
            })
          }
          className="divider text-[10px] text-soft-charcoal/30 uppercase tracking-widest my-1 w-full cursor-pointer bg-transparent border-0 p-0 hover:text-soft-charcoal/50 transition-colors"
        >
          <span className="inline-flex items-center gap-1">
            {settings.searchSectionExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Search
          </span>
        </button>

        {settings.searchSectionExpanded && (
          <>
            <div className="flex items-center justify-between py-0.5">
              <label className="text-[11px] font-medium text-soft-charcoal/60 uppercase tracking-wide">
                Search
              </label>
              <div className="flex items-center gap-2">
                <span
                  className="text-soft-charcoal/40 hover:text-soft-charcoal/60 cursor-help"
                  title="Enable web search through Tavily or SerpApi."
                  aria-label="Search tools help"
                >
                  <CircleHelp size={12} />
                </span>
                <input
                  type="checkbox"
                  checked={settings.searchToolsEnabled}
                  onChange={(e) => saveSettings({ ...settings, searchToolsEnabled: e.target.checked })}
                  className="toggle toggle-sm toggle-primary"
                />
              </div>
            </div>

            <fieldset disabled={!settings.searchToolsEnabled} className="space-y-3 disabled:opacity-45">
              {/* Tavily Key */}
              <div>
                <label className="text-[11px] font-medium text-soft-charcoal/60 mb-1 block uppercase tracking-wide">
                  Tavily API Key
                </label>
                <input
                  type="password"
                  value={settings.tavilyApiKey}
                  onChange={(e) => saveSettings({ ...settings, tavilyApiKey: e.target.value })}
                  placeholder="tvly-..."
                  className="input input-sm input-bordered w-full bg-base-100"
                />
              </div>

              {/* SerpAPI Key */}
              <div>
                <label className="text-[11px] font-medium text-soft-charcoal/60 mb-1 block uppercase tracking-wide">
                  SerpAPI Key
                </label>
                <input
                  type="password"
                  value={settings.serpApiKey}
                  onChange={(e) => saveSettings({ ...settings, serpApiKey: e.target.value })}
                  className="input input-sm input-bordered w-full bg-base-100"
                />
              </div>

              {/* Org Site */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide">
                    Org Site
                  </label>
                  <span
                    className="text-soft-charcoal/40 hover:text-soft-charcoal/60 cursor-help"
                    title="Optional. Allows search through a specific source by applying site:example.com."
                    aria-label="Org Site help"
                  >
                    <CircleHelp size={12} />
                  </span>
                </div>
                <input
                  type="text"
                  value={settings.orgSite}
                  onChange={(e) => saveSettings({ ...settings, orgSite: e.target.value })}
                  placeholder="example.com"
                  className="input input-sm input-bordered w-full bg-base-100"
                />
              </div>
            </fieldset>
          </>
        )}

        <button
          type="button"
          aria-expanded={settings.advancedSectionExpanded}
          onClick={() =>
            saveSettings({
              ...settings,
              advancedSectionExpanded: !settings.advancedSectionExpanded
            })
          }
          className="divider text-[10px] text-soft-charcoal/30 uppercase tracking-widest my-1 w-full cursor-pointer bg-transparent border-0 p-0 hover:text-soft-charcoal/50 transition-colors"
        >
          <span className="inline-flex items-center gap-1">
            {settings.advancedSectionExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Advanced
          </span>
        </button>

        {settings.advancedSectionExpanded && (
          <>
            {/* Reasoning */}
            <div className="flex items-center justify-between py-0.5">
              <label className="text-[11px] font-medium text-soft-charcoal/60 uppercase tracking-wide">
                Reasoning
              </label>
              <div className="flex items-center gap-2">
                <span
                  className="text-soft-charcoal/40 hover:text-soft-charcoal/60 cursor-help"
                  title="Allow reasoning effort."
                  aria-label="Reasoning help"
                >
                  <CircleHelp size={12} />
                </span>
                <input
                  type="checkbox"
                  checked={settings.reasoningEnabled}
                  onChange={(e) => saveSettings({ ...settings, reasoningEnabled: e.target.checked })}
                  className="toggle toggle-sm toggle-primary"
                />
              </div>
            </div>

            {/* Temperature */}
            <div>
              <div className="flex items-center justify-between py-0.5 mb-1">
                <label className="text-[11px] font-medium text-soft-charcoal/60 uppercase tracking-wide">
                  Temperature
                </label>
                <div className="flex items-center gap-2">
                  <span
                    className="text-soft-charcoal/40 hover:text-soft-charcoal/60 cursor-help"
                    title="Controls style and creativity."
                    aria-label="Temperature help"
                  >
                    <CircleHelp size={12} />
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.temperatureEnabled}
                    onChange={(e) => saveSettings({ ...settings, temperatureEnabled: e.target.checked })}
                    className="toggle toggle-sm toggle-primary"
                  />
                </div>
              </div>
              <label className="text-[11px] font-medium text-soft-charcoal/60 mb-1 flex justify-between uppercase tracking-wide">
                <span>Value</span>
                <span className={`normal-case tabular-nums ${settings.temperatureEnabled ? 'text-rca-red' : 'text-soft-charcoal/40'}`}>
                  {settings.temperature.toFixed(1)}
                </span>
              </label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={settings.temperature}
                disabled={!settings.temperatureEnabled}
                onChange={(e) =>
                  saveSettings({ ...settings, temperature: parseFloat(e.target.value) })
                }
                className={`range range-xs range-primary w-full ${settings.temperatureEnabled ? '' : 'opacity-40 cursor-not-allowed'}`}
              />
            </div>

            {/* Max Tokens */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide">
                  Max Tokens
                </label>
                <div className="flex items-center gap-2">
                  <span
                    className="text-soft-charcoal/40 hover:text-soft-charcoal/60 cursor-help"
                    title="Sets the assistant response output length."
                    aria-label="Max Tokens help"
                  >
                    <CircleHelp size={12} />
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.maxTokensEnabled}
                    onChange={(e) => saveSettings({ ...settings, maxTokensEnabled: e.target.checked })}
                    className="toggle toggle-sm toggle-primary"
                  />
                </div>
              </div>
              <input
                type="number"
                min={1}
                max={128000}
                value={settings.maxTokens}
                disabled={!settings.maxTokensEnabled}
                onChange={(e) =>
                  saveSettings({ ...settings, maxTokens: parseInt(e.target.value, 10) || 8192 })
                }
                className={`input input-sm input-bordered w-full bg-base-100 ${settings.maxTokensEnabled ? '' : 'opacity-40 cursor-not-allowed'}`}
              />
            </div>

            {/* Strict Mode */}
            <div className="flex items-center justify-between py-0.5">
              <label className="text-[11px] font-medium text-soft-charcoal/60 uppercase tracking-wide">
                Strict Mode
              </label>
              <div className="flex items-center gap-2">
                <span
                  className="text-soft-charcoal/40 hover:text-soft-charcoal/60 cursor-help"
                  title="Asks for permission on file operations."
                  aria-label="Strict Mode help"
                >
                  <CircleHelp size={12} />
                </span>
                <input
                  type="checkbox"
                  checked={settings.strictMode}
                  onChange={(e) => saveSettings({ ...settings, strictMode: e.target.checked })}
                  className="toggle toggle-sm toggle-primary"
                />
              </div>
            </div>
          </>
        )}

      </div>

      <div className="mt-auto border-t border-weathered/80 bg-base-200/35 p-3">
        <div className="settings-darkmode-card">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-soft-charcoal">
                Dark mode
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-label="Dark mode"
              aria-checked={settings.darkMode}
              data-checked={settings.darkMode}
              onClick={() => saveSettings({ ...settings, darkMode: !settings.darkMode })}
              className="settings-darkmode-switch"
            >
              <Sun size={12} className="settings-darkmode-sun" />
              <Moon size={12} className="settings-darkmode-moon" />
              <span className="settings-darkmode-switch-orb">
                {settings.darkMode ? <Moon size={12} /> : <Sun size={12} />}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
