import { useCallback, useEffect, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { formatBytes } from '@/lib/utils'
import { StorageModal } from './StorageModal'

/** Database size at a glance, and the way into the Storage panel. */
export function StorageSection() {
  const [isOpen, setIsOpen] = useState(false)
  const [databaseBytes, setDatabaseBytes] = useState<number | null>(null)

  const loadSize = useCallback(() => {
    if (!window.redLedger) return
    window.redLedger.getStorageOverview()
      .then((overview) => setDatabaseBytes(overview.databaseBytes))
      .catch(() => setDatabaseBytes(null))
  }, [])

  useEffect(() => {
    loadSize()
  }, [loadSize])

  const handleClose = () => {
    setIsOpen(false)
    loadSize()
  }

  return (
    <>
      <div className="divider text-[10px] text-soft-charcoal/30 uppercase tracking-widest mt-1">Storage</div>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="btn btn-ghost btn-sm w-full justify-between gap-2 font-normal"
      >
        <span className="inline-flex items-center gap-2">
          <HardDrive size={14} />
          Manage storage…
        </span>
        {databaseBytes !== null && (
          <span className="text-xs text-soft-charcoal/50 tabular-nums">{formatBytes(databaseBytes)}</span>
        )}
      </button>
      {isOpen && <StorageModal onClose={handleClose} />}
    </>
  )
}
