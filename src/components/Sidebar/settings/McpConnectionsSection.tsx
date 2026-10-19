import { useEffect, useState } from 'react'
import { RotateCw, X } from 'lucide-react'
import type { McpServerConfig, McpServerStatus, McpTransport } from '@/types'
import {
  formatKeyValueLines,
  joinCommandLine,
  parseKeyValueLines,
  parseMcpServersJson,
  splitCommandLine
} from '@/lib/mcpConfig'
import { notify } from '@/lib/notify'
import { useSettingsStore } from '@/store'
import { HelpIcon, LABEL_CLASS, SMALL_BUTTON_CLASS, type SettingsSectionProps } from './controls'

const TEXTAREA_CLASS = 'textarea textarea-bordered w-full bg-base-100 text-xs leading-snug min-h-0 px-3 py-1.5'

function newServerId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Live connection status from the main process, keyed by server id. */
function useMcpStatuses(): Record<string, McpServerStatus> {
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({})

  useEffect(() => {
    if (!window.redLedger) return
    let cancelled = false
    const apply = (list: McpServerStatus[]) => {
      if (!cancelled) setStatuses(Object.fromEntries(list.map((status) => [status.id, status])))
    }
    window.redLedger.getMcpStatus().then(apply).catch(() => {
      // Status stays unknown; rows fall back to "connecting".
    })
    const unsubscribe = window.redLedger.onMcpStatus(apply)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return statuses
}

// ─── Server form (add / edit) ───────────────────────────────────────────────

interface ServerFormProps {
  initial?: McpServerConfig
  onSave: (server: Omit<McpServerConfig, 'id' | 'enabled'>) => void
  onCancel: () => void
}

function ServerForm({ initial, onSave, onCancel }: ServerFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? 'stdio')
  const [commandLine, setCommandLine] = useState(joinCommandLine(initial?.command, initial?.args))
  const [envText, setEnvText] = useState(formatKeyValueLines(initial?.env, '='))
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headersText, setHeadersText] = useState(formatKeyValueLines(initial?.headers, ':'))
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()

    if (transport === 'stdio') {
      const [command, ...args] = splitCommandLine(commandLine)
      if (!command) {
        setError('Enter the command that starts the server.')
        return
      }
      const env = parseKeyValueLines(envText, '=')
      onSave({
        name: name.trim() || command,
        transport,
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {})
      })
      return
    }

    const trimmedUrl = url.trim()
    try {
      const parsed = new URL(trimmedUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
    } catch {
      setError('Enter a full http:// or https:// URL.')
      return
    }
    const headers = parseKeyValueLines(headersText, ':')
    onSave({
      name: name.trim() || new URL(trimmedUrl).hostname,
      transport,
      url: trimmedUrl,
      ...(Object.keys(headers).length > 0 ? { headers } : {})
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-card border border-weathered bg-base-200/35 p-2.5">
      <div>
        <label className={LABEL_CLASS}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Everything"
          className="input input-sm input-bordered w-full bg-base-100"
          autoFocus
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Type</label>
        <select
          value={transport}
          onChange={(e) => {
            setTransport(e.target.value as McpTransport)
            setError(null)
          }}
          className="select select-sm select-bordered w-full bg-base-100"
        >
          <option value="stdio">Local command</option>
          <option value="http">Remote URL</option>
        </select>
      </div>

      {transport === 'stdio' ? (
        <>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide">
                Command
              </label>
              <HelpIcon
                title="The command that starts the server, as you would type it in a terminal. Servers started with npx need Node.js installed."
                label="Command help"
              />
            </div>
            <input
              type="text"
              value={commandLine}
              onChange={(e) => {
                setCommandLine(e.target.value)
                setError(null)
              }}
              placeholder="npx -y @modelcontextprotocol/server-everything"
              className="input input-sm input-bordered w-full bg-base-100 text-xs font-mono"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide">
                Environment
              </label>
              <HelpIcon
                title="Optional. One KEY=value per line, e.g. API keys the server asks for."
                label="Environment help"
              />
            </div>
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="API_KEY=..."
              rows={2}
              className={`${TEXTAREA_CLASS} font-mono`}
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <label className={LABEL_CLASS}>URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setError(null)
              }}
              placeholder="https://example.com/mcp"
              className="input input-sm input-bordered w-full bg-base-100 text-xs"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide">
                Headers
              </label>
              <HelpIcon
                title="Optional. One Name: value per line, e.g. Authorization: Bearer your-token."
                label="Headers help"
              />
            </div>
            <textarea
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder="Authorization: Bearer ..."
              rows={2}
              className={`${TEXTAREA_CLASS} font-mono`}
            />
          </div>
        </>
      )}

      {error && <p className="text-[11px] text-error">{error}</p>}

      <div className="flex justify-end gap-1">
        <button type="button" onClick={onCancel} className={SMALL_BUTTON_CLASS}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-xs h-6 min-h-0 px-3 text-[10px] uppercase tracking-wide">
          {initial ? 'Save' : 'Add'}
        </button>
      </div>
    </form>
  )
}

// ─── Paste JSON ─────────────────────────────────────────────────────────────

interface PasteJsonFormProps {
  onImport: (servers: Omit<McpServerConfig, 'id'>[]) => void
  onCancel: () => void
}

function PasteJsonForm({ onImport, onCancel }: PasteJsonFormProps) {
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<string[]>([])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const result = parseMcpServersJson(text)
    if (result.servers.length === 0) {
      setErrors(result.errors)
      return
    }
    if (result.errors.length > 0) {
      notify({ type: 'warning', message: `Skipped: ${result.errors.join(' ')}` })
    }
    onImport(result.servers)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-card border border-weathered bg-base-200/35 p-2.5">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide">
            Config JSON
          </label>
          <HelpIcon
            title={`Paste a config from a server's README, e.g. { "mcpServers": { "name": { "command": "npx", "args": [...] } } }. Servers with the same name are replaced.`}
            label="Config JSON help"
          />
        </div>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setErrors([])
          }}
          placeholder={'{\n  "mcpServers": {\n    "everything": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-everything"]\n    }\n  }\n}'}
          rows={7}
          spellCheck={false}
          autoFocus
          className={`${TEXTAREA_CLASS} font-mono text-[11px]`}
        />
      </div>

      {errors.length > 0 && (
        <ul className="text-[11px] text-error space-y-0.5">
          {errors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}

      <div className="flex justify-end gap-1">
        <button type="button" onClick={onCancel} className={SMALL_BUTTON_CLASS}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={!text.trim()}
          className="btn btn-primary btn-xs h-6 min-h-0 px-3 text-[10px] uppercase tracking-wide"
        >
          Import
        </button>
      </div>
    </form>
  )
}

// ─── Server row ─────────────────────────────────────────────────────────────

const DOT_CLASS: Record<McpServerStatus['state'], string> = {
  connected: 'bg-success',
  connecting: 'bg-warning animate-pulse',
  error: 'bg-error',
  disabled: 'bg-soft-charcoal/20'
}

const STATE_LABEL: Record<McpServerStatus['state'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  error: 'Error',
  disabled: 'Off'
}

interface ServerRowProps {
  server: McpServerConfig
  status: McpServerStatus | undefined
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onRemove: () => void
}

function ServerRow({ server, status, onToggle, onEdit, onRemove }: ServerRowProps) {
  // Status lags a moment behind settings saves, so trust the toggle for on/off.
  const state: McpServerStatus['state'] = !server.enabled
    ? 'disabled'
    : (status && status.state !== 'disabled' ? status.state : 'connecting')
  const tooltip = state === 'error'
    ? `Error: ${status?.error || 'Could not connect.'}`
    : STATE_LABEL[state]

  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[state]} ${state === 'error' ? 'cursor-help' : ''}`}
        title={tooltip}
        aria-label={tooltip}
      />
      <button
        type="button"
        onClick={onEdit}
        title="Edit connection"
        className="flex-1 min-w-0 truncate text-left text-xs text-soft-charcoal hover:text-rca-red transition-colors bg-transparent border-0 p-0"
      >
        {server.name}
      </button>

      {state === 'connected' && (
        <span className="shrink-0 text-[10px] text-soft-charcoal/40 tabular-nums">
          {status?.toolCount ?? 0} {status?.toolCount === 1 ? 'tool' : 'tools'}
        </span>
      )}
      {state === 'error' && (
        <button
          type="button"
          onClick={() => {
            void window.redLedger?.reconnectMcpServer(server.id)
          }}
          title={`${tooltip}\n\nClick to retry.`}
          className="shrink-0 inline-flex items-center gap-1 text-[10px] text-error hover:text-error/70 bg-transparent border-0 p-0"
        >
          <RotateCw size={10} />
          Retry
        </button>
      )}

      <input
        type="checkbox"
        checked={server.enabled}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={`Enable ${server.name}`}
        className="toggle toggle-sm toggle-primary shrink-0"
      />
      <button
        type="button"
        onClick={onRemove}
        title="Remove connection"
        aria-label={`Remove ${server.name}`}
        className="btn btn-ghost btn-xs h-6 min-h-0 w-6 p-0 shrink-0 text-soft-charcoal/40 hover:text-soft-charcoal/70"
      >
        <X size={12} />
      </button>
    </div>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────

type Mode = { kind: 'idle' } | { kind: 'add' } | { kind: 'paste' } | { kind: 'edit'; id: string }

/**
 * Body of the "Connections" settings section: MCP servers whose tools the
 * assistant can call. The collapsible header lives in SettingsPanel.
 */
export function McpConnectionsSection({ settings, saveSettings }: SettingsSectionProps) {
  const statuses = useMcpStatuses()
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const servers = settings.mcpServers

  const saveServers = (next: McpServerConfig[]) => saveSettings({ ...settings, mcpServers: next })

  const removeServer = async (server: McpServerConfig) => {
    const confirmed = window.redLedger
      ? await window.redLedger.showConfirmDialog({
        title: 'Remove Connection',
        message: `Remove "${server.name}"?`,
        detail: 'The assistant will no longer be able to use its tools.'
      })
      : true
    if (!confirmed) return
    // Re-read in case settings changed while the dialog was open.
    const latest = useSettingsStore.getState().settings ?? settings
    saveSettings({ ...latest, mcpServers: latest.mcpServers.filter((s) => s.id !== server.id) })
    if (mode.kind === 'edit' && mode.id === server.id) setMode({ kind: 'idle' })
  }

  const importServers = (imported: Omit<McpServerConfig, 'id'>[]) => {
    const next = [...servers]
    let added = 0
    let replaced = 0
    for (const server of imported) {
      const index = next.findIndex((s) => s.name.toLowerCase() === server.name.toLowerCase())
      if (index >= 0) {
        next[index] = { ...server, id: next[index].id }
        replaced += 1
      } else {
        next.push({ ...server, id: newServerId() })
        added += 1
      }
    }
    saveServers(next)
    setMode({ kind: 'idle' })
    const parts = [
      added > 0 ? `added ${added}` : '',
      replaced > 0 ? `updated ${replaced}` : ''
    ].filter(Boolean)
    notify({ type: 'success', message: `Connections ${parts.join(', ')}.` })
  }

  const editing = mode.kind === 'edit' ? servers.find((s) => s.id === mode.id) : undefined

  return (
    <>
      <div className="flex items-center justify-between py-0.5">
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-medium text-soft-charcoal/60 uppercase tracking-wide">
            Servers
          </label>
          <HelpIcon
            title="Connect MCP servers to give the assistant extra tools, like file systems, browsers or app integrations. Add a local command or a remote URL, or paste a config JSON from a server's README."
            label="Connections help"
          />
        </div>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => setMode(mode.kind === 'add' ? { kind: 'idle' } : { kind: 'add' })}
            className={SMALL_BUTTON_CLASS}
          >
            Add server
          </button>
          <button
            type="button"
            onClick={() => setMode(mode.kind === 'paste' ? { kind: 'idle' } : { kind: 'paste' })}
            className={SMALL_BUTTON_CLASS}
          >
            Paste JSON
          </button>
        </div>
      </div>

      {mode.kind === 'add' && (
        <ServerForm
          onCancel={() => setMode({ kind: 'idle' })}
          onSave={(server) => {
            saveServers([...servers, { ...server, id: newServerId(), enabled: true }])
            setMode({ kind: 'idle' })
          }}
        />
      )}

      {mode.kind === 'paste' && (
        <PasteJsonForm onCancel={() => setMode({ kind: 'idle' })} onImport={importServers} />
      )}

      {servers.length > 0 && (
        <div className="space-y-0.5">
          {servers.map((server) => (
            editing?.id === server.id ? (
              <ServerForm
                key={server.id}
                initial={server}
                onCancel={() => setMode({ kind: 'idle' })}
                onSave={(updated) => {
                  saveServers(servers.map((s) => (s.id === server.id
                    ? { ...updated, id: s.id, enabled: s.enabled }
                    : s)))
                  setMode({ kind: 'idle' })
                }}
              />
            ) : (
              <ServerRow
                key={server.id}
                server={server}
                status={statuses[server.id]}
                onToggle={(enabled) => saveServers(servers.map((s) => (s.id === server.id ? { ...s, enabled } : s)))}
                onEdit={() => setMode({ kind: 'edit', id: server.id })}
                onRemove={() => void removeServer(server)}
              />
            )
          ))}
        </div>
      )}
    </>
  )
}
