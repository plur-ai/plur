/**
 * W5 (overhaul): a vague prompt finds nothing on topic; the same prompt with
 * the stored session task as `query_context` retrieves the task's engram, in
 * both selection modes, and the query used is recorded on the result.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, buildInjectionQuery } from '../src/index.js'
import { EngramSchema, type Engram } from '../src/schemas/engram.js'
import { writeFixtureStore } from './helpers/injection-fixture.js'

const mk = (id: string, statement: string): Engram => EngramSchema.parse({
  id, statement, type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: [],
  activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: new Date().toISOString().slice(0, 10) },
}) as Engram

describe.each(['legacy', 'unified'] as const)('query_context (W5) — %s mode', (mode) => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `plur-qctx-${mode}-`))
    writeFixtureStore(dir, [
      mk('ENG-2026-1201-001', 'The invoice exporter retries failed uploads to the ledger bucket three times.'),
      mk('ENG-2026-1201-002', 'Coffee orders for the office go through the kitchen channel.'),
      mk('ENG-2026-1201-003', 'Holiday rota is kept in the shared calendar.'),
    ], `injection:\n  mode: ${mode}\n`)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('the remote recall leg is sent the original task only, never the session context (S11)', async () => {
    const plur = new Plur({ path: dir })
    const spy = vi.spyOn(plur as any, '_startRemoteRecall')
    const task = 'do 1,2,3'
    const context = ['TRANSCRIPTSECRET fix the invoice exporter', 'branch: TRANSCRIPTSECRET-branch']
    const r = await plur.injectHybrid(task, { query_context: context })
    expect(r.query).toContain('TRANSCRIPTSECRET')
    expect(spy).toHaveBeenCalled()
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe(task)
      expect(JSON.stringify(call.slice(0, 2))).not.toContain('TRANSCRIPTSECRET')
    }
  })

  it('a vague prompt alone does not retrieve the task engram; with the session task it does', async () => {
    const plur = new Plur({ path: dir })
    const raw = await plur.inject('do 1,2,3')
    expect(raw.injected_ids).not.toContain('ENG-2026-1201-001')
    expect(raw.query).toBeUndefined()
    const built = await plur.inject('do 1,2,3', { query_context: ['fix the invoice exporter upload retries to the ledger bucket'] })
    expect(built.injected_ids).toContain('ENG-2026-1201-001')
    expect(built.query).toBe('do 1,2,3\nfix the invoice exporter upload retries to the ledger bucket')
  })
})

describe('buildInjectionQuery', () => {
  it('keeps the task first, drops empty and repeated parts, caps the length', () => {
    expect(buildInjectionQuery('do it')).toBe('do it')
    expect(buildInjectionQuery('do it', [])).toBe('do it')
    expect(buildInjectionQuery('do it', ['', 'Do it', 'branch feat/x', 'branch feat/x', 7 as never])).toBe('do it\nbranch feat/x')
    expect(buildInjectionQuery('q', ['x'.repeat(5000)]).length).toBe(2000)
  })
})
