import type { Worker } from 'node:worker_threads'
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
 * Runs background tasks off the main thread. The app installs a runner per
 * lane at startup (main.ts); until then, and in tests, tasks run inline.
 *
 * Two lanes, each started on first use, so a slow PDF never holds up a
 * search from another chat:
 * - search: workspace searches, in a worker thread.
 * - documents: PDF, Word and spreadsheet text and large-file paging, in a
 *   separate process. pdf.js crashes the whole app when a worker thread it
 *   ran in is stopped; stopping a process is always safe, and a parser that
 *   crashes on a bad file only takes its own process down.
 *
 * A task that runs past its time limit stops its lane's runner, which also
 * ends work a timeout inside the task could not, like a walk over a huge
 * folder. Only that task fails: the others waiting in the lane (another
 * chat's read, say) start again in a fresh runner. Every task only reads, so
 * running one again is safe. A runner that crashes fails everything it had,
 * since there is no telling which task brought it down.
 */

export type Lane = 'search' | 'documents'

/** A started task runner (thread or process): where tasks are sent and results come back. */
export interface TaskChannel {
  post(message: unknown): void
  onMessage(listener: (message: unknown) => void): void
  /** Called once if the runner stops on its own (crash or exit), with why. */
  onExit(listener: (reason: Error) => void): void
  /** Stops the runner. */
  stop(): void
}

export type ChannelFactory = () => TaskChannel

const LANE_BY_TASK: Record<BackgroundTaskName, Lane> = {
  grep: 'search',
  extractDocument: 'documents',
  parseAttachments: 'documents',
  sliceTextFile: 'documents'
}

/** Longest a task may run before its runner is stopped. */
const TASK_TIME_LIMIT_MS: Record<BackgroundTaskName, number> = {
  grep: 60_000,
  extractDocument: 180_000,
  parseAttachments: 180_000,
  sliceTextFile: 180_000
}

interface Pending {
  task: BackgroundTaskName
  payload: unknown
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface TaskResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: SerializedError
}

let factories: Partial<Record<Lane, ChannelFactory>> | null = null
const lanes = new Map<Lane, LaneRunner>()

/** Errors keep their class across the boundary, so callers' instanceof checks still work. */
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

/** A worker thread as a task channel. */
export function channelFromWorker(worker: Worker): TaskChannel {
  // Never what keeps the app from quitting.
  worker.unref()
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (listener) => { worker.on('message', listener) },
    onExit: (listener) => {
      let reported = false
      const report = (reason: Error) => {
        if (reported) return
        reported = true
        listener(reason)
      }
      worker.on('error', (err) => report(err instanceof Error ? err : new Error(String(err))))
      worker.on('exit', () => report(new Error('The background worker stopped unexpectedly.')))
    },
    stop: () => { void worker.terminate() }
  }
}

class LaneRunner {
  private channel: TaskChannel | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1

  constructor(private readonly factory: ChannelFactory) {}

  run(task: BackgroundTaskName, payload: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { task, payload, resolve, reject, timer: this.startTimer(id, task) })
      this.ensureChannel().post({ id, task, payload })
    })
  }

  private startTimer(id: number, task: BackgroundTaskName): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.timeOut(id), TASK_TIME_LIMIT_MS[task])
  }

  /**
   * A task ran too long: it fails, its runner is stopped, and the lane's
   * other tasks are sent again to a fresh runner, each with its full time.
   */
  private timeOut(id: number): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.reject(Object.assign(
      new Error(`This took longer than ${TASK_TIME_LIMIT_MS[entry.task] / 1000} s and was stopped.`),
      { code: 'TIMEOUT' }
    ))

    const channel = this.channel
    this.channel = null
    channel?.stop()
    if (this.pending.size === 0) return
    const fresh = this.ensureChannel()
    for (const [otherId, other] of this.pending) {
      clearTimeout(other.timer)
      other.timer = this.startTimer(otherId, other.task)
      fresh.post({ id: otherId, task: other.task, payload: other.payload })
    }
  }

  /** Stops the runner; anything still waiting on it fails with `reason`. */
  stop(reason: Error): void {
    const channel = this.channel
    this.channel = null
    this.failAll(reason)
    channel?.stop()
  }

  private ensureChannel(): TaskChannel {
    if (this.channel) return this.channel
    const channel = this.factory()
    channel.onMessage((raw) => {
      const message = raw as TaskResponse
      const entry = this.pending.get(message?.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(reviveError(message.error ?? { name: 'Error', message: 'Background task failed' }))
    })
    channel.onExit((reason) => {
      if (this.channel !== channel) return
      this.channel = null
      this.failAll(reason)
    })
    this.channel = channel
    return channel
  }

  private failAll(reason: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
  }
}

/**
 * Runs each lane's tasks in a runner from `factories` from now on (called
 * once at startup); a lane without one, or null for all, runs inline.
 */
export function useBackgroundRunners(next: Partial<Record<Lane, ChannelFactory>> | null): void {
  stopBackgroundWorkers()
  factories = next
}

/** Runs a background task: in its lane's runner when the app installed one, inline otherwise. */
export async function runInBackground<T extends BackgroundTaskName>(
  task: T,
  payload: BackgroundPayload<T>
): Promise<BackgroundResult<T>> {
  const lane = LANE_BY_TASK[task]
  const factory = factories?.[lane]
  if (!factory) {
    const run = backgroundTasks[task] as (input: BackgroundPayload<T>) => BackgroundResult<T> | Promise<BackgroundResult<T>>
    return run(payload)
  }
  let runner = lanes.get(lane)
  if (!runner) {
    runner = new LaneRunner(factory)
    lanes.set(lane, runner)
  }
  return runner.run(task, payload) as Promise<BackgroundResult<T>>
}

/** Stops every runner, before the app quits. */
export function stopBackgroundWorkers(): void {
  for (const runner of lanes.values()) runner.stop(new Error('The app is closing.'))
  lanes.clear()
}
