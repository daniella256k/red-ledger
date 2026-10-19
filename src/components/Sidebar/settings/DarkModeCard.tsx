import { Moon, Sun } from 'lucide-react'
import type { SettingsSectionProps } from './controls'

export function DarkModeCard({ settings, saveSettings }: SettingsSectionProps) {
  return (
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
  )
}
