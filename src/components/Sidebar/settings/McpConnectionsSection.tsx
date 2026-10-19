import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, LogIn, RotateCw, X } from 'lucide-react'
import type { McpOAuthConfig, McpServerConfig, McpServerStatus, McpToolInfo, McpTransport } from '@/types'
import {
  formatKeyValueLines,
  joinCommandLine,
  MCP_VARIABLES_HELP,
  mcpServerJsonKeys,
  parseKeyValueLines,
  parseMcpServersJson,
  restoreMaskedSecrets,
  serializeMcpServersJson,
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
  /** Live status of the server being edited, for the sign-out control. */
  status?: McpServerStatus
  onSave: (server: Omit<McpServerConfig, 'id' | 'enabled'>) => void
  onCancel: () => void
  onSignOut?: () => void
}

const FIELD_LABEL_CLASS = 'text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide'

/** Label with a help icon, used above most form fields. */
function FieldLabel({ label, help }: { label: string; help: string }) {
  return (
    <div className="mb-1 flex items-center justify-between">
      <label className={FIELD_LABEL_CLASS}>{label}</label>
      <HelpIcon title={help} label={`${label} help`} />
    </div>
  )
}

function ServerForm({ initial, status, onSave, onCancel, onSignOut }: ServerFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? 'stdio')
  const [commandLine, setCommandLine] = useState(joinCommandLine(initial?.command, initial?.args))
  const [envText, setEnvText] = useState(formatKeyValueLines(initial?.env, '='))
  const [cwd, setCwd] = useState(initial?.cwd ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headersText, setHeadersText] = useState(formatKeyValueLines(initial?.headers, ':'))
  const [clientId, setClientId] = useState(initial?.oauth?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState(initial?.oauth?.clientSecret ?? '')
  const [scope, setScope] = useState(initial?.oauth?.scope ?? '')
  const [callbackPort, setCallbackPort] = useState(initial?.oauth?.callbackPort ? String(initial.oauth.callbackPort) : '')
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
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {})
      })
      return
    }

    const trimmedUrl = url.trim()
    // A URL that starts with a variable is checked once it is filled in, when connecting.
    if (!trimmedUrl.startsWith('${')) {
      try {
        const parsed = new URL(trimmedUrl)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
      } catch {
        setError('Enter a full http:// or https:// URL.')
        return
      }
    }
    const port = callbackPort.trim() ? Number(callbackPort.trim()) : undefined
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
      setError('The callback port must be a number from 1 to 65535.')
      return
    }
    const oauthFields: McpOAuthConfig = {
      ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      ...(scope.trim() ? { scope: scope.trim() } : {}),
      ...(port !== undefined ? { callbackPort: port } : {})
    }
    const headers = parseKeyValueLines(headersText, ':')
    let fallbackName = trimmedUrl
    try {
      fallbackName = new URL(trimmedUrl).hostname
    } catch {
      // Variable URL; keep it as the name
    }
    onSave({
      name: name.trim() || fallbackName,
      transport,
      url: trimmedUrl,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(oauthFields).length > 0 ? { oauth: oauthFields } : {})
    })
  }

  const hasOAuthOptions = !!(initial?.oauth && Object.keys(initial.oauth).length > 0)

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
            <FieldLabel
              label="Command"
              help={`The command that starts the server, as you would type it in a terminal. Servers started with npx need Node.js installed. Variables: ${MCP_VARIABLES_HELP}`}
            />
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
            <FieldLabel
              label="Environment"
              help="Optional. One KEY=value per line, e.g. API keys the server asks for. API_KEY=${env:MY_API_KEY} passes a variable from your system instead of saving the key here."
            />
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="API_KEY=..."
              rows={2}
              className={`${TEXTAREA_CLASS} font-mono`}
            />
          </div>
          <div>
            <FieldLabel
              label="Working folder"
              help="Optional. The folder the command runs in; leave empty for your home folder. ${workspaceFolder} uses the open workspace, and the server restarts when you switch workspaces."
            />
            <input
              type="text"
              value={cwd}
              onChange={(e) => {
                setCwd(e.target.value)
                setError(null)
              }}
              placeholder="${workspaceFolder}"
              className="input input-sm input-bordered w-full bg-base-100 text-xs font-mono"
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <FieldLabel
              label="URL"
              help={`The server's address. Servers that need an account show a Sign in button after you add them. Variables: ${MCP_VARIABLES_HELP}`}
            />
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
            <FieldLabel
              label="Headers"
              help="Optional. One Name: value per line, e.g. Authorization: Bearer ${env:MY_TOKEN}. Only for servers that use an API key; with an Authorization header set, Sign in is not offered."
            />
            <textarea
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder="Authorization: Bearer ..."
              rows={2}
              className={`${TEXTAREA_CLASS} font-mono`}
            />
          </div>

          <details open={hasOAuthOptions} className="group">
            <summary className="cursor-pointer select-none text-[11px] font-medium text-soft-charcoal/60 uppercase tracking-wide">
              Sign-in options
            </summary>
            <div className="mt-2 space-y-2">
              <p className="text-[11px] text-soft-charcoal/50 leading-snug">
                Usually not needed. Fill these in only if the provider asks you to create your own OAuth app; register
                {' '}<code className="font-mono">http://127.0.0.1:&lt;port&gt;/callback</code> as its redirect address.
              </p>
              <div>
                <label className={LABEL_CLASS}>Client ID</label>
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="input input-sm input-bordered w-full bg-base-100 text-xs font-mono"
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Client secret</label>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Only for confidential clients"
                  autoComplete="off"
                  className="input input-sm input-bordered w-full bg-base-100 text-xs font-mono"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <label className={LABEL_CLASS}>Scope</label>
                  <input
                    type="text"
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                    placeholder="read write"
                    className="input input-sm input-bordered w-full bg-base-100 text-xs font-mono"
                  />
                </div>
                <div className="w-24 shrink-0">
                  <label className={LABEL_CLASS}>Port</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={callbackPort}
                    onChange={(e) => {
                      setCallbackPort(e.target.value)
                      setError(null)
                    }}
                    placeholder="Any"
                    className="input input-sm input-bordered w-full bg-base-100 text-xs font-mono"
                  />
                </div>
              </div>
            </div>
          </details>

          {status?.signedIn && onSignOut && (
            <div className="flex items-center justify-between text-[11px] text-soft-charcoal/60">
              <span>Signed in</span>
              <button type="button" onClick={onSignOut} className={SMALL_BUTTON_CLASS}>
                Sign out
              </button>
            </div>
          )}
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

// ─── JSON view ──────────────────────────────────────────────────────────────

interface JsonViewProps {
  servers: McpServerConfig[]
  onApply: (servers: McpServerConfig[]) => Promise<boolean>
  onClose: () => void
}

/**
 * The whole server list as config JSON. Secrets are masked until revealed;
 * masks left in place keep their saved values when the edit is applied.
 */
function JsonView({ servers, onApply, onClose }: JsonViewProps) {
  const [showSecrets, setShowSecrets] = useState(false)
  // The user's edit. Until they start editing, the text follows saved changes
  // (toggles, edits elsewhere).
  const [draft, setDraft] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const savedText = useMemo(() => serializeMcpServersJson(servers, { maskSecrets: !showSecrets }), [servers, showSecrets])
  const text = draft ?? savedText
  const dirty = draft !== null

  const reset = () => {
    setDraft(null)
    setErrors([])
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      notify({ type: 'success', message: showSecrets ? 'Config copied, including secrets.' : 'Config copied with secrets masked.' })
    } catch {
      notify({ type: 'error', message: 'Could not copy to the clipboard.' })
    }
  }

  const apply = async () => {
    const parsed = parseMcpServersJson(text, { allowEmpty: true })
    if (parsed.errors.length > 0) {
      setErrors(parsed.errors)
      return
    }
    const restored = restoreMaskedSecrets(parsed.servers, servers)
    if (restored.unresolved.length > 0) {
      setErrors([`Replace the masked value for ${restored.unresolved.join(', ')}; there is no saved value to keep.`])
      return
    }

    // Keep ids for servers that are still there, so their connections stay up.
    const keys = mcpServerJsonKeys(servers)
    const idByKey = new Map(servers.map((server, index) => [keys[index].toLowerCase(), server.id]))
    const next = restored.servers.map((server) => ({
      ...server,
      id: idByKey.get(server.name.toLowerCase()) ?? newServerId()
    }))

    if (await onApply(next)) reset()
  }

  return (
    <div className="space-y-2 rounded-card border border-weathered bg-base-200/35 p-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-medium text-soft-charcoal/60 block uppercase tracking-wide">
            Current config
          </label>
          <HelpIcon
            title="Every server as config JSON, in the format other MCP apps use. Edit it and press Apply to replace the whole list; servers you delete here are removed. Masked values keep their saved value."
            label="Current config help"
          />
        </div>
        <label
          className="flex items-center gap-1.5 text-[10px] text-soft-charcoal/60 uppercase tracking-wide cursor-pointer"
          title={dirty ? 'Apply or reset your edits first.' : 'Show env and header values'}
        >
          <input
            type="checkbox"
            checked={showSecrets}
            disabled={dirty}
            onChange={(e) => setShowSecrets(e.target.checked)}
            className="checkbox checkbox-xs"
          />
          Show secrets
        </label>
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setDraft(e.target.value)
          setErrors([])
        }}
        rows={12}
        spellCheck={false}
        aria-label="MCP config JSON"
        className={`${TEXTAREA_CLASS} font-mono text-[11px]`}
      />

      {errors.length > 0 && (
        <ul className="text-[11px] text-error space-y-0.5">
          {errors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}

      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={() => void copy()}
          title={showSecrets ? 'Copy, including secrets' : 'Copy with secrets masked'}
          className={`${SMALL_BUTTON_CLASS} gap-1`}
        >
          <Copy size={10} />
          Copy
        </button>
        {dirty ? (
          <>
            <button type="button" onClick={reset} className={SMALL_BUTTON_CLASS}>
              Reset
            </button>
            <button
              type="button"
              onClick={() => void apply()}
              className="btn btn-primary btn-xs h-6 min-h-0 px-3 text-[10px] uppercase tracking-wide"
            >
              Apply
            </button>
          </>
        ) : (
          <button type="button" onClick={onClose} className={SMALL_BUTTON_CLASS}>
            Close
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Tool list ──────────────────────────────────────────────────────────────

const LINK_BUTTON_CLASS = 'bg-transparent border-0 p-0 text-[10px] uppercase tracking-wide text-soft-charcoal/50 hover:text-rca-red disabled:opacity-40 disabled:hover:text-soft-charcoal/50'

interface ToolListProps {
  tools: McpToolInfo[]
  disabledTools: string[] | undefined
  onChange: (disabledTools: string[]) => void
}

/** Checkboxes for a connected server's tools. Hover a name for its description. */
function ToolList({ tools, disabledTools, onChange }: ToolListProps) {
  const disabled = new Set(disabledTools ?? [])
  const names = tools.map((tool) => tool.name)
  const onCount = names.filter((name) => !disabled.has(name)).length

  const setTool = (name: string, on: boolean) => {
    const next = new Set(disabled)
    if (on) next.delete(name)
    else next.add(name)
    onChange([...next])
  }

  return (
    <div className="ml-4 mb-1 rounded-card border border-weathered bg-base-200/35 px-2 py-1.5">
      {tools.length === 0 ? (
        <p className="text-[11px] text-soft-charcoal/50">This server offers no tools.</p>
      ) : (
        <>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-soft-charcoal/50 tabular-nums">
              {onCount} of {tools.length} on
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                disabled={onCount === tools.length}
                onClick={() => onChange([...disabled].filter((name) => !names.includes(name)))}
                className={LINK_BUTTON_CLASS}
              >
                All
              </button>
              <button
                type="button"
                disabled={onCount === 0}
                onClick={() => onChange([...new Set([...disabled, ...names])])}
                className={LINK_BUTTON_CLASS}
              >
                None
              </button>
            </span>
          </div>
          <ul className="max-h-48 overflow-y-auto">
            {tools.map((tool) => (
              <li key={tool.name}>
                <label
                  className="flex items-center gap-2 py-0.5 cursor-pointer min-w-0"
                  title={tool.description ? `${tool.name}\n\n${tool.description}` : tool.name}
                >
                  <input
                    type="checkbox"
                    checked={!disabled.has(tool.name)}
                    onChange={(e) => setTool(tool.name, e.target.checked)}
                    className="checkbox checkbox-xs shrink-0"
                  />
                  <span className={`truncate font-mono text-[11px] ${disabled.has(tool.name) ? 'text-soft-charcoal/40' : 'text-soft-charcoal'}`}>
                    {tool.name}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

// ─── Server row ─────────────────────────────────────────────────────────────

const DOT_CLASS: Record<McpServerStatus['state'], string> = {
  connected: 'bg-success',
  connecting: 'bg-warning animate-pulse',
  needs_auth: 'bg-warning',
  error: 'bg-error',
  disabled: 'bg-soft-charcoal/20'
}

const STATE_LABEL: Record<McpServerStatus['state'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  needs_auth: 'Sign-in needed',
  error: 'Error',
  disabled: 'Off'
}

interface ServerRowProps {
  server: McpServerConfig
  status: McpServerStatus | undefined
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onRemove: () => void
  onSignIn: () => void
  toolsOpen: boolean
  onToggleTools: () => void
}

function ServerRow({ server, status, onToggle, onEdit, onRemove, onSignIn, toolsOpen, onToggleTools }: ServerRowProps) {
  // Status lags a moment behind settings saves, so trust the toggle for on/off.
  const state: McpServerStatus['state'] = !server.enabled
    ? 'disabled'
    : (status && status.state !== 'disabled' ? status.state : 'connecting')
  const tooltip = state === 'error'
    ? `Error: ${status?.error || 'Could not connect.'}`
    : state === 'needs_auth'
      ? (status?.error || STATE_LABEL[state])
      : state === 'connected' && status?.signedIn
        ? 'Connected (signed in)'
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

      {state === 'connected' && (() => {
        const on = status?.toolCount ?? 0
        const total = status?.tools?.length ?? on
        return (
          <button
            type="button"
            onClick={onToggleTools}
            aria-expanded={toolsOpen}
            title={toolsOpen ? 'Hide tools' : 'Choose which tools the assistant can use'}
            className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-soft-charcoal/40 hover:text-soft-charcoal/70 tabular-nums bg-transparent border-0 p-0"
          >
            {on === total ? on : `${on}/${total}`} {total === 1 ? 'tool' : 'tools'}
            {toolsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )
      })()}
      {state === 'needs_auth' && !status?.signingIn && (
        <button
          type="button"
          onClick={onSignIn}
          title={`${tooltip}\n\nOpens the sign-in page in your browser.`}
          className="shrink-0 inline-flex items-center gap-1 text-[10px] text-warning hover:text-warning/70 bg-transparent border-0 p-0"
        >
          <LogIn size={10} />
          Sign in
        </button>
      )}
      {status?.signingIn && (
        <button
          type="button"
          onClick={() => {
            void window.redLedger?.cancelMcpSignIn(server.id)
          }}
          title="Waiting for you to finish signing in in the browser. Click to cancel."
          className="shrink-0 inline-flex items-center gap-1 text-[10px] text-soft-charcoal/50 hover:text-soft-charcoal/80 bg-transparent border-0 p-0"
        >
          <span className="loading loading-spinner loading-xs h-2.5 w-2.5" />
          Cancel
        </button>
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

type Mode = { kind: 'idle' } | { kind: 'add' } | { kind: 'paste' } | { kind: 'json' } | { kind: 'edit'; id: string }

/**
 * Body of the "Connections" settings section: MCP servers whose tools the
 * assistant can call. The collapsible header lives in SettingsPanel.
 */
export function McpConnectionsSection({ settings, saveSettings }: SettingsSectionProps) {
  const statuses = useMcpStatuses()
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  /** Server whose tool list is open. */
  const [toolsOpenId, setToolsOpenId] = useState<string | null>(null)
  /** A just-added server, whose tools open once it connects. */
  const [revealToolsId, setRevealToolsId] = useState<string | null>(null)

  if (revealToolsId && statuses[revealToolsId]?.state === 'connected') {
    setToolsOpenId(revealToolsId)
    setRevealToolsId(null)
  }
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

  const applyJson = async (next: McpServerConfig[]): Promise<boolean> => {
    // Re-read in case settings changed while editing.
    const latest = useSettingsStore.getState().settings ?? settings
    const keptIds = new Set(next.map((server) => server.id))
    const removed = latest.mcpServers.filter((server) => !keptIds.has(server.id))
    if (removed.length > 0 && window.redLedger) {
      const confirmed = await window.redLedger.showConfirmDialog({
        title: 'Remove Connections',
        message: `Remove ${removed.map((server) => `"${server.name}"`).join(', ')}?`,
        detail: 'They are missing from the edited JSON. The assistant will no longer be able to use their tools.'
      })
      if (!confirmed) return false
    }
    saveSettings({ ...latest, mcpServers: next })
    notify({ type: 'success', message: 'Connections updated.' })
    return true
  }

  const signIn = async (server: McpServerConfig) => {
    const result = await window.redLedger?.signInMcpServer(server.id)
    if (!result) return
    if (result.ok) notify({ type: 'success', message: `Signed in to ${server.name}.` })
    else if (!result.cancelled) notify({ type: 'error', message: result.error })
  }

  const signOut = async (server: McpServerConfig) => {
    await window.redLedger?.signOutMcpServer(server.id)
    notify({ type: 'success', message: `Signed out of ${server.name}.` })
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
          <button
            type="button"
            onClick={() => setMode(mode.kind === 'json' ? { kind: 'idle' } : { kind: 'json' })}
            title="View and edit every server as config JSON"
            className={SMALL_BUTTON_CLASS}
          >
            View JSON
          </button>
        </div>
      </div>

      {mode.kind === 'add' && (
        <ServerForm
          onCancel={() => setMode({ kind: 'idle' })}
          onSave={(server) => {
            const id = newServerId()
            saveServers([...servers, { ...server, id, enabled: true }])
            setRevealToolsId(id)
            setMode({ kind: 'idle' })
          }}
        />
      )}

      {mode.kind === 'paste' && (
        <PasteJsonForm onCancel={() => setMode({ kind: 'idle' })} onImport={importServers} />
      )}

      {mode.kind === 'json' && (
        <JsonView servers={servers} onApply={applyJson} onClose={() => setMode({ kind: 'idle' })} />
      )}

      {servers.length > 0 && (
        <div className="space-y-0.5">
          {servers.map((server) => (
            editing?.id === server.id ? (
              <ServerForm
                key={server.id}
                initial={server}
                status={statuses[server.id]}
                onSignOut={() => void signOut(server)}
                onCancel={() => setMode({ kind: 'idle' })}
                onSave={(updated) => {
                  saveServers(servers.map((s) => (s.id === server.id
                    ? { ...updated, id: s.id, enabled: s.enabled, disabledTools: s.disabledTools }
                    : s)))
                  setMode({ kind: 'idle' })
                }}
              />
            ) : (
              <Fragment key={server.id}>
                <ServerRow
                  server={server}
                  status={statuses[server.id]}
                  onToggle={(enabled) => saveServers(servers.map((s) => (s.id === server.id ? { ...s, enabled } : s)))}
                  onEdit={() => setMode({ kind: 'edit', id: server.id })}
                  onRemove={() => void removeServer(server)}
                  onSignIn={() => void signIn(server)}
                  toolsOpen={toolsOpenId === server.id}
                  onToggleTools={() => setToolsOpenId(toolsOpenId === server.id ? null : server.id)}
                />
                {toolsOpenId === server.id && server.enabled && statuses[server.id]?.state === 'connected' && (
                  <ToolList
                    tools={statuses[server.id]?.tools ?? []}
                    disabledTools={server.disabledTools}
                    onChange={(disabledTools) => saveServers(servers.map((s) => (s.id === server.id
                      ? { ...s, disabledTools: disabledTools.length > 0 ? disabledTools : undefined }
                      : s)))}
                  />
                )}
              </Fragment>
            )
          ))}
        </div>
      )}
    </>
  )
}
