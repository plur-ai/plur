import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { recordEvent, getCounters, readPendingCounters, migrateStaleCounters, type CountersOpts } from '../src/telemetry-counters.js'
import { flushIfNeeded, type FlushOpts } from '../src/telemetry-flush.js'

const fault = vi.hoisted(() => ({ path: '', directory: '' }))
vi.mock('../src/sync.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sync.js')>()
  return { ...actual, fsyncDir: (path: string) => {
    if (path === fault.directory) throw new Error('injected directory sync failure')
    return actual.fsyncDir(path)
  }, atomicWrite: (...args: Parameters<typeof actual.atomicWrite>) => {
    if (args[0] === fault.path && JSON.parse(String(args[1])).date === '2026-09-09') throw new Error('injected reset interruption')
    return actual.atomicWrite(...args)
  } }
})

let root: string
let opts: CountersOpts
const before = () => new Date('2026-09-08T12:00:00Z')
const after = () => new Date('2026-09-09T12:00:00Z')
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'plur-telemetry-preserve-'))
  opts = { env: { PLUR_TELEMETRY: 'on' }, countersPath: join(root, 'counters.json'), installIdPath: join(root, 'install-id'), pendingDir: join(root, 'pending'), now: before }
  fault.path = ''
  fault.directory = ''
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('preserves legacy counters when making the first pending directory durable fails', async () => {
  const original = JSON.stringify({ date: '2026-09-08', learn: 3, recall: 2, session: 1 })
  fs.writeFileSync(opts.countersPath!, original)
  fault.directory = opts.pendingDir!
  const fetch = vi.fn()
  await expect(flushIfNeeded({ ...opts, now: after, fetch })).rejects.toThrow('injected directory sync failure')
  await expect(flushIfNeeded({ ...opts, now: after, fetch })).rejects.toThrow('injected directory sync failure')
  expect(fs.readFileSync(opts.countersPath!, 'utf8')).toBe(original)
  expect(fetch).not.toHaveBeenCalled()
})

it('retries interrupted rollover without counting the same snapshot twice', () => {
  recordEvent('learn', opts)
  fault.path = opts.countersPath!
  expect(() => recordEvent('recall', { ...opts, now: after })).toThrow('injected reset interruption')
  expect(readPendingCounters('2026-09-08', opts)?.learn).toBe(1)
  fault.path = ''
  recordEvent('recall', { ...opts, now: after })
  expect(readPendingCounters('2026-09-08', opts)?.learn).toBe(1)
  expect(getCounters({ ...opts, now: after })?.recall).toBe(1)
})

it('preserves malformed pending bytes and sends nothing', async () => {
  recordEvent('learn', opts)
  recordEvent('recall', { ...opts, now: after })
  const path = join(opts.pendingDir!, '2026-09-08.json')
  fs.writeFileSync(path, '{ valuable interrupted data')
  const fetch = vi.fn()
  await expect(flushIfNeeded({ ...opts, now: after, fetch })).rejects.toThrow(/existing data preserved/)
  expect(fs.readFileSync(path, 'utf8')).toBe('{ valuable interrupted data')
  expect(fetch).not.toHaveBeenCalled()
})

it('serializes concurrent drains and keeps one delivery identity and body across an upgrade retry', async () => {
  recordEvent('learn', opts)
  recordEvent('recall', { ...opts, now: after })
  const calls: RequestInit[] = []
  const failed = (async (_url, init) => { calls.push(init!); return { ok: false } as Response }) as typeof fetch
  await flushIfNeeded({ ...opts, now: after, packageVersion: '0.19.4', fetch: failed })
  const succeeded = (async (_url, init) => { calls.push(init!); await new Promise(r => setTimeout(r, 20)); return { ok: true } as Response }) as typeof fetch
  await Promise.all([1, 2].map(() => flushIfNeeded({ ...opts, now: after, packageVersion: '0.20.0', fetch: succeeded })))
  expect(calls).toHaveLength(2)
  expect(calls[1].body).toBe(calls[0].body)
  expect(calls[1].headers).toEqual(calls[0].headers)
  expect((calls[0].headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
})

it('an earlier acknowledgement subtracts only its counts from a newer queued snapshot', async () => {
  recordEvent('learn', opts)
  recordEvent('recall', { ...opts, now: after })
  const fetch = (async () => {
    recordEvent('learn', opts)
    recordEvent('learn', opts)
    migrateStaleCounters({ ...opts, now: after })
    return { ok: true } as Response
  }) as typeof globalThis.fetch
  await flushIfNeeded({ ...opts, now: after, fetch })
  expect(readPendingCounters('2026-09-08', opts)).toEqual({ date: '2026-09-08', learn: 2, recall: 0, session: 0 })
})

it('new counts cannot change an accepted delivery after its response is lost', async () => {
  recordEvent('learn', opts)
  recordEvent('recall', { ...opts, now: after })
  const calls: RequestInit[] = []
  const accepted = new Map<string, string>()
  let first = true
  const fetch = (async (_url, init) => {
    calls.push(init!)
    const id = (init!.headers as Record<string, string>)['Idempotency-Key']
    const body = String(init!.body)
    if (accepted.has(id)) expect(body).toBe(accepted.get(id))
    accepted.set(id, body)
    if (first) {
      first = false
      // Clock correction and another rollover occur while the first delivery
      // is in flight. The collector commits it, but the response is lost.
      recordEvent('learn', opts)
      recordEvent('learn', opts)
      migrateStaleCounters({ ...opts, now: after })
      throw new Error('lost response after acceptance')
    }
    return { ok: true } as Response
  }) as typeof globalThis.fetch
  const flushOpts: FlushOpts = { ...opts, now: after, packageVersion: '0.19.4', fetch }
  await flushIfNeeded(flushOpts)
  await flushIfNeeded({ ...flushOpts, packageVersion: '0.20.0' })
  expect(calls[1].body).toBe(calls[0].body)
  expect(calls[1].headers).toEqual(calls[0].headers)
  await flushIfNeeded(flushOpts)
  const deliveries = [...accepted.values()].map(body => JSON.parse(body))
  expect(deliveries.reduce((sum, delivery) => sum + delivery.learn_count, 0)).toBe(3)
  expect(deliveries.reduce((sum, delivery) => sum + delivery.recall_count, 0)).toBe(1)
  expect(readPendingCounters('2026-09-08', opts)).toBeNull()
})

it.each(['../../outside', '2026-02-31'])('refuses unsafe or invalid pending date %s', date => {
  expect(() => readPendingCounters(date, opts)).toThrow(/date/)
})

it('preserves every increment and one installation identity across four processes', async () => {
  const require = createRequire(import.meta.url)
  const moduleUrl = new URL('../src/telemetry-counters.ts', import.meta.url).href
  const { now: _now, ...serializable } = opts
  const script = `import { recordEvent } from ${JSON.stringify(moduleUrl)}; const opts = ${JSON.stringify(serializable)}; opts.now = () => new Date('2026-09-08T12:00:00Z'); for(let i=0;i<30;i++) recordEvent('learn',opts);`
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error)))
  })))
  expect(getCounters(opts)?.learn).toBe(120)
  expect(getCounters(opts)?.session).toBe(1)
})
