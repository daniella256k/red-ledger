import { useSettingsStore } from '@/store'

export const LIGHT_THEME = 'red-ledger'
export const DARK_THEME = 'red-ledger-dark'

// public/theme-boot.js puts the theme main.ts passed in the page URL on <html>
// before first paint. Until settings arrive over IPC, that is the answer.
const bootDarkMode = typeof document !== 'undefined'
  && document.documentElement.getAttribute('data-theme') === DARK_THEME

/** Dark mode from settings, or the theme the page booted with until they load. */
export function useDarkMode(): boolean {
  return useSettingsStore((s) => s.settings?.darkMode ?? bootDarkMode)
}
