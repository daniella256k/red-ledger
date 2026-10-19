import { useState, useEffect, useCallback } from 'react'
import { FolderOpen } from 'lucide-react'
import { useUIStore, useSettingsStore, useConversationStore } from '@/store'
import { FileTree } from '../FileTree/FileTree'
import { FileViewer } from './FileViewer'
import type { FileNode } from '@/types'

interface WorkspaceTreeProps {
  compactOpenFolderButton?: boolean
}

export function WorkspaceTree({ compactOpenFolderButton = false }: WorkspaceTreeProps) {
  const workspacePath = useUIStore((s) => s.workspacePath)
  const setWorkspacePath = useUIStore((s) => s.setWorkspacePath)
  const setSelectedFilePath = useUIStore((s) => s.setSelectedFilePath)
  const selectedFilePath = useUIStore((s) => s.selectedFilePath)
  const fileTreeVersion = useUIStore((s) => s.fileTreeVersion)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const setConversationWorkspace = useConversationStore((s) => s.setConversationWorkspace)
  const settings = useSettingsStore((s) => s.settings)
  const saveSettings = useSettingsStore((s) => s.saveSettings)
  // The last listing, tagged with the folder and refresh it was made for; it is
  // still loading until the tag matches.
  const [listing, setListing] = useState<{ key: string; files: FileNode[] } | null>(null)
  const listingKey = `${fileTreeVersion}:${workspacePath ?? ''}`

  const handleOpenFolder = useCallback(async () => {
    if (!window.redLedger) return
    const path = await window.redLedger.selectWorkspace()
    if (path) {
      if (workspacePath !== path) {
        setSelectedFilePath(null)
      }
      setWorkspacePath(path)
      if (settings && settings.lastWorkspacePath !== path) {
        saveSettings({ ...settings, lastWorkspacePath: path })
      }
      // The open chat follows the folder the user just picked.
      if (activeConversationId) {
        void setConversationWorkspace(activeConversationId, path)
      }
    }
  }, [workspacePath, setSelectedFilePath, setWorkspacePath, settings, saveSettings, activeConversationId, setConversationWorkspace])

  useEffect(() => {
    if (!workspacePath || !window.redLedger) return

    let cancelled = false
    window.redLedger
      .listFiles()
      .catch(() => [] as FileNode[])
      .then((nodes) => {
        if (!cancelled) setListing({ key: listingKey, files: nodes })
      })

    return () => {
      cancelled = true
    }
  }, [workspacePath, listingKey])

  const files = workspacePath ? listing?.files ?? [] : []
  const isLoading = Boolean(workspacePath && window.redLedger) && listing?.key !== listingKey

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 pb-2 space-y-1.5">
        <div className="flex justify-center">
          <button
            onClick={handleOpenFolder}
            className={`btn btn-sm btn-outline w-full max-w-[300px] whitespace-nowrap ${compactOpenFolderButton ? 'px-0' : 'gap-2'}`}
            title="Open Folder"
          >
            <FolderOpen size={14} />
            {!compactOpenFolderButton && 'Open Folder'}
          </button>
        </div>

        {workspacePath && (
          <div className="text-[11px] text-soft-charcoal/40 truncate px-0.5" title={workspacePath}>
            {workspacePath}
          </div>
        )}
      </div>

      <div
        className={selectedFilePath ? 'overflow-y-auto px-1' : 'flex-1 overflow-y-auto px-1'}
        style={selectedFilePath ? { height: '50%' } : undefined}
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <span className="loading loading-spinner loading-sm text-rca-red" />
          </div>
        ) : files.length > 0 ? (
          <FileTree nodes={files} />
        ) : workspacePath ? (
          <div className="px-4 py-8 text-center text-xs text-soft-charcoal/40">
            Empty workspace
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-xs text-soft-charcoal/40 leading-relaxed">
            Select a workspace folder to browse files
          </div>
        )}
      </div>

      <FileViewer />
    </div>
  )
}
