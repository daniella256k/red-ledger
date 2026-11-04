import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Worker } from 'node:worker_threads'
import { runInBackground, stopBackgroundWorkers, useWorkerThreads } from '../background'
import { backgroundTasks, serializeError } from '../backgroundTasks'
import { PathJailError } from '../../services/pathJail'
import { DocumentExtractionError } from '../../services/DocumentTextService'

/**
 * A stand-in for a worker thread that runs tasks the way taskWorker.ts does,
 * on this thread, so the runner's messaging, error and restart handling can
 * be tested without starting real threads.
 */
class FakeWorker extends EventEmitter {
  static started = 0
  terminated = false
  /** Set to leave every task unanswered, as a stuck worker would. */
  hang = false

  constructor() {
    super()
    FakeWorker.started += 1
  }

  postMessage({ id, task, payload }: { id: number; task: keyof typeof backgroundTasks; payload: unknown }) {
    if (this.hang) return
    void (async () => {
      try {
        const result = await (backgroundTasks[task] as (input: unknown) => unknown)(payload)
        this.emit('message', { id, ok: true, result })
      } catch (err) {
        this.emit('message', { id, ok: false, error: serializeError(err) })
      }
    })()
  }

  unref() {}

  async terminate() {
    this.terminated = true
    return 0
  }
}

const dirs: string[] = []
const workers: FakeWorker[] = []

function useFakeWorkers(options: { hang?: boolean } = {}) {
  useWorkerThreads(() => {
    const worker = new FakeWorker()
    worker.hang = options.hang === true
    workers.push(worker)
    return worker as unknown as Worker
  })
}

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rl-background-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  useWorkerThreads(null)
  workers.splice(0)
  FakeWorker.started = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('background tasks', () => {
  it('run inline when no worker is installed', async () => {
    const root = workspace({ 'a.txt': 'needle here' })
    const matches = await runInBackground('grep', { workspaceRoot: root, options: { pattern: 'needle' } })
    expect(matches.map((m) => m.path)).toEqual(['a.txt'])
  })

  it('run in a worker, one per kind of work, started on first use', async () => {
    useFakeWorkers()
    const root = workspace({ 'a.txt': 'needle here', 'b.txt': 'line 1\nline 2\n' })

    const [matches, page] = await Promise.all([
      runInBackground('grep', { workspaceRoot: root, options: { pattern: 'needle' } }),
      runInBackground('sliceTextFile', { filePath: join(root, 'b.txt'), options: { offset: 2 } })
    ])
    await runInBackground('grep', { workspaceRoot: root, options: { pattern: 'line' } })

    expect(matches).toHaveLength(1)
    expect(page.content).toBe('2 | line 2')
    // Searches and file work each got their own worker, reused for later tasks.
    expect(FakeWorker.started).toBe(2)
  })

  it('keep the error classes callers check', async () => {
    useFakeWorkers()
    const root = workspace({})

    const outside = runInBackground('grep', { workspaceRoot: root, options: { pattern: 'x', path: '../elsewhere' } })
    await expect(outside).rejects.toBeInstanceOf(PathJailError)
    await expect(outside).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })

    writeFileSync(join(root, 'broken.docx'), 'not really a Word file')
    await expect(runInBackground('extractDocument', { filePath: join(root, 'broken.docx') }))
      .rejects.toBeInstanceOf(DocumentExtractionError)
  })

  it('stop a worker that runs past the time limit, and start a fresh one for the next task', async () => {
    vi.useFakeTimers()
    useFakeWorkers({ hang: true })
    const root = workspace({})

    const stuck = runInBackground('grep', { workspaceRoot: root, options: { pattern: 'x' } })
    const failed = expect(stuck).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(61_000)
    await failed
    expect(workers[0].terminated).toBe(true)

    void runInBackground('grep', { workspaceRoot: root, options: { pattern: 'x' } }).catch(() => {})
    expect(FakeWorker.started).toBe(2)
  })

  it('fail what was waiting when a worker crashes', async () => {
    useFakeWorkers({ hang: true })
    const root = workspace({})

    const waiting = runInBackground('grep', { workspaceRoot: root, options: { pattern: 'x' } })
    workers[0].emit('exit', 1)
    await expect(waiting).rejects.toThrow(/stopped unexpectedly/)
  })

  it('stop every worker when the app quits', async () => {
    useFakeWorkers({ hang: true })
    const root = workspace({})

    const waiting = runInBackground('grep', { workspaceRoot: root, options: { pattern: 'x' } })
    stopBackgroundWorkers()
    await expect(waiting).rejects.toThrow(/closing/)
    expect(workers[0].terminated).toBe(true)
  })
})
