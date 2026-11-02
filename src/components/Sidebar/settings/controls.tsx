import { useEffect, useState, type ReactNode } from 'react'
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
      className="divider text-[10px] text-soft-charcoal/30 uppercase tracking-widest mt-1 w-full cursor-pointer bg-transparent border-0 p-0 hover:text-soft-charcoal/50 transition-colors"
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

let keyStorageRequest: Promise<'encrypted' | 'plain'> | null = null

/** How API keys are saved on this computer; asked once per app run. */
function useKeyStorage(): 'encrypted' | 'plain' | null {
  const [storage, setStorage] = useState<'encrypted' | 'plain' | null>(null)
  useEffect(() => {
    if (!window.redLedger) return
    keyStorageRequest ??= window.redLedger.getKeyStorage()
    let active = true
    keyStorageRequest.then((value) => { if (active) setStorage(value) }).catch(() => {})
    return () => { active = false }
  }, [])
  return storage
}

/**
 * An API key field. A key is masked; an environment variable reference like
 * ${env:OPENAI_API_KEY} is shown as typed, since it names the key rather than
 * holding it.
 */
export function ApiKeyInput({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const storage = useKeyStorage()
  const isReference = value.includes('${')
  const help = [
    storage === 'plain'
      ? 'This system has no keychain, so keys are saved as plain text in settings.json.'
      : 'Saved encrypted with your system keychain, not in settings.json.',
    'To read the key from an environment variable instead, enter ${env:NAME}, for example ${env:OPENAI_API_KEY}.'
  ].join(' ')

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className={INLINE_LABEL_CLASS}>{label}</label>
        <HelpIcon title={help} label={`${label} help`} />
      </div>
      <input
        type={isReference ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="input input-sm w-full"
      />
    </div>
  )
}
