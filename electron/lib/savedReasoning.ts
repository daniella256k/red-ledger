import { isProviderName } from '../../src/lib/providers'
import type { ProviderName, ReasoningEcho, SavedReasoning, SavedReasoningRound } from '../../src/types'

/**
 * A reply's saved reasoning blocks (messages.replay): reading them back, and
 * deciding whether a request may carry them.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The echo as saved, or null when it holds a field of the wrong type or nothing at all. */
function parseEcho(value: unknown): ReasoningEcho | null {
  if (!isRecord(value)) return null
  const echo: ReasoningEcho = {}
  for (const [key, field] of Object.entries(value)) {
    if (key === 'reasoning_details') {
      if (!Array.isArray(field)) return null
      echo.reasoning_details = field
    } else if (key === 'reasoning_content' || key === 'reasoning' || key === 'thinking') {
      if (typeof field !== 'string') return null
      echo[key] = field
    } else {
      // A field this version doesn't know: replaying the rest would change the blocks.
      return null
    }
  }
  return Object.keys(echo).length > 0 ? echo : null
}

/**
 * The saved value, or null when it is missing, from a newer format, or
 * damaged. A damaged reply is replayed without reasoning, as before 1.10.
 */
export function parseSavedReasoning(json: unknown): SavedReasoning | null {
  if (typeof json !== 'string' || json.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null
  if (!isProviderName(parsed.provider) || typeof parsed.baseUrl !== 'string' || typeof parsed.model !== 'string') return null
  if (!Array.isArray(parsed.rounds)) return null

  const rounds: SavedReasoningRound[] = []
  for (const entry of parsed.rounds) {
    if (!isRecord(entry) || typeof entry.round !== 'number' || !Number.isInteger(entry.round)) return null
    const reasoning = parseEcho(entry.reasoning)
    if (!reasoning) return null
    rounds.push({ round: entry.round, ...(entry.final === true ? { final: true as const } : {}), reasoning })
  }
  return { v: 1, provider: parsed.provider, baseUrl: parsed.baseUrl, model: parsed.model, rounds }
}

/** A base URL as providers use it (they trim trailing slashes). */
export function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '')
}

/**
 * Whether blocks saved from one server and model may go to this request.
 * Signed and encrypted blocks only mean something to the server that made
 * them, and a different model reads them as foreign text, if it takes them at all.
 */
export function reasoningMatches(
  saved: SavedReasoning,
  provider: ProviderName,
  baseUrl: string | undefined,
  model: string
): boolean {
  return saved.provider === provider && saved.baseUrl === normalizeBaseUrl(baseUrl) && saved.model === model
}
