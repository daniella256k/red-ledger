import { describe, it, expect } from 'vitest'
import {
  createBudget,
  ingestRound,
  softCap,
  hardCap,
  attachSoftWarning,
  SOFT_WARNING_FIELD,
  DECLARE_ESTIMATE_TOOL_NAME
} from '../budgetTracker'
import type { ToolCall } from '../../../../src/types'

function estimateCall(count: unknown, id = 'est-1'): ToolCall {
  return {
    id,
    name: DECLARE_ESTIMATE_TOOL_NAME,
    arguments: { count } as Record<string, unknown>
  }
}

function actionCall(name = 'read_file', id = `act-${Math.random().toString(36).slice(2, 8)}`): ToolCall {
  return {
    id,
    name,
    arguments: { path: 'x.txt' }
  }
}

describe('budgetTracker — caps', () => {
  it('softCap = ceil(estimate * 1.5)', () => {
    expect(softCap(1)).toBe(2)
    expect(softCap(2)).toBe(3)
    expect(softCap(5)).toBe(8)
    expect(softCap(10)).toBe(15)
  })

  it('hardCap = estimate * 4', () => {
    expect(hardCap(1)).toBe(4)
    expect(hardCap(5)).toBe(20)
    expect(hardCap(10)).toBe(40)
  })
})

describe('budgetTracker — ingestRound', () => {
  it('captures estimate from declare_estimate and acks it', () => {
    const state = createBudget()
    const result = ingestRound(state, [estimateCall(5)], 3)
    expect(state.estimate).toBe(5)
    expect(state.actionToolCalls).toBe(0)
    expect(result.estimateAcks).toHaveLength(1)
    expect(result.estimateAcks[0].result).toMatchObject({
      acknowledged: true,
      declared: 5,
      soft_cap: 8,
      hard_cap: 20
    })
    expect(result.actionCalls).toEqual([])
    expect(result.hardCapExceeded).toBeNull()
    expect(result.softWarningToAppend).toBeNull()
  })

  it('counts non-estimate calls and stays silent under soft cap', () => {
    const state = createBudget()
    ingestRound(state, [estimateCall(5)], 3)
    const r = ingestRound(state, [actionCall(), actionCall(), actionCall()], 3)
    expect(state.actionToolCalls).toBe(3)
    expect(r.softWarningToAppend).toBeNull()
    expect(r.hardCapExceeded).toBeNull()
    expect(r.actionCalls).toHaveLength(3)
  })

  it('emits a soft warning the first time the soft cap is reached', () => {
    const state = createBudget()
    ingestRound(state, [estimateCall(5)], 3)
    // soft cap = ceil(5 * 1.5) = 8
    for (let i = 0; i < 7; i++) {
      const r = ingestRound(state, [actionCall()], 3)
      expect(r.softWarningToAppend).toBeNull()
    }
    const r8 = ingestRound(state, [actionCall()], 3)
    expect(state.actionToolCalls).toBe(8)
    expect(r8.softWarningToAppend).toContain('Soft cap reached')
    expect(r8.softWarningToAppend).toContain('estimate of 5')
    expect(state.softWarningIssued).toBe(true)
  })

  it('only emits the soft warning once across rounds', () => {
    const state = createBudget()
    ingestRound(state, [estimateCall(5)], 3)
    for (let i = 0; i < 8; i++) ingestRound(state, [actionCall()], 3)
    expect(state.softWarningIssued).toBe(true)
    const r = ingestRound(state, [actionCall()], 3)
    expect(r.softWarningToAppend).toBeNull()
  })

  it('signals hardCapExceeded and does not increment when projected count would exceed hard cap', () => {
    const state = createBudget()
    ingestRound(state, [estimateCall(2)], 3)
    // hard cap = 8
    for (let i = 0; i < 8; i++) ingestRound(state, [actionCall()], 3)
    expect(state.actionToolCalls).toBe(8)
    const overflow = ingestRound(state, [actionCall()], 3)
    expect(overflow.hardCapExceeded).toEqual({ hardCap: 8, estimate: 2 })
    // counter must not advance when hard cap blocks the round
    expect(state.actionToolCalls).toBe(8)
  })

  it('falls back to default estimate when action tool used without prior declaration', () => {
    const state = createBudget()
    const r = ingestRound(state, [actionCall(), actionCall()], 4)
    expect(state.estimate).toBe(4)
    expect(state.actionToolCalls).toBe(2)
    expect(r.estimateAcks).toHaveLength(0)
    expect(r.actionCalls).toHaveLength(2)
  })

  it('clamps invalid default estimate to >= 1', () => {
    const state = createBudget()
    ingestRound(state, [actionCall()], 0)
    expect(state.estimate).toBe(1)
  })

  it('locks estimate after first valid declaration; later declarations are nacked', () => {
    const state = createBudget()
    ingestRound(state, [estimateCall(5)], 3)
    const r = ingestRound(state, [estimateCall(50)], 3)
    expect(state.estimate).toBe(5)
    expect(r.estimateAcks).toHaveLength(1)
    expect(r.estimateAcks[0].result).toMatchObject({
      acknowledged: false,
      reason: 'estimate locked',
      locked_at: 5
    })
  })

  it('rejects invalid count (non-finite, fractional <1, negative, missing) and acks as invalid', () => {
    const cases: Array<unknown> = ['nope', NaN, -3, 0, 0.5, undefined, null]
    for (const value of cases) {
      const state = createBudget()
      const r = ingestRound(state, [estimateCall(value)], 3)
      expect(state.estimate).toBeNull()
      expect(r.estimateAcks[0].result).toMatchObject({
        acknowledged: false,
        reason: 'invalid count; estimate not set'
      })
    }
  })

  it('floors fractional valid counts (>=1)', () => {
    const state = createBudget()
    ingestRound(state, [estimateCall(7.9)], 3)
    expect(state.estimate).toBe(7)
  })

  it('handles a round containing both an estimate and action calls together', () => {
    const state = createBudget()
    const r = ingestRound(state, [estimateCall(3), actionCall(), actionCall()], 5)
    expect(state.estimate).toBe(3)
    expect(state.actionToolCalls).toBe(2)
    expect(r.estimateAcks).toHaveLength(1)
    expect(r.actionCalls).toHaveLength(2)
    expect(r.softWarningToAppend).toBeNull()
  })

  it('soft warning fires when actions in same round push count over soft cap', () => {
    const state = createBudget()
    // estimate 2 → soft cap 3, hard cap 8
    const r = ingestRound(
      state,
      [estimateCall(2), actionCall(), actionCall(), actionCall()],
      5
    )
    expect(state.actionToolCalls).toBe(3)
    expect(r.softWarningToAppend).toContain('Soft cap reached')
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
