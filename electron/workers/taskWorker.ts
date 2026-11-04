import { parentPort } from 'node:worker_threads'
import { backgroundTasks, serializeError, type BackgroundTaskName } from './backgroundTasks'

/**
 * Worker thread entry: runs background tasks (see backgroundTasks.ts) sent
 * by the main process and posts each result or error back under its id.
 */

interface TaskRequest {
  id: number
  task: BackgroundTaskName
  payload: unknown
}

parentPort?.on('message', async ({ id, task, payload }: TaskRequest) => {
  try {
    const run = backgroundTasks[task] as (input: unknown) => unknown
    if (typeof run !== 'function') throw new Error(`Unknown background task: ${String(task)}`)
    const result = await run(payload)
    parentPort?.postMessage({ id, ok: true, result })
  } catch (err) {
    parentPort?.postMessage({ id, ok: false, error: serializeError(err) })
  }
})
