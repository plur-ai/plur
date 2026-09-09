import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Plur } from '../src/index.js'
import { runImport } from '../src/importers/engine.js'

let root: string
let plur: Plur
const record = { statement: 'Preserve imported source details', created_at: '2025-01-02T03:04:05Z', confidence: 0.8 }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-import-preserve-'))
  writeFileSync(join(root, 'config.yaml'), 'index: false\n')
  plur = new Plur({ path: root, autoDiscover: false })
  await plur.ready()
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it('publishes source metadata in the initial durable record', async () => {
  const append = (plur as any)._appendEngram.bind(plur)
  const published: any[] = []
  vi.spyOn(plur as any, '_appendEngram').mockImplementation(async (...args: any[]) => {
    published.push(structuredClone(args[1]))
    return append(...args)
  })
  const report = await runImport(plur, [record], { from: 'generic' })
  expect(report.imported).toBe(1)
  expect(published).toHaveLength(1)
  expect(published[0].temporal.learned_at).toBe(record.created_at)
  expect(published[0].episodic.confidence).toBe(8)
})

it('never overwrites a concurrent edit with the importer snapshot', async () => {
  const original = (plur as any)._learn.bind(plur)
  vi.spyOn(plur as any, '_learn').mockImplementation(async (...args: any[]) => {
    const created = await original(...args)
    await plur.updateEngram({ ...created, pinned: true })
    return created
  })
  const report = await runImport(plur, [record], { from: 'generic' })
  const [stored] = await plur.list()
  expect(report.errors).toBe(0)
  expect(stored.pinned).toBe(true)
  expect(stored.temporal?.learned_at).toBe(record.created_at)
  expect(stored.episodic?.confidence).toBe(8)
})

it('does not need a second write to complete metadata, and retry preserves it', async () => {
  const update = vi.spyOn(plur as any, '_updateEngrams').mockRejectedValue(new Error('second write unavailable'))
  const report = await runImport(plur, [record], { from: 'generic' })
  expect(report.imported).toBe(1)
  expect(report.errors).toBe(0)
  const [stored] = await plur.list()
  expect(stored.temporal?.learned_at).toBe(record.created_at)
  expect(stored.episodic?.confidence).toBe(8)
  update.mockRestore()
  const retry = await runImport(plur, [{ ...record, created_at: '2026-01-01T00:00:00Z' }], { from: 'generic' })
  expect(retry.skipped).toBe(1)
  expect((await plur.list())[0].temporal?.learned_at).toBe(record.created_at)
})

it('refuses invalid import metadata before publishing a partial row', async () => {
  const report = await runImport(plur, [{ ...record, confidence: NaN }], { from: 'generic' })
  expect(report.errors).toBe(1)
  expect(await plur.list()).toEqual([])
  const retry = await runImport(plur, [record], { from: 'generic' })
  expect(retry.imported).toBe(1)
  expect((await plur.list())[0].episodic?.confidence).toBe(8)
})

it('reports one creation across concurrent imports and preserves metadata after restart', async () => {
  const other = new Plur({ path: root, autoDiscover: false }); await other.ready()
  const reports = await Promise.all([runImport(plur, [record], { from: 'generic' }), runImport(other, [record], { from: 'generic' })])
  expect(reports.reduce((n, r) => n + r.imported, 0)).toBe(1)
  expect(reports.reduce((n, r) => n + r.skipped, 0)).toBe(1)
  expect(reports.reduce((n, r) => n + r.errors, 0)).toBe(0)
  const restarted = new Plur({ path: root, autoDiscover: false }); await restarted.ready()
  const rows = await restarted.list()
  expect(rows).toHaveLength(1)
  expect(rows[0].temporal?.learned_at).toBe(record.created_at)
  expect(rows[0].episodic?.confidence).toBe(8)
})
