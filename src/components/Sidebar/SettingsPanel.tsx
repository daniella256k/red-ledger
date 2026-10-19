import { useSettingsStore } from '@/store'
import { SectionToggle } from './settings/controls'
import { useProviderModels } from './settings/useProviderModels'
import { ProviderSection } from './settings/ProviderSection'
import { SearchSection } from './settings/SearchSection'
import { McpConnectionsSection } from './settings/McpConnectionsSection'
import { AdvancedSection } from './settings/AdvancedSection'
import { DarkModeCard } from './settings/DarkModeCard'

export function SettingsPanel() {
  const settings = useSettingsStore((s) => s.settings)
  const isLoading = useSettingsStore((s) => s.isLoading)
  const error = useSettingsStore((s) => s.error)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const saveSettings = useSettingsStore((s) => s.saveSettings)
  const providerModels = useProviderModels(settings, saveSettings)

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

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <ProviderSection settings={settings} saveSettings={saveSettings} {...providerModels} />
        <SearchSection settings={settings} saveSettings={saveSettings} />

        <SectionToggle
          label="Connections"
          expanded={settings.connectionsSectionExpanded}
          onToggle={() =>
            saveSettings({ ...settings, connectionsSectionExpanded: !settings.connectionsSectionExpanded })
          }
        />
        {settings.connectionsSectionExpanded && (
          <McpConnectionsSection settings={settings} saveSettings={saveSettings} />
        )}

        <AdvancedSection settings={settings} saveSettings={saveSettings} />
      </div>

      <div className="mt-auto border-t border-weathered/80 bg-base-200/35 p-3">
        <DarkModeCard settings={settings} saveSettings={saveSettings} />
      </div>
    </div>
  )
}
