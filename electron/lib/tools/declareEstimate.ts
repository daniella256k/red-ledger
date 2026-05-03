import { registerTool } from './registry'
import { DECLARE_ESTIMATE_TOOL_NAME } from '../budget/budgetTracker'

/**
 * declare_estimate is a metadata tool: the orchestrator in LlmService
 * intercepts these calls and synthesizes the result. This stub executor
 * is a safety net only — if the orchestrator ever fails to intercept,
 * the model still gets a sensible reply instead of an "unknown tool"
 * error.
 */
registerTool({
  definition: {
    type: 'function',
    function: {
      name: DECLARE_ESTIMATE_TOOL_NAME,
      description:
        'REQUIRED before any other tool call in a turn. Declare an honest integer ' +
        'estimate of how many tool calls you will need to fulfill the user\'s request. ' +
        'Sizing guide: simple lookup 1-3, multi-step task 5-10, larger exploration ' +
        'or refactor 15-30+. Caps derived from your estimate: soft warning at ' +
        'ceil(estimate * 1.5), hard cut at estimate * 4. The estimate locks on first ' +
        'declaration; later declare_estimate calls do not change the budget. Turns ' +
        'that need no tools do not need to declare anything.',
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            description:
              'Estimated number of tool calls needed for this turn (must be >= 1). ' +
              'Choose honestly: small estimates leave less headroom; large estimates ' +
              'indicate complex work.'
          }
        },
        required: ['count']
      }
    }
  },
  execute: async (args) => {
    const raw = (args as Record<string, unknown>)?.count
    const num = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(num) || num < 1) {
      return { acknowledged: false, reason: 'invalid count' }
    }
    return { acknowledged: true, declared: Math.floor(num) }
  }
})
