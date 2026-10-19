import { useState, useEffect } from 'react'
import { X, FileText, FolderOpen } from 'lucide-react'
import { useUIStore } from '@/store'
import { formatError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import { Editor } from '../Editor/Editor'

export function FileViewer() {
  const selectedFilePath = useUIStore((s) => s.selectedFilePath)
  const setSelectedFilePath = useUIStore((s) => s.setSelectedFilePath)
  // The last read, tagged with its path; it is still loading until the tag matches.
  const [loaded, setLoaded] = useState<{ path: string; content: string; error: string | null } | null>(null)

  useEffect(() => {
    if (!selectedFilePath) return

    let cancelled = false
    window.redLedger
      .readFile(selectedFilePath)
      .then((text) => {
        if (!cancelled) setLoaded({ path: selectedFilePath, content: text, error: null })
      })
      .catch((err) => {
        if (!cancelled) setLoaded({ path: selectedFilePath, content: '', error: err?.message || 'Failed to read file' })
      })

    return () => {
      cancelled = true
    }
  }, [selectedFilePath])

  const current = loaded?.path === selectedFilePath ? loaded : null
  const isLoading = current === null
  const content = current?.content ?? ''
  const error = current?.error ?? null

  if (!selectedFilePath) return null

  return (
    <div className="flex flex-col border-t border-weathered" style={{ height: '50%' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-paper-stack border-b border-weathered">
        <FileText size={14} className="text-soft-charcoal/50 shrink-0" />
        <span className="text-xs font-medium text-soft-charcoal/70 truncate flex-1" title={selectedFilePath}>
          {selectedFilePath}
        </span>
        <button
          onClick={() => {
            window.redLedger
              .showInFolder(selectedFilePath)
              .catch((err) => notify({ type: 'error', message: formatError(err) }))
          }}
          className="btn btn-ghost btn-xs p-0.5"
          title="Show in file explorer"
        >
          <FolderOpen size={14} />
        </button>
        <button
          onClick={() => setSelectedFilePath(null)}
          className="btn btn-ghost btn-xs p-0.5"
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <span className="loading loading-spinner loading-sm text-rca-red" />
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-error">{error}</div>
        ) : (
          <Editor value={content} readOnly />
        )}
      </div>
    </div>
  )
}
