import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Layout } from './components/Layout'
import { Toaster } from './components/ui/Toast'
import { ExportChatModal } from './components/Chat/ExportChatModal'
import { useConversationStore, useSettingsStore, useUIStore } from './store'
import { DARK_THEME, LIGHT_THEME, useDarkMode } from './hooks/useDarkMode'
import { notify } from './lib/notify'
import { formatError } from './lib/errors'
import type { MenuAction } from './types'

export default function App() {
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const settings = useSettingsStore((s) => s.settings)
  const conversations = useConversationStore((s) => s.conversations)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const darkMode = useDarkMode()
  const activeTheme = darkMode ? DARK_THEME : LIGHT_THEME
  const settingsDarkMode = settings?.darkMode
  const previousSettingsDarkModeRef = useRef(settingsDarkMode)
  const [exportModalOpen, setExportModalOpen] = useState(false)

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  )

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  // Keep <html> and the page URL on the active theme, so the page behind the
  // app matches and View > Reload boots straight into it (see theme-boot.js).
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', activeTheme)
    const url = new URL(window.location.href)
    url.searchParams.set('theme', activeTheme === DARK_THEME ? 'dark' : 'light')
    window.history.replaceState(window.history.state, '', url)
  }, [activeTheme])

  // Fade only when the user flips Dark mode, never when settings first load.
  useLayoutEffect(() => {
    const previous = previousSettingsDarkModeRef.current
    previousSettingsDarkModeRef.current = settingsDarkMode
    if (previous === undefined || previous === settingsDarkMode) return

    const root = document.documentElement
    root.classList.add('theme-transition')

    const timeoutId = window.setTimeout(() => {
      root.classList.remove('theme-transition')
    }, 240)

    return () => {
      window.clearTimeout(timeoutId)
      root.classList.remove('theme-transition')
    }
  }, [settingsDarkMode])

  // Switching chats restores the workspace that chat was working in.
  // Saving lastWorkspacePath points the main process at it; the effect below validates it.
  const activeWorkspacePath = activeConversation?.workspacePath ?? null
  useEffect(() => {
    if (!activeWorkspacePath) return
    if (activeWorkspacePath === useUIStore.getState().workspacePath) return
    const latestSettings = useSettingsStore.getState().settings
    if (!latestSettings) return
    const nextSettings = { ...latestSettings, lastWorkspacePath: activeWorkspacePath }
    useUIStore.getState().setSelectedFilePath(null)
    // Persist immediately (not debounced) so the main process has switched
    // before the validation effect and file tree list the new folder.
    window.redLedger.saveSettings(nextSettings)
      .then(() => useSettingsStore.getState().saveSettings(nextSettings))
      .catch((err) => notify({ type: 'error', message: formatError(err) }))
  }, [activeConversationId, activeWorkspacePath])

  // After settings load, validate and restore the last workspace path
  useEffect(() => {
    if (!settings?.lastWorkspacePath) return

    const validateWorkspace = async () => {
      try {
        await window.redLedger.listFiles()
        useUIStore.getState().setWorkspacePath(settings.lastWorkspacePath)
      } catch {
        useUIStore.getState().setWorkspacePath(null)
        const latestSettings = useSettingsStore.getState().settings
        if (latestSettings) {
          useSettingsStore.getState().saveSettings({
            ...latestSettings,
            lastWorkspacePath: null
          })
        }
        notify({
          type: 'warning',
          message: `Previous workspace no longer exists: ${settings.lastWorkspacePath}`
        })
      }
    }

    validateWorkspace()
  }, [settings?.lastWorkspacePath])

  const handleImportChat = useCallback(async () => {
    if (!window.redLedger) return
    try {
      const result = await window.redLedger.importChat()
      if (result.ok) {
        const conversationStore = useConversationStore.getState()
        await conversationStore.loadConversations()
        await conversationStore.setActiveConversation(result.conversation.id)
        useUIStore.getState().setSidebarTab('conversations')
        notify({
          type: 'success',
          message: `Imported "${result.conversation.title}" (${result.importedMessageCount} message${result.importedMessageCount === 1 ? '' : 's'})`
        })
      } else if (!result.canceled) {
        notify({ type: 'error', message: `Import failed: ${result.error}` })
      }
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  }, [])

  const handleMenuAction = useCallback((action: MenuAction) => {
    if (action === 'exportChat') {
      const conversation = useConversationStore.getState().conversations.find(
        (c) => c.id === useConversationStore.getState().activeConversationId
      )
      if (!conversation) {
        notify({
          type: 'warning',
          message: 'Select a chat before exporting.'
        })
        return
      }
      setExportModalOpen(true)
    } else if (action === 'importChat') {
      void handleImportChat()
    }
  }, [handleImportChat])

  useEffect(() => {
    if (!window.redLedger?.onMenuAction) return
    return window.redLedger.onMenuAction(handleMenuAction)
  }, [handleMenuAction])

  return (
    <div className="h-full w-full" data-theme={activeTheme}>
      <Layout />
      <Toaster />
      {exportModalOpen && activeConversation && (
        <ExportChatModal
          conversation={activeConversation}
          onClose={() => setExportModalOpen(false)}
        />
      )}
    </div>
  )
}
