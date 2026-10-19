import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, CircleHelp } from 'lucide-react'
import type { Settings } from '@/types'

/** Every settings section edits the whole Settings object and saves it back. */
export interface SettingsSectionProps {
  settings: Settings
  saveSettings: (settings: Settings) => void
}

export const LABEL_CLASS = 'text-[11px] font-medium text-soft-charcoal/60 mb-1 block uppercase tracking-wide'
export const INLINE_LABEL_CLASS = 'text-[11px] font-medium text-soft-charcoal/60 uppercase tracking-wide'
export const SMALL_BUTTON_CLASS = 'btn btn-ghost btn-xs h-6 min-h-0 px-2 text-[10px] uppercase tracking-wide'

export function HelpIcon({ title, label }: { title: string; label: string }) {
  return (
    <span
      className="text-soft-charcoal/40 hover:text-soft-charcoal/60 cursor-help"
      title={title}
      aria-label={label}
    >
      <CircleHelp size={12} />
    </span>
  )
}

/** Collapsible divider heading; the expanded flag is persisted in Settings. */
export function SectionToggle({
  label,
  expanded,
  onToggle
}: {
  label: string
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="divider text-[10px] text-soft-charcoal/30 uppercase tracking-widest my-1 w-full cursor-pointer bg-transparent border-0 p-0 hover:text-soft-charcoal/50 transition-colors"
    >
      <span className="inline-flex items-center gap-1">
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </span>
    </button>
  )
}

/** Label on the left, help icon + toggle switch on the right. */
export function ToggleRow({
  label,
  help,
  helpLabel,
  checked,
  onChange,
  className = 'py-0.5'
}: {
  label: ReactNode
  help: string
  helpLabel: string
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <label className={INLINE_LABEL_CLASS}>{label}</label>
      <div className="flex items-center gap-2">
        <HelpIcon title={help} label={helpLabel} />
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="toggle toggle-sm toggle-primary"
        />
      </div>
    </div>
  )
}
