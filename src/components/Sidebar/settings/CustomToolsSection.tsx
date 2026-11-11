import { useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, RotateCw } from 'lucide-react'
import type { CustomToolsetStatus } from '@/types'
import { setCustomToolsStatus, useCustomToolsStatus } from '@/lib/customToolsStatus'
import { notify } from '@/lib/notify'
import { HelpIcon, INLINE_LABEL_CLASS, SMALL_BUTTON_CLASS } from './controls'

const HELP = [
  'Each .json file in the tools folder describes one API and the GET requests the assistant may make to it.',
  'Drop a file in the folder and it loads by itself; fix a file and it reloads.',
  'A file needs "baseUrl" and a "tools" list; each tool has a "name", "description", "path" and optional "params" and "fixed" values.',
  'Use ${env:NAME} in "headers" to read an API key from an environment variable.',
  'Set "allowLocal": true for an API on this computer or your own network.'
].join(' ')

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function ToolsetRow({ toolset }: { toolset: CustomToolsetStatus }) {
  const [open, setOpen] = useState(false)
  const failed = !!toolset.error

  return (
    <div>
      <div className="flex items-center gap-2 py-0.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${failed ? 'bg-error' : 'bg-success'}`}
          title={failed ? 'Not loaded' : 'Loaded'}
          aria-label={failed ? 'Not loaded' : 'Loaded'}
        />
        <span className="flex-1 min-w-0 truncate text-xs text-soft-charcoal" title={toolset.file}>
          {toolset.name}
        </span>
        {toolset.allowLocal && (
          <span
            className="shrink-0 text-[10px] uppercase tracking-wide text-soft-charcoal/40"
            title="This file may reach local and private addresses on its own host."
          >
            Local
          </span>
        )}
        {!failed && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            title={open ? 'Hide tools' : 'Show tools'}
            className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-soft-charcoal/40 hover:text-soft-charcoal/70 tabular-nums bg-transparent border-0 p-0"
          >
            {plural(toolset.tools.length, 'tool')}
            {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
      </div>

      {failed && (
        <p className="ml-4 mb-1 text-[11px] text-error leading-snug break-words">
          {toolset.file}: {toolset.error}
        </p>
      )}

      {open && !failed && (
        <div className="ml-4 mb-1 rounded-card border border-weathered bg-base-200/35 px-2 py-1.5">
          <p className="mb-1 truncate text-[10px] text-soft-charcoal/50" title={toolset.baseUrl}>
            {toolset.file} | {toolset.baseUrl}
          </p>
          <ul className="max-h-48 overflow-y-auto">
            {toolset.tools.map((tool) => (
              <li
                key={tool.name}
                className="truncate py-0.5 font-mono text-[11px] text-soft-charcoal"
                title={tool.description ? `${toolset.prefix}__${tool.name}\n\n${tool.description}` : tool.name}
              >
                {tool.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** The custom tool files that loaded (or didn't), with the way into their folder. */
export function CustomToolsSection() {
  const status = useCustomToolsStatus()
  const [reloading, setReloading] = useState(false)
  const toolsets = status?.toolsets ?? []
  const toolCount = toolsets.reduce((total, toolset) => total + toolset.tools.length, 0)
  const failedCount = toolsets.filter((toolset) => toolset.error).length

  const openFolder = () => {
    window.redLedger?.openCustomToolsFolder().catch((err: unknown) => {
      notify({ type: 'error', message: `Could not open the tools folder: ${err instanceof Error ? err.message : String(err)}` })
    })
  }

  const reload = () => {
    if (!window.redLedger || reloading) return
    setReloading(true)
    window.redLedger.reloadCustomTools()
      .then(setCustomToolsStatus)
      .catch((err: unknown) => {
        notify({ type: 'error', message: `Could not reload the tools: ${err instanceof Error ? err.message : String(err)}` })
      })
      .finally(() => setReloading(false))
  }

  const summary = toolsets.length === 0
    ? 'No tool files'
    : [
      `${plural(toolCount, 'tool')} from ${plural(toolsets.length - failedCount, 'file')}`,
      failedCount > 0 ? `${failedCount} not loaded` : null
    ].filter(Boolean).join(' | ')

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className={`${INLINE_LABEL_CLASS} tabular-nums`}>{summary}</span>
        <HelpIcon title={HELP} label="Custom tools help" />
      </div>

      {toolsets.length > 0 && (
        <div>
          {toolsets.map((toolset) => <ToolsetRow key={toolset.file} toolset={toolset} />)}
        </div>
      )}

      {status && toolsets.length === 0 && (
        <p className="text-[11px] text-soft-charcoal/50 leading-snug">
          Put a .json tool file in the tools folder and it shows up here.
        </p>
      )}

      <div className="flex justify-end gap-1">
        <button type="button" onClick={reload} disabled={reloading} className={`${SMALL_BUTTON_CLASS} gap-1`}>
          <RotateCw size={11} className={reloading ? 'animate-spin' : ''} />
          Reload
        </button>
        <button
          type="button"
          onClick={openFolder}
          title={status?.folder}
          className={`${SMALL_BUTTON_CLASS} gap-1`}
        >
          <FolderOpen size={11} />
          Open folder
        </button>
      </div>
    </div>
  )
}
