import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Layout } from './components/Layout'
import { Toaster } from './components/ui/Toast'
import { ExportChatModal } from './components/Chat/ExportChatModal'
import { useConversationStore, useSettingsStore, useUIStore } from './store'
import { notify } from './lib/notify'
import { formatError } from './lib/errors'
import type { MenuAction } from './types'

export default function App() {
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const settings = useSettingsStore((s) => s.settings)
  const conversations = useConversationStore((s) => s.conversations)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const activeTheme = settings?.darkMode ? 'red-ledger-dark' : 'red-ledger'
  const previousThemeRef = useRef(activeTheme)
  const [exportModalOpen, setExportModalOpen] = useState(false)

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  )

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  useLayoutEffect(() => {
    if (previousThemeRef.current === activeTheme) return

    const root = document.documentElement
    root.classList.add('theme-transition')

    const timeoutId = window.setTimeout(() => {
      root.classList.remove('theme-transition')
    }, 240)

    previousThemeRef.current = activeTheme

    return () => {
      window.clearTimeout(timeoutId)
      root.classList.remove('theme-transition')
    }
  }, [activeTheme])

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
