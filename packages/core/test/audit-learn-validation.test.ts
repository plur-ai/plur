import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../src/index.js'

let root: string
let plur: Plur
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-context-validation-'))
  writeFileSync(join(root, 'config.yaml'), 'index: false\ndedup:\n  mode: off\n')
  plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
  await plur.learn('Preserve the existing valid record', { scope: 'local' })
})
afterEach(() => { vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }) })

it.each(['learn', 'learnRouted', 'learnAsync'] as const)('%s refuses malformed context before persisting or using a model', async method => {
  const before = readFileSync(join(root, 'engrams.yaml'), 'utf8')
  const llm = vi.fn(async () => 'DECISION: ADD')
  for (const context of [{ tags: [7] }, { source: 7 }, { rationale: 7 }, { commitment: 'invalid' }, { pinned: 'yes' }, { knowledge_anchors: [{ path: 'a', relevance: 'invalid' }] }, { attribution: { runtime: { name: 7 } } }, { dual_coding: {} }, { memory_class: 'invalid' }, { visibility: 'invalid' }]) {
    await expect(plur[method]('A proposed observation', { scope: 'local', ...context, llm } as any)).rejects.toThrow(/context/)
    expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(before)
  }
  expect(llm).not.toHaveBeenCalled()
})

it('batch validation reports the malformed item and preserves valid siblings', async () => {
  const result = await plur.learnBatch([
    { statement: 'A malformed item', context: { tags: [7] } as any },
    { statement: 'A valid surviving item', context: { scope: 'local', source: 'fixture' } },
  ])
  expect(result.failures).toHaveLength(1)
  expect(result.failures[0].index).toBe(0)
  const fresh = new Plur({ path: root, autoDiscover: false }); await fresh.ready()
  expect((await fresh.list()).map(row => row.statement)).toEqual(expect.arrayContaining(['Preserve the existing valid record', 'A valid surviving item']))
  expect((await fresh.list()).some(row => row.statement === 'A malformed item')).toBe(false)
})

it.each(['updateEngram', 'updateEngramAsync'] as const)('%s refuses to overwrite a valid record with malformed content', async method => {
  const row = (await plur.list())[0]
  const before = readFileSync(join(root, 'engrams.yaml'), 'utf8')
  await expect(plur[method]({ ...row, tags: [7] } as any)).rejects.toThrow(/Invalid engram/)
  expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(before)
})

it('refuses a malformed meta batch without persisting its valid prefix', async () => {
  const row = (await plur.list())[0]
  const before = readFileSync(join(root, 'engrams.yaml'), 'utf8')
  await expect(plur.saveMetaEngrams([{ ...row, id: 'META-VALID-001' }, { ...row, id: 'META-INVALID-001', tags: [7] } as any])).rejects.toThrow(/Invalid engram/)
  expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(before)
})

it.each(['setPinned', 'setPinnedAsync'] as const)('%s refuses malformed booleans without clearing a pin', async method => {
  const row = (await plur.list())[0]
  await plur.setPinned(row.id, true)
  const before = readFileSync(join(root, 'engrams.yaml'), 'utf8')
  await expect(plur[method](row.id, 'yes' as any)).rejects.toThrow(/boolean/)
  expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(before)
})

it('refuses an unknown feedback signal without changing activation', async () => {
  const row = (await plur.list())[0]
  const before = readFileSync(join(root, 'engrams.yaml'), 'utf8')
  await expect(plur.feedback(row.id, 'unknown' as any)).rejects.toThrow(/signal/)
  expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(before)
})
