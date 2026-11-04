import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runInBackground, stopBackgroundWorkers, useBackgroundRunners, type TaskChannel } from '../background'
import { backgroundTasks, serializeError } from '../backgroundTasks'
import { PathJailError } from '../../services/pathJail'
import { DocumentExtractionError } from '../../services/DocumentTextService'

/**
 * A stand-in for a task runner (thread or process) that runs tasks the way
 * taskWorker.ts does, on this thread, so the runner's messaging, error and
 * restart handling can be tested without starting real ones.
 */
class FakeChannel implements TaskChannel {
  static started: FakeChannel[] = []
  stopped = false
  /** Set to leave every task unanswered, as a stuck runner would. */
  hang = false
  private messageListener: (message: unknown) => void = () => {}
  private exitListener: (reason: Error) => void = () => {}

  constructor(readonly lane: string) {
    FakeChannel.started.push(this)
  }

  post(message: unknown) {
    if (this.hang) return
    const { id, task, payload } = message as { id: number; task: keyof typeof backgroundTasks; payload: unknown }
    void (async () => {
      try {
        const result = await (backgroundTasks[task] as (input: unknown) => unknown)(payload)
        this.messageListener({ id, ok: true, result })
      } catch (err) {
        this.messageListener({ id, ok: false, error: serializeError(err) })
      }
    })()
  }

  onMessage(listener: (message: unknown) => void) { this.messageListener = listener }
  onExit(listener: (reason: Error) => void) { this.exitListener = listener }
  stop() { this.stopped = true }

  /** As if the thread or process died on its own. */
  crash() { this.exitListener(new Error('The background worker stopped unexpectedly.')) }
}

const dirs: string[] = []

function useFakeRunners(options: { hang?: boolean } = {}) {
  const make = (lane: string) => () => {
    const channel = new FakeChannel(lane)
    channel.hang = options.hang === true
    return channel
  }
  useBackgroundRunners({ search: make('search'), documents: make('documents') })
}

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rl-background-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  useBackgroundRunners(null)
  FakeChannel.started = []
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('background tasks', () => {
  it('run inline when no runner is installed', async () => {
    const root = workspace({ 'a.txt': 'needle here' })
    const matches = await runInBackground('grep', { workspaceRoot: root, options: { pattern: 'needle' } })
    expect(matches.map((m) => m.path)).toEqual(['a.txt'])
  })

  it('run in their lane, each runner started on first use and reused', async () => {
    useFakeRunners()
    const root = workspace({ 'a.txt': 'needle here', 'b.txt': 'line 1\nline 2\n' })

    const [matches, page] = await Promise.all([
      runInBackground('grep', { workspaceRoot: root, options: { pattern: 'needle' } }),
      runInBackground('sliceTextFile', { filePath: join(root, 'b.txt'), options: { offset: 2 } })
    ])
    await runInBackground('grep', { workspaceRoot: root, options: { pattern: 'line' } })

    expect(matches).toHaveLength(1)
    expect(page.content).toBe('2 | line 2')
    expect(FakeChannel.started.map((c) => c.lane)).toEqual(['search', 'documents'])
  })

  it('keep the error classes callers check', async () => {
    useFakeRunners()
    const root = workspace({})

    const outside = runInBackground('grep', { workspaceRoot: root, options: { pattern: 'x', path: '../elsewhere' } })
    await expect(outside).rejects.toBeInstanceOf(PathJailError)
    await expect(outside).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })

    writeFileSync(join(root, 'broken.docx'), 'not really a Word file')
    await expect(runInBackground('extractDocument', { filePath: join(root, 'broken.docx') }))
      .rejects.toBeInstanceOf(DocumentExtractionError)
  })

  it('stop a runner that runs past the time limit, and start a fresh one for the next task', async () => {
    vi.useFakeTimers()
    useFakeRunners({ hang: true })
    const root = workspace({})

    const stuck = runInBackground('grep', { workspaceRoot: root, options: { pattern: 'x' } })
    const failed = expect(stuck).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(61_000)
    await failed
    expect(FakeChannel.started[0].stopped).toBe(true)

    void runInBackground('grep', { workspaceRoot: root, options: { pattern: 'x' } }).catch(() => {})
    expect(FakeChannel.started).toHaveLength(2)
  })

  it('fail what was waiting when a runner crashes, then start again', async () => {
    useFakeRunners({ hang: true })
    const root = workspace({})

    const waiting = runInBackground('extractDocument', { filePath: join(root, 'a.pdf') })
    FakeChannel.started[0].crash()
    await expect(waiting).rejects.toThrow(/stopped unexpectedly/)

    void runInBackground('extractDocument', { filePath: join(root, 'a.pdf') }).catch(() => {})
    expect(FakeChannel.started).toHaveLength(2)
  })

  it('stop every runner when the app quits', async () => {
    useFakeRunners({ hang: true })
    const root = workspace({})

    const waiting = runInBackground('grep', { workspaceRoot: root, options: { pattern: 'x' } })
    stopBackgroundWorkers()
    await expect(waiting).rejects.toThrow(/closing/)
    expect(FakeChannel.started[0].stopped).toBe(true)
  })
})
