import { useCallback, useState } from 'react'
import type { FetchUrlResult, SearchResponse, SearchResult, ToolCall } from '@/types'
import { cn } from '@/lib/utils'
import { findMcpServerByPrefix, parseMcpToolName } from '@/lib/mcpConfig'
import {
  describeToolCall,
  modelTextFor,
  summarizeToolResult,
  toolError,
  toolStatsLine,
  toolStatus
} from '@/lib/toolDisplay'
import { useSettingsStore } from '@/store'

type DetailTab = 'result' | 'arguments' | 'model' | 'raw'

const TAB_LABELS: Record<DetailTab, string> = {
  result: 'Result',
  arguments: 'Arguments',
  model: 'Sent to model',
  raw: 'Raw JSON'
}

const READABLE_TOOLS = new Set(['web_search', 'org_search', 'wiki_search', 'fetch_url'])

/** Display name of the connection an MCP tool came from, falling back to its name prefix. */
function useMcpServerLabel(toolName: string): { server: string; tool: string } | null {
  const servers = useSettingsStore((s) => s.settings?.mcpServers)
  const parsed = parseMcpToolName(toolName)
  if (!parsed) return null
  const match = servers ? findMcpServerByPrefix(servers, parsed.server) : undefined
  return { server: match?.name ?? parsed.server, tool: parsed.tool }
}

function prettyJson(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null'
}

function SearchResultsView({ result }: { result: unknown }) {
  const response = (Array.isArray(result) ? { results: result } : result) as Partial<SearchResponse>
  const results: SearchResult[] = Array.isArray(response.results) ? response.results : []
  if (results.length === 0) return <p className="tool-call-muted">No results.</p>

  return (
    <ol className="tool-call-results">
      {results.map((item, index) => (
        <li key={`${item.url}-${index}`}>
          <a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a>
          <span className="tool-call-muted">
            {[item.domain, item.published].filter(Boolean).join(' | ')}
          </span>
        </li>
      ))}
      {response.note && <p className="tool-call-muted">{response.note}</p>}
    </ol>
  )
}

function FetchResultView({ result }: { result: unknown }) {
  const page = result as Partial<FetchUrlResult>
  const meta = [page.site_name, page.published, page.byline].filter(Boolean).join(' | ')
  return (
    <div className="space-y-1.5">
      <p className="m-0">
        <a href={page.url} target="_blank" rel="noreferrer">{page.title || page.url}</a>
      </p>
      {meta && <p className="tool-call-muted m-0">{meta}</p>}
      <pre className="tool-call-pre">{page.content || '(no text content)'}</pre>
    </div>
  )
}

function ToolCallDetails({ toolCall }: { toolCall: ToolCall }) {
  const finished = toolCall.result !== undefined
  const error = toolError(toolCall)
  const readable = finished && !error && READABLE_TOOLS.has(toolCall.name)
  const tabs: DetailTab[] = !finished
    ? ['arguments']
    : readable ? ['result', 'arguments', 'model', 'raw'] : ['result', 'arguments', 'model']
  const [tab, setTab] = useState<DetailTab>(tabs[0])
  const [copied, setCopied] = useState(false)

  const textFor = useCallback((which: DetailTab): string => {
    switch (which) {
      case 'arguments': return prettyJson(toolCall.arguments)
      case 'model': return modelTextFor(toolCall)
      default: return prettyJson(toolCall.result)
    }
  }, [toolCall])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(textFor(tab))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied by the environment/user permissions.
    }
  }, [tab, textFor])

  let body: React.ReactNode
  if (tab === 'result' && error) {
    // The message above is the result; its JSON is under "Sent to model".
    body = null
  } else if (tab === 'result' && readable) {
    body = toolCall.name === 'fetch_url'
      ? <FetchResultView result={toolCall.result} />
      : <SearchResultsView result={toolCall.result} />
  } else {
    body = <pre className="tool-call-pre">{textFor(tab)}</pre>
  }

  return (
    <div className="tool-call-details">
      {error && <p className="tool-call-error">{error.error}</p>}
      {body}
      <div className="tool-call-tabs">
        {tabs.map((which) => (
          <button
            key={which}
            type="button"
            className={cn('tool-call-tab', tab === which && 'is-active')}
            onClick={() => setTab(which)}
          >
            {TAB_LABELS[which]}
          </button>
        ))}
        <button type="button" className="tool-call-tab ml-auto" onClick={() => { void copy() }}>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <p className="tool-call-stats">{finished ? toolStatsLine(toolCall) : `${toolStatsLine(toolCall) || toolCall.name} | running`}</p>
    </div>
  )
}

/** One tool call as a single plain line; click it for the readable result, tabs and stats. */
export function ToolCallRow({ toolCall }: { toolCall: ToolCall }) {
  const [isOpen, setIsOpen] = useState(false)
  const mcp = useMcpServerLabel(toolCall.name)
  const status = toolStatus(toolCall)
  const { subject, filters } = describeToolCall(toolCall)

  return (
    <div className="tool-call">
      <button
        type="button"
        className="tool-call-line"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        title={toolCall.name}
      >
        <span className="tool-call-name">
          {mcp ? <><span className="tool-call-server">{mcp.server}</span> {mcp.tool}</> : toolCall.name}
        </span>
        <span className="tool-call-subject">
          {subject}
          {filters && <span className="tool-call-muted"> ({filters})</span>}
        </span>
        <span className={cn('tool-call-result', status === 'failed' && 'is-error')}>
          {summarizeToolResult(toolCall)}
        </span>
      </button>
      {isOpen && <ToolCallDetails toolCall={toolCall} />}
    </div>
  )
}
