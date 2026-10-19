import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import type { ChatExportFormat, Conversation } from '@/types'
import { formatError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'

interface ExportChatModalProps {
  conversation: Conversation
  onClose: () => void
}

const FORMAT_OPTIONS: Array<{
  value: ChatExportFormat
  label: string
  description: string
  extension: string
}> = [
  {
    value: 'markdown',
    label: 'Markdown',
    description: 'Human-readable plaintext. Great for sharing or archiving.',
    extension: '.md'
  },
  {
    value: 'xml',
    label: 'XML',
    description: 'Structured format that preserves all metadata for re-import.',
    extension: '.xml'
  }
]

export function ExportChatModal({ conversation, onClose }: ExportChatModalProps) {
  const [format, setFormat] = useState<ChatExportFormat>('markdown')
  const [isExporting, setIsExporting] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isExporting) {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, isExporting])

  const handleExport = async () => {
    if (!window.redLedger) return
    setIsExporting(true)
    try {
      const result = await window.redLedger.exportChat(conversation.id, format)
      if (result.ok) {
        notify({
          type: 'success',
          message: `Exported chat to ${result.path}`
        })
        onClose()
      } else if (!result.canceled) {
        notify({ type: 'error', message: `Export failed: ${result.error}` })
      } else {
        // User canceled the save dialog — close modal silently
        onClose()
      }
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-soft-charcoal/40"
      onClick={() => { if (!isExporting) onClose() }}
    >
      <div
        className="bg-paper border border-weathered rounded-lg shadow-xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-chat-title"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-weathered">
          <h2 id="export-chat-title" className="text-sm font-semibold text-soft-charcoal">
            Export Chat
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="p-1 rounded-sm hover:bg-base-300 text-soft-charcoal/60 hover:text-soft-charcoal transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div className="text-xs text-soft-charcoal/60">
            Exporting <span className="font-medium text-soft-charcoal">{conversation.title}</span>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-soft-charcoal/80 mb-3">Format</legend>
            {FORMAT_OPTIONS.map((option) => {
              const checked = format === option.value
              return (
                <label
                  key={option.value}
                  className={cn(
                    'flex gap-3 p-3 rounded-sm border cursor-pointer transition-colors',
                    checked
                      ? 'border-rca-red bg-rca-red/5'
                      : 'border-weathered hover:bg-paper-stack/40'
                  )}
                >
                  <input
                    type="radio"
                    name="export-format"
                    value={option.value}
                    checked={checked}
                    onChange={() => setFormat(option.value)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-soft-charcoal flex items-baseline gap-2">
                      {option.label}
                      <span className="text-[11px] font-mono text-soft-charcoal/40">
                        {option.extension}
                      </span>
                    </div>
                    <div className="text-xs text-soft-charcoal/60 mt-0.5">
                      {option.description}
                    </div>
                  </div>
                </label>
              )
            })}
          </fieldset>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-weathered bg-paper-stack/40">
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={isExporting}
            className="btn btn-primary btn-sm gap-2"
          >
            <Download size={14} />
            {isExporting ? 'Exporting…' : 'Choose Location & Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
