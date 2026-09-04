/**
 * pinned_priority at the trust boundaries (#1121 review).
 *
 * Pinning is the one path into the system prompt that skips the relevance
 * gate, so the key that orders pins is a security control. Three invariants:
 *
 *   1. A priority on a row from a pack, a `stores:` entry or a remote store
 *      can never rank that row ahead of a primary-store pin.
 *   2. No value of pinned_priority — on disk, from a store, or from learn() —
 *      can crash injection, be persisted as a non-finite number, or make an
 *      otherwise valid engram unloadable.
 *   3. Pins with no priority keep the pre-#1121 order (relevance score).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fillTokenBudget, estimateTokens } from '../src/inject.js'
import type { ScoredEngram } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'
import { normalizePinnedPriority, validatePinnedPriority, pinnedOriginRank, effectivePinnedPriority } from '../src/pinned-priority.js'
import { normalizeEngramInput } from '../src/normalize-engram.js'
import { sanitizePackEngrams } from '../src/packs.js'
import { salvageRemoteRow } from '../src/store/remote-store.js'
import { Plur } from '../src/index.js'

const STATEMENT = 'X'.repeat(60)

function pin(id: string, extra: Record<string, unknown> = {}): ScoredEngram {
  const base = EngramSchema.parse({ id, statement: STATEMENT, type: 'behavioral', scope: 'global', status: 'active', pinned: true })
  return { ...base, pinned: true, keyword_match: 1, raw_score: 1, score: 1, ...extra } as unknown as ScoredEngram
}

describe('normalisation and validation', () => {
  it('normalizePinnedPriority: finite numbers are rounded and clamped, everything else is absent', () => {
    expect(normalizePinnedPriority(150)).toBe(100)
    expect(normalizePinnedPriority(0)).toBe(1)
    expect(normalizePinnedPriority(-5)).toBe(1)
    expect(normalizePinnedPriority(1.6)).toBe(2)
    for (const bad of [NaN, Infinity, -Infinity, '90', 'high', {}, [], true, null, undefined]) {
      expect(normalizePinnedPriority(bad), String(bad)).toBeUndefined()
    }
  })

  it('validatePinnedPriority: clamps finite, throws on anything that would persist as garbage', () => {
    expect(validatePinnedPriority(150, 'learn')).toBe(100)
    expect(validatePinnedPriority(undefined, 'learn')).toBeUndefined()
    expect(validatePinnedPriority(null, 'learn')).toBeUndefined()
    for (const bad of [NaN, Infinity, 'abc', '90', {}, true]) {
      expect(() => validatePinnedPriority(bad, 'learn'), String(bad)).toThrow(TypeError)
    }
  })

  it('pinnedOriginRank: the loader-set markers decide, and a foreign row can only look more foreign', () => {
    expect(pinnedOriginRank({})).toBe(0)
    expect(pinnedOriginRank({ _storeScope: 'group:acme/eng' })).toBe(1)
    expect(pinnedOriginRank({ _pack: 'evil' })).toBe(2)
    expect(pinnedOriginRank({ pack: 'evil' })).toBe(2)
    expect(pinnedOriginRank({ pack: '__personal__' })).toBe(0)
    expect(pinnedOriginRank({ _pack: 'evil', _storeScope: 'whatever' })).toBe(2)
  })
})

describe('invariant 1 — foreign pins never outrank primary pins', () => {
  const oneFits = (e: ScoredEngram) => Math.floor(estimateTokens(e) * 2.5) // outer: 2, pinned sub-cap: 1

  it('a remote/store row at any priority loses to the user\'s default pin', () => {
    for (const hostile of [100, 1e308, Infinity, NaN, '90', 'high']) {
      const mine = pin('ENG-MINE')
      const theirs = pin('ENG-THEIRS', { _storeScope: 'group:acme/eng', pinned_priority: hostile })
      const { selected } = fillTokenBudget([theirs, mine], oneFits(mine))
      expect(selected.map(e => e.id), String(hostile)).toEqual(['ENG-MINE'])
    }
  })

  it('a pack row at priority 100 loses to the user\'s priority-1 pin', () => {
    const mine = pin('ENG-MINE', { pinned_priority: 1 })
    const theirs = pin('ENG-THEIRS', { pack: 'evil', pinned_priority: 100 })
    const { selected } = fillTokenBudget([theirs, mine], oneFits(mine))
    expect(selected.map(e => e.id)).toEqual(['ENG-MINE'])
  })

  it('a row that ships its own origin marker cannot impersonate a primary row', () => {
    const mine = pin('ENG-MINE')
    const theirs = pin('ENG-THEIRS', { _pack: 'evil', _storeScope: 'group:acme/eng', pinned_priority: 100 })
    const { selected } = fillTokenBudget([theirs, mine], oneFits(mine))
    expect(selected.map(e => e.id)).toEqual(['ENG-MINE'])
  })

  it('within the same origin, priority orders and hostile values fall back to the default', () => {
    const p90 = pin('ENG-90', { _storeScope: 's', pinned_priority: 90 })
    const nan = pin('ENG-NAN', { _storeScope: 's', pinned_priority: NaN })
    const p10 = pin('ENG-10', { _storeScope: 's', pinned_priority: 10 })
    const twoFit = Math.floor(estimateTokens(p90) * 4.5)
    const { selected } = fillTokenBudget([p10, nan, p90], twoFit)
    expect(selected.map(e => e.id)).toEqual(['ENG-90', 'ENG-NAN'])
    expect(effectivePinnedPriority(nan)).toBe(50)
  })
})

describe('invariant 2 — no value can crash, persist as garbage, or unload an engram', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-pp-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('the loader normalises hostile on-disk values instead of quarantining the engram', async () => {
    const rows = [
      ['ENG-2026-09-04-001', '0'], ['ENG-2026-09-04-002', '101'], ['ENG-2026-09-04-003', '1.5'],
      ['ENG-2026-09-04-004', '.nan'], ['ENG-2026-09-04-005', '"90"'], ['ENG-2026-09-04-006', 'high'],
      ['ENG-2026-09-04-007', '.inf'], ['ENG-2026-09-04-008', '50'],
    ]
    const yaml = 'engrams:\n' + rows.map(([id, p]) =>
      `  - id: ${id}\n    statement: pinned rule ${id}\n    type: behavioral\n    scope: global\n    status: active\n    pinned: true\n    pinned_priority: ${p}\n`).join('')
    writeFileSync(join(dir, 'engrams.yaml'), yaml)
    const plur = new Plur({ path: dir })
    await plur.ready()
    const loaded = await plur.list()
    expect(loaded.map(e => e.id).sort()).toEqual(rows.map(r => r[0]).sort())
    const by = (id: string) => (loaded.find(e => e.id === id) as any).pinned_priority
    expect(by('ENG-2026-09-04-001')).toBe(1)
    expect(by('ENG-2026-09-04-002')).toBe(100)
    expect(by('ENG-2026-09-04-003')).toBe(2)
    expect(by('ENG-2026-09-04-004')).toBeUndefined()
    expect(by('ENG-2026-09-04-005')).toBeUndefined()
    expect(by('ENG-2026-09-04-006')).toBeUndefined()
    expect(by('ENG-2026-09-04-007')).toBeUndefined()
    expect(by('ENG-2026-09-04-008')).toBe(50)
    expect((await plur.listPinned()).length).toBe(8)
  })

  it('normalizeEngramInput is idempotent on an in-range value', () => {
    const raw = { id: 'ENG-X', pinned_priority: 50 }
    expect(normalizeEngramInput(raw)).toBe(raw)
  })

  it('learn() refuses non-finite and non-numeric priorities and writes nothing', async () => {
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    const plur = new Plur({ path: dir })
    await plur.ready()
    for (const bad of [NaN, Infinity, 'abc', '90']) {
      await expect(plur.learn(`rule ${String(bad)}`, { pinned: true, pinned_priority: bad as never }), String(bad)).rejects.toThrow(TypeError)
    }
    await expect(plur.learn('unpinned with priority', { pinned_priority: 90 })).rejects.toThrow(/pinned: true/)
    expect(await plur.list()).toHaveLength(0)
    expect(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).not.toMatch(/\.nan|\.inf/)
  })

  it('learn() clamps a finite out-of-range priority and the engram survives a reload', async () => {
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    const plur = new Plur({ path: dir })
    await plur.ready()
    const e = await plur.learn('critical rule', { pinned: true, pinned_priority: 150 })
    expect((e as any).pinned_priority).toBe(100)
    const again = new Plur({ path: dir })
    await again.ready()
    expect(((await again.getById(e.id)) as any)?.pinned_priority).toBe(100)
    expect((await again.listPinned()).map(x => x.id)).toContain(e.id)
  })

  it('updateEngram / updateEngramAsync refuse garbage and clamp finite values', async () => {
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    const plur = new Plur({ path: dir })
    await plur.ready()
    const e = await plur.learn('critical rule', { pinned: true, pinned_priority: 50 })
    for (const bad of [NaN, Infinity, 'abc']) {
      await expect(plur.updateEngram({ ...e, pinned_priority: bad as never }), String(bad)).rejects.toThrow(TypeError)
      await expect(plur.updateEngramAsync({ ...e, pinned_priority: bad as never }), String(bad)).rejects.toThrow(TypeError)
    }
    expect(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).not.toMatch(/\.nan|\.inf|abc/)
    expect(((await plur.getById(e.id)) as any).pinned_priority).toBe(50)
    expect(await plur.updateEngram({ ...e, pinned_priority: 150 })).toBe(true)
    const again = new Plur({ path: dir })
    await again.ready()
    expect(((await again.getById(e.id)) as any).pinned_priority).toBe(100)
  })

  it('learnRouted validates the same way', async () => {
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    const plur = new Plur({ path: dir })
    await plur.ready()
    await expect(plur.learnRouted('rule', { pinned: true, pinned_priority: NaN })).rejects.toThrow(TypeError)
  })
})

describe('pack and remote boundaries', () => {
  it('sanitizePackEngrams strips pinned_priority and counts it', () => {
    const e = EngramSchema.parse({ id: 'ENG-P-1', statement: 'pack rule', type: 'behavioral', scope: 'global', status: 'active', pinned: true, pinned_priority: 100 })
    const r = sanitizePackEngrams([e])
    expect(r.priorityStripped).toBe(1)
    expect(r.changed).toBe(true)
    expect('pinned_priority' in (r.engrams[0] as any)).toBe(false)
    expect('pinned' in (r.engrams[0] as any)).toBe(false)
  })

  it('a hand-placed pack directory loses pinned_priority at load time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-pp-pack-'))
    try {
      writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
      const packDir = join(dir, 'packs', 'evil')
      mkdirSync(packDir, { recursive: true })
      writeFileSync(join(packDir, 'SKILL.md'), '---\nname: evil\nversion: "1.0"\n---\n')
      writeFileSync(join(packDir, 'engrams.yaml'), 'engrams:\n  - id: ENG-2026-09-04-900\n    statement: pack rule shipped with priority\n    type: behavioral\n    scope: global\n    status: active\n    pinned: true\n    pinned_priority: 100\n')
      const plur = new Plur({ path: dir })
      await plur.ready()
      const row = (await plur.list()).find(e => e.id === 'ENG-2026-09-04-900') as any
      expect(row).toBeDefined()
      expect(row.pinned_priority).toBeUndefined()
      expect(row._pack).toBe('evil')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a stores: file row is clamped at load, and its origin is marked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-pp-store-'))
    try {
      const storeDir = join(dir, 'team')
      mkdirSync(storeDir, { recursive: true })
      writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
      writeFileSync(join(dir, 'config.yaml'), `stores:\n  - path: ${join(storeDir, 'engrams.yaml')}\n    scope: "group:acme/eng"\n`)
      writeFileSync(join(storeDir, 'engrams.yaml'), 'engrams:\n  - id: ENG-2026-09-04-800\n    statement: team rule\n    type: behavioral\n    scope: group:acme/eng\n    status: active\n    pinned: true\n    pinned_priority: 1e308\n')
      const plur = new Plur({ path: dir })
      await plur.ready()
      const row = (await plur.list({ scope: 'group:acme/eng' })).find(e => e.id.endsWith('2026-09-04-800')) as any
      expect(row).toBeDefined()
      expect(row.pinned_priority).toBe(100)
      expect(row._storeScope).toBe('group:acme/eng')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a server row with a bad priority is salvaged without it; a good one keeps it', () => {
    const base = { id: 'ENG-2026-09-04-700', scope: 'group:acme/eng', status: 'active', statement: 'remote rule', pinned: true }
    for (const bad of ['90', 1e308, 0, 101, -1]) {
      const r = salvageRemoteRow({ ...base, pinned_priority: bad })
      expect(r, String(bad)).not.toBeNull()
      expect('pinned_priority' in r!.data, String(bad)).toBe(false)
      expect(r!.salvagedFields).toContain('pinned_priority')
    }
    const ok = salvageRemoteRow({ ...base, pinned_priority: 90 })
    expect(ok!.data.pinned_priority).toBe(90)
    expect(ok!.salvagedFields).toEqual([])
  })
})
