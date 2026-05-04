import type { ToolCall } from '../../../src/types'

/**
 * Per-turn tool-call budget tracker.
 *
 * The model declares a plan via the `plan` tool on its first tool-using
 * round. From the declared `count` we derive:
 *   - soft cap = ceil(estimate * 2)  → warning + plan recall appended to
 *                                       the next tool result
 *   - hard cap = estimate * 4        → turn is terminated
 *
 * The plan also carries a short task list which is echoed back to the model
 * in the soft-warning text so it can re-anchor on its original intent.
 *
 * If the model uses tools without first declaring a plan, a default estimate
 * is applied silently (no plan recall in that case). Re-declarations within
 * the same turn are ignored.
 *
 * This module is a pure state machine — no I/O, no streaming. The orchestrator
 * in LlmService is the sole caller.
 */

export const PLAN_TOOL_NAME = 'plan'

export interface BudgetState {
  estimate: number | null
  plan: string[] | null
  actionToolCalls: number
  softWarningIssued: boolean
}

export interface PlanAck {
  call: ToolCall
  result: Record<string, unknown>
}

export interface RoundIngestion {
  planAcks: PlanAck[]
  actionCalls: ToolCall[]
  hardCapExceeded: { hardCap: number; estimate: number } | null
  softWarningToAppend: string | null
}

export function createBudget(): BudgetState {
  return {
    estimate: null,
    plan: null,
    actionToolCalls: 0,
    softWarningIssued: false
  }
}

export function softCap(estimate: number): number {
  return Math.ceil(estimate * 2)
}

export function hardCap(estimate: number): number {
  return estimate * 4
}

interface ParsedPlanArgs {
  count: number | null
  tasks: string[] | null      // null = invalid (not array, or array became empty after trim)
}

function parsePlanArgs(call: ToolCall): ParsedPlanArgs {
  const args = (call.arguments as Record<string, unknown> | undefined) ?? {}

  const rawCount = args.count
  const numCount = typeof rawCount === 'number' ? rawCount : Number(rawCount)
  const flooredCount = Number.isFinite(numCount) ? Math.floor(numCount) : NaN
  const count = Number.isFinite(flooredCount) && flooredCount >= 1 ? flooredCount : null

  const rawTasks = args.tasks
  let tasks: string[] | null = null
  if (typeof rawTasks === 'string') {
    // Coerce a bare string into a single-element list. Models occasionally
    // pass `tasks` as one comma-joined string instead of an array; treat it
    // as a single task rather than nacking the whole call.
    const trimmed = rawTasks.trim()
    tasks = trimmed.length > 0 ? [trimmed] : null
  } else if (Array.isArray(rawTasks)) {
    const cleaned = rawTasks
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    tasks = cleaned.length > 0 ? cleaned : null
  }

  return { count, tasks }
}

/**
 * Process one round of collected tool calls. Updates `state` in place,
 * returns the data the orchestrator needs to act on this round.
 *
 * Invariant: caller must dispatch the action calls exactly as returned.
 * The synthesized plan-ack results are owned by the orchestrator —
 * `plan` calls are never sent through normal tool dispatch.
 */
export function ingestRound(
  state: BudgetState,
  collected: ToolCall[],
  defaultEstimate: number
): RoundIngestion {
  const planCalls: ToolCall[] = []
  const actionCalls: ToolCall[] = []
  for (const call of collected) {
    if (call.name === PLAN_TOOL_NAME) {
      planCalls.push(call)
    } else {
      actionCalls.push(call)
    }
  }

  const planAcks: PlanAck[] = []

  for (const call of planCalls) {
    if (state.estimate === null) {
      const { count, tasks } = parsePlanArgs(call)
      if (count !== null && tasks !== null) {
        state.estimate = count
        state.plan = tasks
        planAcks.push({
          call,
          result: {
            acknowledged: true,
            declared: count,
            tasks,
            soft_cap: softCap(count),
            hard_cap: hardCap(count)
          }
        })
        continue
      }
      // Invalid args — leave state unset; ack as invalid so the model can retry.
      const reasons: string[] = []
      if (count === null) reasons.push('count must be an integer >= 1')
      if (tasks === null) reasons.push('tasks must be a non-empty array of non-empty strings')
      planAcks.push({
        call,
        result: {
          acknowledged: false,
          reason: `invalid plan; ${reasons.join('; ')}`
        }
      })
    } else {
      planAcks.push({
        call,
        result: {
          acknowledged: false,
          reason: 'plan locked',
          locked_at: { count: state.estimate, tasks: state.plan ?? [] }
        }
      })
    }
  }

  if (state.estimate === null && actionCalls.length > 0) {
    state.estimate = Math.max(1, Math.floor(defaultEstimate))
    // No plan to recall in fallback mode — state.plan stays null.
  }

  if (state.estimate === null) {
    return {
      planAcks,
      actionCalls,
      hardCapExceeded: null,
      softWarningToAppend: null
    }
  }

  const projected = state.actionToolCalls + actionCalls.length
  const hard = hardCap(state.estimate)

  if (actionCalls.length > 0 && projected > hard) {
    return {
      planAcks,
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
      hard,
      state.plan
    )
    state.softWarningIssued = true
  }

  return {
    planAcks,
    actionCalls,
    hardCapExceeded: null,
    softWarningToAppend
  }
}

function buildSoftWarning(
  used: number,
  estimate: number,
  soft: number,
  hard: number,
  plan: string[] | null
): string {
  const head =
    `Soft cap reached: ${used} tool calls used in this turn, at or above 2x your ` +
    `declared estimate of ${estimate} (soft cap = ${soft}, hard cut at ${hard}).`
  const recall = plan && plan.length > 0
    ? ` Your original plan was:\n${plan.map((t, i) => `  ${i + 1}) ${t}`).join('\n')}`
    : ''
  const tail = ' If you can wrap up cleanly soon, please do so.'
  return head + recall + tail
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
