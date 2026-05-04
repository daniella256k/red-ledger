import { describe, it, expect } from 'vitest'
import {
  createBudget,
  ingestRound,
  softCap,
  hardCap,
  attachSoftWarning,
  SOFT_WARNING_FIELD,
  PLAN_TOOL_NAME
} from '../budgetTracker'
import type { ToolCall } from '../../../../src/types'

function planCall(
  args: { count?: unknown; tasks?: unknown },
  id = 'plan-1'
): ToolCall {
  return {
    id,
    name: PLAN_TOOL_NAME,
    arguments: args as Record<string, unknown>
  }
}

function validPlan(count: number, tasks: string[] = ['do the thing'], id = 'plan-1'): ToolCall {
  return planCall({ count, tasks }, id)
}

function actionCall(name = 'read_file', id = `act-${Math.random().toString(36).slice(2, 8)}`): ToolCall {
  return {
    id,
    name,
    arguments: { path: 'x.txt' }
  }
}

describe('budgetTracker — caps', () => {
  it('softCap = ceil(estimate * 2)', () => {
    expect(softCap(1)).toBe(2)
    expect(softCap(2)).toBe(4)
    expect(softCap(5)).toBe(10)
    expect(softCap(8)).toBe(16)
    expect(softCap(10)).toBe(20)
  })

  it('hardCap = estimate * 4', () => {
    expect(hardCap(1)).toBe(4)
    expect(hardCap(5)).toBe(20)
    expect(hardCap(10)).toBe(40)
  })
})

describe('budgetTracker — ingestRound', () => {
  it('captures count and tasks from plan call and acks them', () => {
    const state = createBudget()
    const r = ingestRound(state, [validPlan(5, ['step a', 'step b'])], 3)
    expect(state.estimate).toBe(5)
    expect(state.plan).toEqual(['step a', 'step b'])
    expect(state.actionToolCalls).toBe(0)
    expect(r.planAcks).toHaveLength(1)
    expect(r.planAcks[0].result).toMatchObject({
      acknowledged: true,
      declared: 5,
      tasks: ['step a', 'step b'],
      soft_cap: 10,
      hard_cap: 20
    })
    expect(r.actionCalls).toEqual([])
    expect(r.hardCapExceeded).toBeNull()
    expect(r.softWarningToAppend).toBeNull()
  })

  it('counts non-plan calls and stays silent under soft cap', () => {
    const state = createBudget()
    ingestRound(state, [validPlan(5)], 3)
    // soft cap = 10 — 3 calls is well below
    const r = ingestRound(state, [actionCall(), actionCall(), actionCall()], 3)
    expect(state.actionToolCalls).toBe(3)
    expect(r.softWarningToAppend).toBeNull()
    expect(r.hardCapExceeded).toBeNull()
    expect(r.actionCalls).toHaveLength(3)
  })

  it('emits a soft warning the first time the soft cap is reached', () => {
    const state = createBudget()
    ingestRound(state, [validPlan(5, ['plan a', 'plan b'])], 3)
    // soft cap = 5 * 2 = 10
    for (let i = 0; i < 9; i++) {
      const r = ingestRound(state, [actionCall()], 3)
      expect(r.softWarningToAppend).toBeNull()
    }
    const r10 = ingestRound(state, [actionCall()], 3)
    expect(state.actionToolCalls).toBe(10)
    expect(r10.softWarningToAppend).toContain('Soft cap reached')
    expect(r10.softWarningToAppend).toContain('estimate of 5')
    expect(r10.softWarningToAppend).toContain('1) plan a')
    expect(r10.softWarningToAppend).toContain('2) plan b')
    expect(state.softWarningIssued).toBe(true)
  })

  it('only emits the soft warning once across rounds', () => {
    const state = createBudget()
    ingestRound(state, [validPlan(5)], 3)
    for (let i = 0; i < 10; i++) ingestRound(state, [actionCall()], 3)
    expect(state.softWarningIssued).toBe(true)
    const r = ingestRound(state, [actionCall()], 3)
    expect(r.softWarningToAppend).toBeNull()
  })

  it('signals hardCapExceeded and does not increment when projected count would exceed hard cap', () => {
    const state = createBudget()
    ingestRound(state, [validPlan(2)], 3)
    // hard cap = 8
    for (let i = 0; i < 8; i++) ingestRound(state, [actionCall()], 3)
    expect(state.actionToolCalls).toBe(8)
    const overflow = ingestRound(state, [actionCall()], 3)
    expect(overflow.hardCapExceeded).toEqual({ hardCap: 8, estimate: 2 })
    // counter must not advance when hard cap blocks the round
    expect(state.actionToolCalls).toBe(8)
  })

  it('falls back to default estimate when action tool used without prior plan', () => {
    const state = createBudget()
    const r = ingestRound(state, [actionCall(), actionCall()], 4)
    expect(state.estimate).toBe(4)
    expect(state.plan).toBeNull()
    expect(state.actionToolCalls).toBe(2)
    expect(r.planAcks).toHaveLength(0)
    expect(r.actionCalls).toHaveLength(2)
  })

  it('soft warning omits plan recall when running on default estimate fallback', () => {
    const state = createBudget()
    // default estimate = 2, soft cap = 4
    for (let i = 0; i < 4; i++) ingestRound(state, [actionCall()], 2)
    expect(state.softWarningIssued).toBe(true)
    // The 4th round was the one that crossed; we need to inspect that round's output.
    // Re-run to verify the structure: rebuild a fresh state.
    const fresh = createBudget()
    let warningSeen: string | null = null
    for (let i = 0; i < 4; i++) {
      const r = ingestRound(fresh, [actionCall()], 2)
      if (r.softWarningToAppend) warningSeen = r.softWarningToAppend
    }
    expect(warningSeen).toBeTruthy()
    expect(warningSeen).toContain('Soft cap reached')
    expect(warningSeen).not.toContain('Your original plan was')
  })

  it('clamps invalid default estimate to >= 1', () => {
    const state = createBudget()
    ingestRound(state, [actionCall()], 0)
    expect(state.estimate).toBe(1)
  })

  it('locks plan after first valid declaration; later plan calls are nacked with locked details', () => {
    const state = createBudget()
    ingestRound(state, [validPlan(5, ['original'])], 3)
    const r = ingestRound(state, [validPlan(50, ['new plan'])], 3)
    expect(state.estimate).toBe(5)
    expect(state.plan).toEqual(['original'])
    expect(r.planAcks).toHaveLength(1)
    expect(r.planAcks[0].result).toMatchObject({
      acknowledged: false,
      reason: 'plan locked',
      locked_at: { count: 5, tasks: ['original'] }
    })
  })

  it('rejects invalid count and acks with reason; state stays unset', () => {
    const cases: Array<unknown> = ['nope', NaN, -3, 0, 0.5, undefined, null]
    for (const value of cases) {
      const state = createBudget()
      const r = ingestRound(state, [planCall({ count: value, tasks: ['x'] })], 3)
      expect(state.estimate).toBeNull()
      expect(state.plan).toBeNull()
      expect(r.planAcks[0].result).toMatchObject({ acknowledged: false })
      expect((r.planAcks[0].result as { reason: string }).reason).toContain('count must be an integer >= 1')
    }
  })

  it('rejects invalid tasks (wrong type, empty array, all whitespace) and acks with reason', () => {
    const cases: Array<unknown> = [
      undefined,
      null,
      42,
      true,
      { not: 'a list' },
      [],
      ['', '   ', '\t\n'],
      [42, true, {}]
    ]
    for (const value of cases) {
      const state = createBudget()
      const r = ingestRound(state, [planCall({ count: 5, tasks: value })], 3)
      expect(state.estimate).toBeNull()
      expect((r.planAcks[0].result as { reason: string }).reason).toContain('tasks must be a non-empty array')
    }
  })

  it('coerces a non-empty string `tasks` into a one-element array', () => {
    const state = createBudget()
    const blurb = 'Search news, scan marxist.com, compile digest'
    const r = ingestRound(state, [planCall({ count: 5, tasks: blurb })], 3)
    expect(state.estimate).toBe(5)
    expect(state.plan).toEqual([blurb])
    expect(r.planAcks[0].result).toMatchObject({
      acknowledged: true,
      declared: 5,
      tasks: [blurb]
    })
  })

  it('trims a coerced string and nacks if it is whitespace-only', () => {
    const stateOk = createBudget()
    const r1 = ingestRound(stateOk, [planCall({ count: 3, tasks: '   real task   ' })], 3)
    expect(stateOk.plan).toEqual(['real task'])
    expect((r1.planAcks[0].result as { acknowledged: boolean }).acknowledged).toBe(true)

    const stateBad = createBudget()
    const r2 = ingestRound(stateBad, [planCall({ count: 3, tasks: '   ' })], 3)
    expect(stateBad.estimate).toBeNull()
    expect(stateBad.plan).toBeNull()
    expect((r2.planAcks[0].result as { reason: string }).reason).toContain('tasks must be a non-empty array')
  })

  it('silently drops empty/whitespace task entries but accepts the plan if at least one remains', () => {
    const state = createBudget()
    const r = ingestRound(
      state,
      [planCall({ count: 3, tasks: ['', '  real task  ', '\t', 'another'] })],
      5
    )
    expect(state.estimate).toBe(3)
    expect(state.plan).toEqual(['real task', 'another'])
    expect(r.planAcks[0].result).toMatchObject({
      acknowledged: true,
      tasks: ['real task', 'another']
    })
  })

  it('floors fractional valid counts (>=1)', () => {
    const state = createBudget()
    ingestRound(state, [planCall({ count: 7.9, tasks: ['t'] })], 3)
    expect(state.estimate).toBe(7)
  })

  it('handles a round containing both a plan and action calls together', () => {
    const state = createBudget()
    const r = ingestRound(
      state,
      [validPlan(3, ['inline plan']), actionCall(), actionCall()],
      5
    )
    expect(state.estimate).toBe(3)
    expect(state.plan).toEqual(['inline plan'])
    expect(state.actionToolCalls).toBe(2)
    expect(r.planAcks).toHaveLength(1)
    expect(r.actionCalls).toHaveLength(2)
    expect(r.softWarningToAppend).toBeNull()
  })

  it('soft warning fires when actions in same round push count over soft cap', () => {
    const state = createBudget()
    // estimate 2 → soft cap 4, hard cap 8
    const r = ingestRound(
      state,
      [validPlan(2, ['p']), actionCall(), actionCall(), actionCall(), actionCall()],
      5
    )
    expect(state.actionToolCalls).toBe(4)
    expect(r.softWarningToAppend).toContain('Soft cap reached')
    expect(r.softWarningToAppend).toContain('1) p')
  })
})

describe('budgetTracker — attachSoftWarning', () => {
  it('adds field to object results', () => {
    const out = attachSoftWarning({ ok: true, value: 42 }, 'warn!') as Record<string, unknown>
    expect(out).toEqual({ ok: true, value: 42, [SOFT_WARNING_FIELD]: 'warn!' })
  })

  it('wraps primitive results', () => {
    const out = attachSoftWarning('hello', 'warn!') as Record<string, unknown>
    expect(out).toEqual({ value: 'hello', [SOFT_WARNING_FIELD]: 'warn!' })
  })

  it('wraps array results (treated as non-object)', () => {
    const out = attachSoftWarning([1, 2, 3], 'warn!') as Record<string, unknown>
    expect(out).toEqual({ value: [1, 2, 3], [SOFT_WARNING_FIELD]: 'warn!' })
  })
})
