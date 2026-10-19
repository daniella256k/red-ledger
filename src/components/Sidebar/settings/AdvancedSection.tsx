import { INLINE_LABEL_CLASS, SectionToggle, ToggleRow, type SettingsSectionProps } from './controls'

export function AdvancedSection({ settings, saveSettings }: SettingsSectionProps) {
  return (
    <>
      <SectionToggle
        label="Advanced"
        expanded={settings.advancedSectionExpanded}
        onToggle={() =>
          saveSettings({ ...settings, advancedSectionExpanded: !settings.advancedSectionExpanded })
        }
      />

      {settings.advancedSectionExpanded && (
        <>
          <ToggleRow
            label="Reasoning"
            help="Allow reasoning effort."
            helpLabel="Reasoning help"
            checked={settings.reasoningEnabled}
            onChange={(checked) => saveSettings({ ...settings, reasoningEnabled: checked })}
          />

          {/* Temperature */}
          <div>
            <ToggleRow
              label="Temperature"
              help="Controls style and creativity."
              helpLabel="Temperature help"
              checked={settings.temperatureEnabled}
              onChange={(checked) => saveSettings({ ...settings, temperatureEnabled: checked })}
              className="py-0.5 mb-1"
            />
            <label className={`${INLINE_LABEL_CLASS} mb-1 flex justify-between`}>
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
            <ToggleRow
              label="Max Tokens"
              help="Sets the assistant response output length."
              helpLabel="Max Tokens help"
              checked={settings.maxTokensEnabled}
              onChange={(checked) => saveSettings({ ...settings, maxTokensEnabled: checked })}
              className="mb-1"
            />
            <input
              type="number"
              min={1}
              max={128000}
              value={settings.maxTokens}
              disabled={!settings.maxTokensEnabled}
              onChange={(e) =>
                saveSettings({ ...settings, maxTokens: parseInt(e.target.value, 10) || 8192 })
              }
              className={`input input-sm w-full ${settings.maxTokensEnabled ? '' : 'opacity-40 cursor-not-allowed'}`}
            />
          </div>

          <ToggleRow
            label="Strict Mode"
            help="Asks for permission on file operations and before every connection tool call."
            helpLabel="Strict Mode help"
            checked={settings.strictMode}
            onChange={(checked) => saveSettings({ ...settings, strictMode: checked })}
          />
        </>
      )}
    </>
  )
}
