import { useState } from 'react'
import { Star } from 'lucide-react'
import type { ModelOptions, ProviderName, ProviderSettings, Settings, ToolsMode } from '@/types'
import { parseContextWindow, withModelOptions } from '@/lib/modelOptions'
import {
  ApiKeyInput,
  HelpIcon,
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

/** Providers on this computer, whose models can be given a context window. */
const LOCAL_PROVIDERS = new Set<ProviderName>(['ollama', 'lmstudio'])

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

  // Settings for the model picked above; chats on that model use them.
  const activeModelOptions: ModelOptions = activeProvider.modelOptions?.[activeProviderModel.trim()] ?? {}
  const saveActiveModelOptions = (patch: Partial<ModelOptions>) => {
    const model = activeProviderModel.trim()
    if (!model) return
    saveActiveProvider({ modelOptions: withModelOptions(activeProvider.modelOptions, model, patch) })
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
            <ApiKeyInput
              label="API Key"
              value={activeProvider.apiKey}
              onChange={(apiKey) => saveActiveProvider({ apiKey })}
              placeholder={settings.activeProvider === 'custom' ? 'Optional' : 'sk-...'}
            />
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

          {/* The model's own settings */}
          {activeProviderModel.trim() && (
            <div className="flex items-end gap-2">
              {LOCAL_PROVIDERS.has(settings.activeProvider) && (
                <div className="flex-1 min-w-0">
                  <div className="mb-1 flex items-center gap-1 whitespace-nowrap">
                    <label htmlFor="model-context-window" className={INLINE_LABEL_CLASS}>Context window</label>
                    <HelpIcon
                      title="Tokens the model is loaded with. Empty uses the server's own setting. Bigger windows use more memory."
                      label="Context window help"
                    />
                  </div>
                  <ContextWindowInput
                    key={`${settings.activeProvider}|${activeProviderModel}|${activeModelOptions.contextWindow ?? ''}`}
                    value={activeModelOptions.contextWindow}
                    onCommit={(contextWindow) => saveActiveModelOptions({ contextWindow })}
                  />
                </div>
              )}
              <div className={LOCAL_PROVIDERS.has(settings.activeProvider) ? 'w-20 shrink-0' : 'flex-1 min-w-0'}>
                <div className="mb-1 flex items-center gap-1 whitespace-nowrap">
                  <label htmlFor="model-tools" className={INLINE_LABEL_CLASS}>Tools</label>
                  <HelpIcon
                    title="Auto sends tools unless the server says this model can't use them."
                    label="Tools help"
                  />
                </div>
                <select
                  id="model-tools"
                  value={activeModelOptions.tools ?? 'auto'}
                  onChange={(e) => saveActiveModelOptions({ tools: e.target.value as ToolsMode })}
                  className="select select-sm w-full"
                >
                  <option value="auto">Auto</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}

/**
 * Typed freely, saved on Enter or leaving the field: a whole number in range
 * sets the window, an empty field leaves it to the server, anything else goes
 * back to the saved value.
 */
function ContextWindowInput({ value, onCommit }: { value: number | undefined; onCommit: (value: number | undefined) => void }) {
  // Starts from the saved value; the parent's key resets it when that changes.
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))

  const commit = () => {
    if (draft.trim() === '') {
      if (value !== undefined) onCommit(undefined)
      return
    }
    const parsed = parseContextWindow(draft)
    if (parsed === null) setDraft(value === undefined ? '' : String(value))
    else if (parsed !== value) onCommit(parsed)
  }

  return (
    <input
      id="model-context-window"
      type="text"
      inputMode="numeric"
      value={draft}
      placeholder="Server default"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      className="input input-sm w-full"
    />
  )
}
