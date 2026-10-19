import { useEffect, useRef, useState } from 'react'
import type { Settings } from '@/types'
import { resolveProviderModel } from './providerDefaults'

const NO_MODELS: string[] = []

export interface ProviderModelsState {
  models: string[]
  modelsLoading: boolean
  modelsFetchFailed: boolean
  refreshModels: () => void
}

/**
 * Fetches the active provider's model list and keeps the saved model
 * selection and favorites consistent with it. Runs from the panel (not the
 * Provider section) so the selection stays synced while that section is collapsed.
 */
export function useProviderModels(
  settings: Settings | null,
  saveSettings: (settings: Settings) => void
): ProviderModelsState {
  const [modelsRefreshNonce, setModelsRefreshNonce] = useState(0)
  // The last fetch, tagged with the request it answers; until the tag matches
  // the current request, the list is loading.
  const [fetched, setFetched] = useState<{ key: string; models: string[]; failed: boolean } | null>(null)
  const lastSyncedModelFetchKeyRef = useRef('')
  const activeProviderConfig = settings
    ? settings.providers[settings.activeProvider]
    : null
  const modelFetchKey = settings && activeProviderConfig
    ? `${settings.activeProvider}|${activeProviderConfig.baseUrl}|${activeProviderConfig.apiKey}|${activeProviderConfig.compatibility || ''}`
    : ''
  const refreshModels = () => setModelsRefreshNonce((n) => n + 1)
  const requestKey = `${modelsRefreshNonce}|${modelFetchKey}`
  const canFetch = Boolean(settings && window.redLedger)
  const current = fetched?.key === requestKey ? fetched : null
  const models = current?.models ?? NO_MODELS
  const modelsLoading = canFetch && current === null
  const modelsFetchFailed = current?.failed ?? false

  // Fetch models when provider identity/config changes.
  useEffect(() => {
    if (!settings || !window.redLedger) return
    let cancelled = false
    const didConfigChange = lastSyncedModelFetchKeyRef.current !== modelFetchKey
    lastSyncedModelFetchKeyRef.current = modelFetchKey

    const timer = setTimeout(() => {
      ;(async () => {
        if (didConfigChange) {
          await window.redLedger.saveSettings(settings)
        }
        return window.redLedger.listModels(settings.activeProvider)
      })()
        .then((list) => {
          if (!cancelled) setFetched({ key: requestKey, models: list, failed: false })
        })
        .catch(() => {
          if (!cancelled) setFetched({ key: requestKey, models: NO_MODELS, failed: true })
        })
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

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

  return { models, modelsLoading, modelsFetchFailed, refreshModels }
}
