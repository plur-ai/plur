/**
 * Owner principle "keep both, rename one — nothing lost or hidden" (decisions
 * P1/P1b, 2026-09-27), applied to the three residual cases found while applying
 * them (findings/r2-persist.md, apply phase, follow-ups 1–3):
 *
 *  1. P1b on a PERSONAL remote: sibling files (episodes, tensions, candidates)
 *     are committed, not held. After the held local engram is re-id'd, their
 *     references to the old id must follow it — otherwise they silently resolve
 *     to the other machine's engram. The rewrite is pushed and recorded.
 *  2. Postgres `save` renames reach the Plur instance's history.
 *  3. `saveEngrams` keeps a quarantined (schema-invalid) entry whose id matches
 *     a valid engram's, under a fresh id, recorded in history. It used to drop it.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { sync } from '../src/sync.js'
import { loadEngrams, saveEngrams, getQuarantinedEntries } from '../src/engrams.js'
import { listHistoryMonths, readHistory } from '../src/history.js'
import { PostgresAdapter } from '../src/storage-postgres.js'
import { Plur } from '../src/index.js'
import { isolateGitConfig } from './helpers/git-isolation.js'
import type { Engram } from '../src/schemas/engram.js'

const DUMP = { lineWidth: 120, noRefs: true, quotingType: '"' as const }
const rekeyed = (root: string) =>
  listHistoryMonths(root).flatMap(m => readHistory(root, m)).filter(x => x.event === 'engram_rekeyed')

function e(id: string, statement: string, scope = 'global'): Engram {
  return {
    id, statement, type: 'behavioral', scope, status: 'active', tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-09-27' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}

describe('follow-up 1: P1b on a personal remote rewrites committed sibling references', { timeout: 120_000 }, () => {
  isolateGitConfig({ defaultBranch: 'main' }) // the fixture names `main`
  let base: string, bare: string, A: string, B: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'plur-fu1-'))
    bare = join(base, 'remote.git')
    A = join(base, 'A')
    B = join(base, 'B')
    execSync(`git init --bare "${bare}"`, { stdio: 'ignore' })
    mkdirSync(A)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('the local episode follows the renamed engram; the pulled episode keeps pointing at the pulled engram', () => {
    const OLD = 'ENG-2026-09-26-002'
    writeFileSync(join(A, 'engrams.yaml'), yaml.dump({ engrams: [
      { id: 'ENG-2026-09-26-001', scope: 'global', statement: 'A shared' },
      { id: OLD, scope: 'local', statement: 'A local note' },
    ] }, DUMP))
    writeFileSync(join(A, 'episodes.yaml'), yaml.dump([{ id: 'EP-A', summary: `A worked on ${OLD}`, engram_ids: [OLD] }]))
    sync(A, bare)

    execSync(`git clone -q "${bare}" "${B}"`)
    const docB = yaml.load(readFileSync(join(B, 'engrams.yaml'), 'utf8')) as any
    docB.engrams.push({ id: OLD, scope: 'global', statement: 'B team fact' })
    writeFileSync(join(B, 'engrams.yaml'), yaml.dump(docB, DUMP))
    const epB = yaml.load(readFileSync(join(B, 'episodes.yaml'), 'utf8')) as any[]
    epB.push({ id: 'EP-B', summary: `B worked on ${OLD}`, engram_ids: [OLD] })
    writeFileSync(join(B, 'episodes.yaml'), yaml.dump(epB))
    execSync('git add -A && git commit -qm b && git push -q', { cwd: B })

    const r = sync(A)
    expect(r.message).toContain('pulled')
    const engrams = (yaml.load(readFileSync(join(A, 'engrams.yaml'), 'utf8')) as any).engrams as any[]
    const mine = engrams.find(x => x.statement === 'A local note')
    expect(mine.id).not.toBe(OLD)
    expect(engrams.find(x => x.id === OLD).statement).toBe('B team fact')

    const eps = yaml.load(readFileSync(join(A, 'episodes.yaml'), 'utf8')) as any[]
    expect(eps.find(x => x.id === 'EP-A')).toMatchObject({ summary: `A worked on ${mine.id}`, engram_ids: [mine.id] })
    expect(eps.find(x => x.id === 'EP-B')).toMatchObject({ summary: `B worked on ${OLD}`, engram_ids: [OLD] })

    // Pushed: it is the user's own remote.
    const remoteEps = yaml.load(execSync('git show main:episodes.yaml', { cwd: bare, encoding: 'utf8' })) as any[]
    expect(remoteEps.find(x => x.id === 'EP-A').engram_ids).toEqual([mine.id])

    const ev = rekeyed(A)
    expect(ev).toHaveLength(1)
    expect(ev[0].data).toMatchObject({ from: OLD, to: mine.id, cause: 'sync-pull', files: ['episodes.yaml'] })
  })
})

describe('follow-up 3: a quarantined entry sharing a valid engram\'s id is kept, under a fresh id', () => {
  let root: string
  let file: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-fu3-'))
    mkdirSync(join(root, 'history'))
    file = join(root, 'engrams.yaml')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('survives the save, addressable by its own id, and the rename is in history', () => {
    const broken = { id: 'ENG-Q-1', statement: 42, type: 'not-a-type' }
    writeFileSync(file, yaml.dump({ engrams: [e('ENG-Q-1', 'good'), broken] }))
    const loaded = loadEngrams(file)
    expect(loaded.map(x => x.id)).toEqual(['ENG-Q-1'])
    saveEngrams(file, loaded)
    const onDisk = (yaml.load(readFileSync(file, 'utf8')) as any).engrams as any[]
    expect(onDisk).toHaveLength(2)
    const kept = onDisk.find(x => x.statement === 42)
    expect(kept).toBeDefined()
    expect(kept.id).not.toBe('ENG-Q-1')
    expect(kept.id.startsWith('ENG-Q-1-D')).toBe(true)
    expect(kept.type).toBe('not-a-type') // otherwise verbatim
    const ev = rekeyed(root)
    expect(ev).toHaveLength(1)
    expect(ev[0].data).toMatchObject({ from: 'ENG-Q-1', to: kept.id })
    // Stable: a second load/save round renames nothing more.
    saveEngrams(file, loadEngrams(file))
    expect(getQuarantinedEntries(file).map((q: any) => q.id)).toEqual([kept.id])
    expect(rekeyed(root)).toHaveLength(1)
  })
})

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL

describe.skipIf(!PG_URL)('follow-up 2: Postgres save renames reach the Plur instance\'s history', () => {
  let adapter: PostgresAdapter
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-fu2-'))
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: 'plur_formal_r2_apply_fu2', vectorIndex: 'exact' })
    await adapter.save([])
  }, 120_000)
  afterAll(async () => {
    await adapter?.dropSchema().catch(() => {})
    await adapter?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  it('a batch with a clashing id is stored under two ids and the rename is an engram_rekeyed event', async () => {
    const plur = new Plur({ path: dir, store: adapter })
    await adapter.save([e('ENG-PG-1', 'first'), e('ENG-PG-1', 'second')])
    plur.close()
    const rows = await adapter.load()
    const second = rows.find(r => r.statement === 'second')!
    expect(second.id).not.toBe('ENG-PG-1')
    const ev = rekeyed(dir)
    expect(ev).toHaveLength(1)
    expect(ev[0].engram_id).toBe(second.id)
    expect(ev[0].data).toMatchObject({ from: 'ENG-PG-1', to: second.id })
  }, 120_000)

  it('several Plur instances on one adapter all record the rename; a closed one stops', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'plur-fu2a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'plur-fu2b-'))
    try {
      const a = new Plur({ path: dirA, store: adapter })
      const b = new Plur({ path: dirB, store: adapter })
      await adapter.save([e('ENG-PG-2', 'one'), e('ENG-PG-2', 'two')])
      const renamed = (await adapter.load()).find(r => r.statement === 'two')!.id
      for (const root of [dirA, dirB]) {
        const ev = rekeyed(root)
        expect(ev).toHaveLength(1)
        expect(ev[0].data).toMatchObject({ from: 'ENG-PG-2', to: renamed })
      }
      a.close()
      await adapter.save([e('ENG-PG-3', 'x'), e('ENG-PG-3', 'y')])
      expect(rekeyed(dirA)).toHaveLength(1)
      expect(rekeyed(dirB)).toHaveLength(2)
      b.close()
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  }, 120_000)
})
