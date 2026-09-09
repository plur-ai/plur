import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileProvenanceStore } from '../src/provenance-store.js'

const roots: string[] = []
function temp() { const root = mkdtempSync(join(tmpdir(), 'plur-provenance-audit-')); roots.push(root); return root }
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('preserves and orders same-millisecond versions across store instances', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-08T00:00:00Z'))
  const root = temp()
  const stores = [new FileProvenanceStore(root), new FileProvenanceStore(root)]
  const refs = await Promise.all(Array.from({ length: 15 }, (_, n) => stores[n % 2].put('ENG-1', { n })))
  expect(new Set(refs).size).toBe(15)
  const ordered = await stores[0].list('ENG-1')
  expect(await Promise.all(ordered.map(ref => stores[0].get(ref)))).toEqual(Array.from({ length: 15 }, (_, n) => ({ n: 14 - n })))
  for (const ref of refs) expect(statSync(ref).mode & 0o777).toBe(0o600)
  expect(await stores[0].put('ENG-1', { n: 14 })).toBe(ordered[0])
})

it('does not read a foreign JSON file or write through a configured symlink', async () => {
  const root = temp(), outside = temp()
  const foreign = join(outside, 'private.jsonld'); writeFileSync(foreign, '{"private":true}')
  const store = new FileProvenanceStore(root)
  expect(await store.get(foreign)).toBeUndefined()
  symlinkSync(outside, join(root, 'provenance'))
  await expect(store.put('ENG-1', { n: 1 })).rejects.toThrow(/symbolic link/)
})
