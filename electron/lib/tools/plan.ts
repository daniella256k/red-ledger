import { registerTool } from './registry'
import { PLAN_TOOL_NAME } from '../budget/budgetTracker'

/**
 * `plan` is a metadata tool: the orchestrator in LlmService intercepts these
 * calls and synthesizes the result. This stub executor is a safety net only —
 * if the orchestrator ever fails to intercept, the model still gets a sensible
 * reply instead of an "unknown tool" error.
 */
registerTool({
  definition: {
    type: 'function',
    function: {
      name: PLAN_TOOL_NAME,
      description:
        'Declare your plan and tool-call estimate before doing any tool work. ' +
        '`count` is your honest integer estimate of how many tool calls you will ' +
        'need this turn (>=1). `tasks` is a short list of one or more concrete ' +
        'task descriptions describing what you intend to do. The first valid plan ' +
        'call locks the budget for the turn; later plan calls are nacked. Empty ' +
        'or whitespace-only task entries are dropped silently; the call is only ' +
        'rejected if no usable tasks remain.',
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            description:
              'Estimated number of tool calls needed for this turn (must be >= 1).'
          },
          tasks: {
            type: 'array',
            description:
              'Array of one or more short non-empty strings, each describing a ' +
              'concrete task you intend to perform this turn. Acts as a self-' +
              'directed checklist and is echoed back to you if the soft cap is ' +
              'crossed.'
          }
        },
        required: ['count', 'tasks']
      }
    }
  },
  execute: async (args) => {
    const a = (args as Record<string, unknown>) ?? {}
    const rawCount = a.count
    const num = typeof rawCount === 'number' ? rawCount : Number(rawCount)
    const count = Number.isFinite(num) && num >= 1 ? Math.floor(num) : null

    const rawTasks = a.tasks
    let tasks: string[] = []
    if (typeof rawTasks === 'string') {
      const trimmed = rawTasks.trim()
      if (trimmed.length > 0) tasks = [trimmed]
    } else if (Array.isArray(rawTasks)) {
      tasks = rawTasks
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    }

    if (count === null || tasks.length === 0) {
      return { acknowledged: false, reason: 'invalid plan' }
    }
    return { acknowledged: true, declared: count, tasks }
  }
})
