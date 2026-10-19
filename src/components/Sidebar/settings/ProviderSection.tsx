import { Star } from 'lucide-react'
import type { ProviderName, ProviderSettings, Settings } from '@/types'
import {
  INLINE_LABEL_CLASS,
  LABEL_CLASS,
  SMALL_BUTTON_CLASS,
  SectionToggle,
  type SettingsSectionProps
} from './controls'
import {
  PROVIDERS,
  PROVIDERS_ALLOW_BLANK_MODEL,
  PROVIDERS_WITHOUT_API_KEY,
  PROVIDER_DEFAULT_BASE_URLS,
  PROVIDER_PREFERRED_MODELS
} from './providerDefaults'
import type { ProviderModelsState } from './useProviderModels'

type ProviderSectionProps = SettingsSectionProps & ProviderModelsState

export function ProviderSection({
  settings,
  saveSettings,
  models,
  modelsLoading,
  modelsFetchFailed,
  refreshModels
}: ProviderSectionProps) {
  const activeProvider = settings.providers[settings.activeProvider]
  const activeProviderModel = activeProvider.selectedModel !== undefined
    ? activeProvider.selectedModel
    : (PROVIDER_PREFERRED_MODELS[settings.activeProvider] || '')

  const saveActiveProvider = (patch: Partial<ProviderSettings>, extra: Partial<Settings> = {}) =>
    saveSettings({
      ...settings,
      ...extra,
      providers: {
        ...settings.providers,
        [settings.activeProvider]: { ...activeProvider, ...patch }
      }
    })

  const saveActiveProviderModel = (model: string) => {
    const trimmed = model.trim()
    const allowBlank = PROVIDERS_ALLOW_BLANK_MODEL.has(settings.activeProvider)
    if (!allowBlank && trimmed.length === 0) return
    saveActiveProvider({ selectedModel: trimmed }, trimmed ? { defaultModel: trimmed } : {})
  }

  const favoriteModels = activeProvider.favoriteModels ?? []
  const isActiveModelFavorite = favoriteModels.includes(activeProviderModel)
  // Follow the (already sorted) model list order rather than starring order.
  // Favorites are also kept in "All models" so the full list stays complete.
  const listedFavoriteModels = models.filter((m) => favoriteModels.includes(m))
  const toggleActiveModelFavorite = () => {
    const model = activeProviderModel.trim()
    if (!model) return
    saveActiveProvider({
      favoriteModels: isActiveModelFavorite
        ? favoriteModels.filter((m) => m !== model)
        : [...favoriteModels, model]
    })
  }

  return (
    <>
      <SectionToggle
        label="Provider"
        expanded={settings.providerSectionExpanded}
        onToggle={() =>
          saveSettings({ ...settings, providerSectionExpanded: !settings.providerSectionExpanded })
        }
      />

      {settings.providerSectionExpanded && (
        <>
          {/* Provider Selection */}
          <div>
            <label className={LABEL_CLASS}>Provider</label>
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
              className="select select-sm w-full"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          {!PROVIDERS_WITHOUT_API_KEY.has(settings.activeProvider) && (
            <div>
              <label className={LABEL_CLASS}>API Key</label>
              <input
                type="password"
                value={activeProvider.apiKey}
                onChange={(e) => saveActiveProvider({ apiKey: e.target.value })}
                placeholder={settings.activeProvider === 'custom' ? 'Optional' : 'sk-...'}
                className="input input-sm w-full"
              />
            </div>
          )}

          {/* LM Studio Compatibility */}
          {settings.activeProvider === 'lmstudio' && (
            <div>
              <label className={LABEL_CLASS}>Compatibility</label>
              <select
                value={activeProvider.compatibility || 'openai'}
                onChange={(e) =>
                  saveActiveProvider({ compatibility: e.target.value as 'openai' | 'lmstudio' })
                }
                className="select select-sm w-full"
              >
                <option value="openai">OpenAI Endpoints</option>
                <option value="lmstudio">LM Studio Endpoints</option>
              </select>
            </div>
          )}

          {/* Base URL */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className={INLINE_LABEL_CLASS}>Base URL</label>
              <button
                type="button"
                onClick={() => {
                  refreshModels()
                  saveActiveProvider({ baseUrl: PROVIDER_DEFAULT_BASE_URLS[settings.activeProvider] })
                }}
                className={SMALL_BUTTON_CLASS}
              >
                Reset
              </button>
            </div>
            <input
              type="text"
              value={activeProvider.baseUrl}
              onChange={(e) => saveActiveProvider({ baseUrl: e.target.value })}
              className="input input-sm w-full text-xs"
            />
            {settings.activeProvider === 'custom' && (
              <p className="mt-1 text-[10px] text-soft-charcoal/45">
                Any server with an OpenAI-style API (llama.cpp, vLLM, Jan...). Include the path up to /v1.
              </p>
            )}
          </div>

          {/* Default Model */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className={INLINE_LABEL_CLASS}>Model</label>
              <button
                type="button"
                onClick={refreshModels}
                disabled={modelsLoading}
                className={SMALL_BUTTON_CLASS}
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
                    placeholder={PROVIDER_PREFERRED_MODELS[settings.activeProvider] ?? 'Model ID'}
                    className="input input-sm flex-1 min-w-0"
                  />
                ) : (
                  <select
                    value={activeProviderModel}
                    onChange={(e) => saveActiveProviderModel(e.target.value)}
                    className="select select-sm flex-1 min-w-0"
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
                          {models.map((m) => (
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
                  className={`btn btn-ghost btn-sm h-8 min-h-0 w-8 p-0 shrink-0 disabled:text-soft-charcoal/20 ${isActiveModelFavorite ? 'text-rca-red' : 'text-soft-charcoal/40 hover:text-soft-charcoal/70'}`}
                >
                  <Star size={14} fill={isActiveModelFavorite ? 'currentColor' : 'none'} />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}
