import type { ToolCall } from '../../../src/types'

/**
 * Per-turn tool-call budget tracker.
 *
 * The model declares an estimate via the `declare_estimate` tool on its first
 * tool-using round. From that estimate we derive:
 *   - soft cap = ceil(estimate * 1.5)  → warning appended to next tool result
 *   - hard cap = estimate * 4          → turn is terminated
 *
 * If the model uses tools without first declaring, a default estimate is
 * applied silently. Re-declarations within the same turn are ignored.
 *
 * This module is a pure state machine — no I/O, no streaming. The orchestrator
 * in LlmService is the sole caller.
 */

export const DECLARE_ESTIMATE_TOOL_NAME = 'declare_estimate'

export interface BudgetState {
  estimate: number | null
  actionToolCalls: number
  softWarningIssued: boolean
}

export interface EstimateAck {
  call: ToolCall
  result: Record<string, unknown>
}

export interface RoundIngestion {
  estimateAcks: EstimateAck[]
  actionCalls: ToolCall[]
  hardCapExceeded: { hardCap: number; estimate: number } | null
  softWarningToAppend: string | null
}

export function createBudget(): BudgetState {
  return {
    estimate: null,
    actionToolCalls: 0,
    softWarningIssued: false
  }
}

export function softCap(estimate: number): number {
  return Math.ceil(estimate * 1.5)
}

export function hardCap(estimate: number): number {
  return estimate * 4
}

function parseDeclaredCount(call: ToolCall): number | null {
  const raw = (call.arguments as Record<string, unknown> | undefined)?.count
  const num = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(num)) return null
  const floored = Math.floor(num)
  return floored >= 1 ? floored : null
}

/**
 * Process one round of collected tool calls. Updates `state` in place,
 * returns the data the orchestrator needs to act on this round.
 *
 * Invariant: caller must dispatch the action calls exactly as returned.
 * The synthesized estimate-ack results are owned by the orchestrator —
 * `declare_estimate` is never sent through normal tool dispatch.
 */
export function ingestRound(
  state: BudgetState,
  collected: ToolCall[],
  defaultEstimate: number
): RoundIngestion {
  const estimateCalls: ToolCall[] = []
  const actionCalls: ToolCall[] = []
  for (const call of collected) {
    if (call.name === DECLARE_ESTIMATE_TOOL_NAME) {
      estimateCalls.push(call)
    } else {
      actionCalls.push(call)
    }
  }

  const estimateAcks: EstimateAck[] = []

  for (const call of estimateCalls) {
    if (state.estimate === null) {
      const declared = parseDeclaredCount(call)
      if (declared !== null) {
        state.estimate = declared
        estimateAcks.push({
          call,
          result: {
            acknowledged: true,
            declared,
            soft_cap: softCap(declared),
            hard_cap: hardCap(declared)
          }
        })
        continue
      }
      // Invalid count — leave state.estimate null for now; another estimate call
      // (or the action-fallback below) may set it. Acknowledge as invalid.
      estimateAcks.push({
        call,
        result: {
          acknowledged: false,
          reason: 'invalid count; estimate not set'
        }
      })
    } else {
      estimateAcks.push({
        call,
        result: {
          acknowledged: false,
          reason: 'estimate locked',
          locked_at: state.estimate
        }
      })
    }
  }

  if (state.estimate === null && actionCalls.length > 0) {
    state.estimate = Math.max(1, Math.floor(defaultEstimate))
  }

  if (state.estimate === null) {
    return {
      estimateAcks,
      actionCalls,
      hardCapExceeded: null,
      softWarningToAppend: null
    }
  }

  const projected = state.actionToolCalls + actionCalls.length
  const hard = hardCap(state.estimate)

  if (actionCalls.length > 0 && projected > hard) {
    return {
      estimateAcks,
      actionCalls,
      hardCapExceeded: { hardCap: hard, estimate: state.estimate },
      softWarningToAppend: null
    }
  }

  state.actionToolCalls = projected

  let softWarningToAppend: string | null = null
  const soft = softCap(state.estimate)
  if (
    !state.softWarningIssued &&
    actionCalls.length > 0 &&
    state.actionToolCalls >= soft
  ) {
    softWarningToAppend = buildSoftWarning(
      state.actionToolCalls,
      state.estimate,
      soft,
      hard
    )
    state.softWarningIssued = true
  }

  return {
    estimateAcks,
    actionCalls,
    hardCapExceeded: null,
    softWarningToAppend
  }
}

function buildSoftWarning(
  used: number,
  estimate: number,
  soft: number,
  hard: number
): string {
  return (
    `Soft cap reached: you have used ${used} tool calls in this turn, ` +
    `at or above 1.5x your declared estimate of ${estimate} (soft cap = ${soft}). ` +
    `Hard cut at ${hard}. If you can wrap up cleanly soon, please do so.`
  )
}

export const SOFT_WARNING_FIELD = '_budget_warning'

/**
 * Attach a soft-warning string to a tool result without losing the original
 * shape. Object results get the warning as an extra field; primitive results
 * are wrapped.
 */
export function attachSoftWarning(result: unknown, warning: string): unknown {
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), [SOFT_WARNING_FIELD]: warning }
  }
  return { value: result, [SOFT_WARNING_FIELD]: warning }
}
