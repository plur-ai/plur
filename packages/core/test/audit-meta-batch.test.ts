import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../src/index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('reserves each meta ID within its batch and across retries and concurrent callers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plur-meta-identity-')); roots.push(root)
  writeFileSync(join(root, 'config.yaml'), 'index: false\ndedup:\n  mode: off\n')
  const plur = new Plur({ path: root, autoDiscover: false }); await plur.ready()
  const seed = await plur.learn('Preserve this unrelated record', { scope: 'local' })
  const first = { ...seed, id: 'META-AUDIT-001', statement: 'First accepted metadata' }
  const conflict = { ...first, statement: 'Conflicting metadata must not replace the first' }
  const second = { ...seed, id: 'META-AUDIT-002', statement: 'A distinct metadata record' }
  expect(await plur.saveMetaEngrams([first, conflict, second])).toEqual({ saved: 2, skipped: 1 })
  expect(await plur.saveMetaEngrams([conflict, first])).toEqual({ saved: 0, skipped: 2 })
  const other = new Plur({ path: root, autoDiscover: false }); await other.ready()
  const third = { ...seed, id: 'META-AUDIT-003', statement: 'Concurrent metadata record' }
  const results = await Promise.all([plur.saveMetaEngrams([third, third]), other.saveMetaEngrams([third])])
  expect(results.reduce((n, r) => n + r.saved, 0)).toBe(1)
  expect(results.reduce((n, r) => n + r.skipped, 0)).toBe(2)
  const fresh = new Plur({ path: root, autoDiscover: false }); await fresh.ready()
  const rows = await fresh.list()
  expect(rows).toHaveLength(4)
  expect(new Set(rows.map(row => row.id)).size).toBe(4)
  expect((await fresh.getById(first.id))?.statement).toBe(first.statement)
  expect((await fresh.getById(seed.id))?.statement).toBe(seed.statement)
})
