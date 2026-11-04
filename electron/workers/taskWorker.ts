import { parentPort } from 'node:worker_threads'
import { backgroundTasks, serializeError, type BackgroundTaskName } from './backgroundTasks'

/**
 * Entry for background tasks (see backgroundTasks.ts): runs each task the
 * main process sends and posts its result or error back under its id.
 *
 * The same file runs three ways: as a worker thread (workspace searches), as
 * an Electron utility process (documents: a separate process, because pdf.js
 * crashes a worker thread when the thread is stopped, and a process also
 * keeps a parser crash away from the app), and as a Node child process
 * (scripts/check-build.mjs, where Electron isn't available).
 */

interface TaskRequest {
  id: number
  task: BackgroundTaskName
  payload: unknown
}

type Reply = (message: unknown) => void

async function handle({ id, task, payload }: TaskRequest, reply: Reply): Promise<void> {
  try {
    const run = backgroundTasks[task] as (input: unknown) => unknown
    if (typeof run !== 'function') throw new Error(`Unknown background task: ${String(task)}`)
    reply({ id, ok: true, result: await run(payload) })
  } catch (err) {
    reply({ id, ok: false, error: serializeError(err) })
  }
}

/** Electron's utility process channel (process.parentPort), when this runs as one. */
interface UtilityParentPort {
  on(event: 'message', listener: (event: { data: TaskRequest }) => void): void
  postMessage(message: unknown): void
}

const utilityPort = (process as unknown as { parentPort?: UtilityParentPort }).parentPort

if (parentPort) {
  const port = parentPort
  port.on('message', (request: TaskRequest) => void handle(request, (message) => port.postMessage(message)))
} else if (utilityPort) {
  // pdf.js decides it runs in Node only when process.type is unset or
  // 'browser'; in a utility process it is 'utility', so pdf.js would take
  // the browser path (web workers, fetch, DOM canvas) and fail. The code
  // here is plain Node, so say so. pdf.js loads lazily, after this runs.
  try {
    Object.defineProperty(process, 'type', { value: undefined, configurable: true, writable: true })
  } catch (err) {
    console.warn('[taskWorker] Could not clear process.type; PDF text extraction may fail:', err)
  }
  utilityPort.on('message', ({ data }) => void handle(data, (message) => utilityPort.postMessage(message)))
} else if (process.send) {
  process.on('message', (request: TaskRequest) => void handle(request, (message) => process.send?.(message)))
}
