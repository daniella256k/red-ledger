import type { Worker, WorkerOptions } from 'node:worker_threads'
import {
  backgroundTasks,
  type BackgroundPayload,
  type BackgroundResult,
  type BackgroundTaskName,
  type SerializedError
} from './backgroundTasks'
import { PathJailError } from '../services/pathJail'
import { DocumentExtractionError } from '../services/DocumentTextService'
import { AttachmentError } from '../services/AttachmentService'

/**
 * Runs background tasks off the main thread. The app installs a worker
 * factory at startup (main.ts); until then, and in tests, tasks run inline.
 *
 * Two workers, each started on first use: one for workspace searches and
 * one for documents and large files, so a slow PDF never holds up a search
 * from another chat. A task that runs past its time limit stops its worker
 * (the next task starts a fresh one), which also ends work a timeout inside
 * the task could not, like a walk over a huge folder.
 */

type WorkerFactory = (options: WorkerOptions) => Worker

type Lane = 'search' | 'documents'

const LANE_BY_TASK: Record<BackgroundTaskName, Lane> = {
  grep: 'search',
  extractDocument: 'documents',
  parseAttachments: 'documents',
  sliceTextFile: 'documents'
}

/** Longest a task may run before its worker is stopped. */
const TASK_TIME_LIMIT_MS: Record<BackgroundTaskName, number> = {
  grep: 60_000,
  extractDocument: 180_000,
  parseAttachments: 180_000,
  sliceTextFile: 180_000
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let createWorker: WorkerFactory | null = null
const lanes = new Map<Lane, LaneWorker>()

/** Errors keep their class across the thread boundary, so callers' instanceof checks still work. */
function reviveError(error: SerializedError): Error {
  switch (error.name) {
    case 'PathJailError':
      return new PathJailError(error.code ?? 'UNKNOWN', error.message)
    case 'DocumentExtractionError':
      return new DocumentExtractionError(error.message)
    case 'AttachmentError':
      return new AttachmentError(error.message)
    default:
      return Object.assign(new Error(error.message), error.code ? { code: error.code } : {})
  }
}

class LaneWorker {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1

  constructor(private readonly lane: Lane, private readonly factory: WorkerFactory) {}

  run(task: BackgroundTaskName, payload: unknown): Promise<unknown> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop(Object.assign(
          new Error(`This took longer than ${TASK_TIME_LIMIT_MS[task] / 1000} s and was stopped.`),
          { code: 'TIMEOUT' }
        ))
      }, TASK_TIME_LIMIT_MS[task])
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, task, payload })
    })
  }

  /** Stops the worker; anything still waiting on it fails with `reason`. */
  stop(reason: Error): void {
    const worker = this.worker
    this.worker = null
    this.failAll(reason)
    void worker?.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = this.factory({ name: `red-ledger-${this.lane}` })
    worker.on('message', (message: { id: number; ok: boolean; result?: unknown; error?: SerializedError }) => {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(reviveError(message.error ?? { name: 'Error', message: 'Background task failed' }))
    })
    worker.on('error', (err) => {
      if (this.worker === worker) this.stop(err instanceof Error ? err : new Error(String(err)))
    })
    worker.on('exit', () => {
      if (this.worker === worker) {
        this.worker = null
        this.failAll(new Error('The background worker stopped unexpectedly.'))
      }
    })
    // Never what keeps the app from quitting.
    worker.unref()
    this.worker = worker
    return worker
  }

  private failAll(reason: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
  }
}

/** Runs tasks in worker threads from now on (called once at startup); null goes back to inline. */
export function useWorkerThreads(factory: WorkerFactory | null): void {
  stopBackgroundWorkers()
  createWorker = factory
}

/** Runs a background task: in its worker when the app installed one, inline otherwise. */
export async function runInBackground<T extends BackgroundTaskName>(
  task: T,
  payload: BackgroundPayload<T>
): Promise<BackgroundResult<T>> {
  if (!createWorker) {
    const run = backgroundTasks[task] as (input: BackgroundPayload<T>) => BackgroundResult<T> | Promise<BackgroundResult<T>>
    return run(payload)
  }
  const lane = LANE_BY_TASK[task]
  let worker = lanes.get(lane)
  if (!worker) {
    worker = new LaneWorker(lane, createWorker)
    lanes.set(lane, worker)
  }
  return worker.run(task, payload) as Promise<BackgroundResult<T>>
}

/** Stops every worker, before the app quits. */
export function stopBackgroundWorkers(): void {
  for (const worker of lanes.values()) worker.stop(new Error('The app is closing.'))
  lanes.clear()
}
