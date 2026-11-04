// Checks the built app (out/) before it is packaged: every bundle must parse,
// and the background worker must start and run real tasks. Run after
// `npm run build`; CI does. Exits non-zero on any failure.
//
// It catches what type checks and tests can't see, because they run the
// source, not the bundles: e.g. a chunk that declares the same name twice
// once the bundler adds its own shims, or a worker that can't load its
// dependencies.
import { fork, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

const OUT = 'out'
const TASK_TIMEOUT_MS = 60_000
const failures = []

function fail(message) {
  failures.push(message)
  console.error(`  FAIL  ${message}`)
}

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return jsFiles(path)
    return /\.(m|c)?js$/.test(name) ? [path] : []
  })
}

// 1. Every bundle parses.
console.log('Syntax of the built bundles:')
for (const dir of ['main', 'preload', 'renderer'].map((d) => join(OUT, d))) {
  let files
  try {
    files = jsFiles(dir)
  } catch {
    fail(`${dir} is missing: run npm run build first`)
    continue
  }
  if (files.length === 0) fail(`${dir} has no JavaScript files`)
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status === 0) {
      console.log(`  ok    ${relative(OUT, file)}`)
    } else {
      fail(`${relative(OUT, file)} does not parse:\n${(result.stderr || result.stdout).trim()}`)
    }
  }
}

// 2. The background worker starts and runs tasks, as the app runs them.
const workerFile = (() => {
  try {
    return jsFiles(join(OUT, 'main')).find((file) => /taskWorker[^/\\]*\.js$/.test(file))
  } catch {
    return undefined
  }
})()

/** A one-page PDF with real text, offsets computed, so extraction runs pdf.js for real. */
function minimalPdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return pdf
}

/**
 * Starts the task entry the way the app does: a worker thread (searches) or
 * a separate process (documents; the app uses an Electron utility process,
 * this a Node child process). Returns a way to run tasks and to stop it.
 */
function startRunner(kind) {
  const file = resolve(workerFile)
  const pending = new Map()
  let nextId = 1
  const onMessage = ({ id, ok, result, error }) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (ok) entry.resolve(result)
    else entry.reject(new Error(`${error?.name}: ${error?.message}`))
  }
  const failAll = (err) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    pending.clear()
  }

  let post
  let stop
  if (kind === 'thread') {
    const worker = new Worker(file)
    worker.on('message', onMessage)
    worker.on('error', failAll)
    post = (message) => worker.postMessage(message)
    stop = () => worker.terminate()
  } else {
    const child = fork(file, [], { serialization: 'advanced', stdio: 'inherit' })
    child.on('message', onMessage)
    child.on('exit', (code) => failAll(new Error(`the process exited (code ${code})`)))
    post = (message) => child.send(message)
    stop = () => child.kill()
  }

  const run = (task, payload) => new Promise((resolvePromise, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error('timed out')), TASK_TIMEOUT_MS)
    pending.set(id, { resolve: resolvePromise, reject, timer })
    post({ id, task, payload })
  })
  return { run, stop }
}

async function checkWorker() {
  console.log('Background tasks:')
  if (!workerFile) {
    fail('no taskWorker bundle in out/main')
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'red-ledger-build-check-'))
  writeFileSync(join(dir, 'notes.md'), 'first line\nthe needle is here\n')
  writeFileSync(join(dir, 'lines.txt'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  writeFileSync(join(dir, 'report.pdf'), minimalPdf('Build check text'))

  // Lane, task, payload, and what a correct result looks like.
  const checks = [
    ['thread', 'grep', { workspaceRoot: dir, options: { pattern: 'needle' } },
      (r) => Array.isArray(r) && r.length === 1 && r[0].path === 'notes.md' && r[0].line === 2],
    ['process', 'sliceTextFile', { filePath: join(dir, 'lines.txt'), options: { offset: 49 } },
      (r) => r?.content === '49 | line 49\n50 | line 50' && r.total_lines === 50],
    ['process', 'extractDocument', { filePath: join(dir, 'report.pdf') },
      (r) => typeof r === 'string' && r.includes('Build check text')]
  ]

  const runners = {}
  try {
    for (const [kind, task, payload, isExpected] of checks) {
      try {
        runners[kind] ??= startRunner(kind)
        const result = await runners[kind].run(task, payload)
        if (isExpected(result)) console.log(`  ok    ${task} (${kind})`)
        else fail(`${task} returned something unexpected: ${JSON.stringify(result).slice(0, 300)}`)
      } catch (err) {
        fail(`${task} failed in the ${kind}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } finally {
    // Stopped the way the app stops them on quit; a crash here fails the check too.
    await Promise.all(Object.values(runners).map((runner) => runner.stop()))
    rmSync(dir, { recursive: true, force: true })
  }
}

await checkWorker()

if (failures.length > 0) {
  console.error(`\nBuild check failed (${failures.length} problem${failures.length === 1 ? '' : 's'}).`)
  process.exit(1)
}
console.log('\nBuild check passed.')
