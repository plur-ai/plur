import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../src/index.js'

let root: string
let plur: Plur
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-semantic-audit-'))
  writeFileSync(join(root, 'config.yaml'), 'index: false\ndedup:\n  mode: llm\n')
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it.each(['NOOP', 'UPDATE', 'MERGE'])('refuses a model-selected foreign target for %s', async decision => {
  const victim = await plur.learn('An unrelated protected observation', { scope: 'project:other' })
  const candidate = await plur.learn('A similar current observation', { scope: 'project:current' })
  vi.spyOn(plur, 'recallHybrid').mockResolvedValue([candidate])
  const result = await plur.learnAsync('A fresh current observation', { scope: 'project:current', llm: async () => `DECISION: ${decision}\nTARGET: ${victim.id}` })
  expect(result.decision).toBe('ADD')
  expect(result.engram.scope).toBe('project:current')
  expect((await plur.getById(victim.id))?.statement).toBe(victim.statement)
})

it.each(['NOOP', 'UPDATE', 'MERGE'])('preserves distinct supplied context despite a model %s', async decision => {
  const candidate = await plur.learn('The measured latency was eighteen milliseconds', { scope: 'local', measured_under: { hardware: 'cpu' } })
  vi.spyOn(plur, 'recallHybrid').mockResolvedValue([candidate])
  const result = await plur.learnAsync('Latency measured eighteen milliseconds', { scope: 'local', measured_under: { hardware: 'gpu' }, llm: async () => `DECISION: ${decision}\nTARGET: ${candidate.id}` })
  expect(result.decision).toBe('ADD')
  expect(result.engram.measured_under?.hardware).toBe('gpu')
  expect((await plur.getById(candidate.id))?.measured_under?.hardware).toBe('cpu')
})

it.each(['NOOP', 'UPDATE', 'MERGE'])('rechecks changed target state after model %s', async decision => {
  const candidate = await plur.learn('An observation awaiting confirmation', { scope: 'local' })
  vi.spyOn(plur, 'recallHybrid').mockResolvedValue([candidate])
  const result = await plur.learnAsync('A later observation', { scope: 'local', llm: async () => {
    await plur.updateEngram({ ...candidate, statement: 'A concurrent confirmed observation', commitment: 'locked' })
    return `DECISION: ${decision}\nTARGET: ${candidate.id}`
  } })
  expect(result.decision).toBe('ADD')
  expect((await plur.getById(candidate.id))?.statement).toBe('A concurrent confirmed observation')
})

it('validates input before calling a model or entering a semantic write path', async () => {
  const candidate = await plur.learn('An existing observation', { scope: 'local' })
  vi.spyOn(plur, 'recallHybrid').mockResolvedValue([candidate])
  const llm = vi.fn(async () => `DECISION: UPDATE\nTARGET: ${candidate.id}`)
  await expect(plur.learnAsync('A malformed observation', { scope: 'local', type: 'invalid' as any, llm })).rejects.toThrow(/invalid type/)
  expect(llm).not.toHaveBeenCalled()
  expect((await plur.getById(candidate.id))?.statement).toBe(candidate.statement)
})

it.each(['UPDATE', 'MERGE'])('rechecks the %s target inside the write lock', async decision => {
  const candidate = await plur.learn('An initially mutable observation', { scope: 'local' })
  vi.spyOn(plur, 'recallHybrid').mockResolvedValue([candidate])
  const result = await plur.learnAsync('A concurrent proposed observation', { scope: 'local', llm: async () => {
    // Return a stale pre-lock read after a concurrent writer commits a lock.
    vi.spyOn(plur, 'getById').mockImplementationOnce(async () => {
      await plur.updateEngram({ ...candidate, commitment: 'locked' })
      return candidate
    })
    return `DECISION: ${decision}\nTARGET: ${candidate.id}`
  } })
  expect(result.decision).toBe('ADD')
  expect((await plur.getById(candidate.id))?.statement).toBe(candidate.statement)
  expect((await plur.getById(candidate.id))?.commitment).toBe('locked')
})

it('allows a valid model update within unchanged scope and supplied context', async () => {
  const candidate = await plur.learn('An initial observation', { scope: 'local', measured_under: { hardware: 'cpu' } })
  vi.spyOn(plur, 'recallHybrid').mockResolvedValue([candidate])
  const result = await plur.learnAsync('An expanded observation', { scope: 'local', measured_under: { hardware: 'cpu' }, llm: async () => `DECISION: UPDATE\nTARGET: ${candidate.id}` })
  expect(result.decision).toBe('UPDATE')
  expect(result.engram.id).toBe(candidate.id)
  expect((await plur.getById(candidate.id))?.statement).toBe('An expanded observation')
})
