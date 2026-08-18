/**
 * Migration 006 — recompute content_hash under the v2 normalizer (#896, #911).
 *
 * The migration and `Plur.repairContentHashes` repair the same corpus from two
 * entry points, so these tests pin the three rules they must share. If they
 * ever diverge, a store's hashes depend on which one the user happened to
 * trigger — the failure this suite exists to prevent.
 */
import { describe, it, expect } from 'vitest'
import { migration } from '../src/migrations/20260813-006-recompute-content-hashes.js'
import { ALL_MIGRATIONS, CURRENT_SCHEMA_VERSION } from '../src/migrations/index.js'
import { computeContentHash, isHashable, HASH_NORMALIZER_VERSION } from '../src/content-hash.js'
import type { Engram } from '../src/schemas/engram.js'

const EMPTY_SHA = computeContentHash('')

function mk(id: string, statement: string, content_hash?: string): Engram {
  return {
    id,
    version: 2,
    status: 'active',
    type: 'behavioral',
    scope: 'global',
    statement,
    ...(content_hash !== undefined ? { content_hash } : {}),
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-08-13',
    },
    tags: [],
  } as unknown as Engram
}

const hashOf = (e: Engram) => (e as { content_hash?: string }).content_hash

describe('migration 006: recompute content hashes (#896)', () => {
  it('is registered and is the newest migration', () => {
    expect(ALL_MIGRATIONS.map(m => m.id)).toContain(migration.id)
    expect(ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]!.id).toBe(migration.id)
    expect(CURRENT_SCHEMA_VERSION).toBe(ALL_MIGRATIONS.length)
  })

  it('repairs a stale non-Latin hash — the #896 case', () => {
    // What v1 actually stored: every non-Latin statement normalized to '' and
    // therefore shared the SHA-256 of the empty string. That collision is the
    // bug; these two must come out with DIFFERENT hashes.
    const cyrillic = mk('ENG-1', 'развертывание должно', EMPTY_SHA)
    const japanese = mk('ENG-2', 'データベースの設定を確認', EMPTY_SHA)

    const [a, b] = migration.up([cyrillic, japanese])

    expect(hashOf(a!)).toBe(computeContentHash('развертывание должно'))
    expect(hashOf(b!)).toBe(computeContentHash('データベースの設定を確認'))
    expect(hashOf(a!)).not.toBe(hashOf(b!))
    expect(hashOf(a!)).not.toBe(EMPTY_SHA)
  })

  it('SKIPS an unhashable statement rather than stamping SHA-256("") on it', () => {
    // The rule lifted from repairContentHashes. Hashing these would give every
    // one of them the same value and let dedup absorb them into one engram —
    // re-inflicting #896 from inside the migration meant to repair it.
    const punctuation = mk('ENG-3', '!!! ???', 'whatever-was-there')
    const emoji = mk('ENG-4', '🔥🔥🔥')

    expect(isHashable('!!! ???')).toBe(false)
    const [a, b] = migration.up([punctuation, emoji])

    expect(hashOf(a!)).toBe('whatever-was-there') // untouched, not overwritten
    expect(hashOf(b!)).toBeUndefined() // and not invented
  })

  it('leaves an ASCII statement byte-identical — v1 and v2 agree there', () => {
    // Including the underscore case: `_` is inside the v2 character class, so
    // snake_case identifiers hash the same under both contracts. A migration
    // that changed these would mean the normalizer had regressed.
    for (const s of ['plain ascii statement', 'use snake_case identifiers', 'set RESTIC_CACHE_DIR explicitly']) {
      const before = computeContentHash(s)
      const [out] = migration.up([mk('ENG-5', s, before)])
      expect(hashOf(out!), s).toBe(before)
    }
  })

  it('does not rewrite a row whose hash is already correct', () => {
    // Identity, not just equality: an unchanged row must be the SAME object, so
    // a large already-migrated store is not rewritten wholesale to change
    // nothing.
    const correct = mk('ENG-6', 'already correct', computeContentHash('already correct'))
    const [out] = migration.up([correct])
    expect(out).toBe(correct)
  })

  it('skips a statement-less row without throwing', () => {
    const blank = mk('ENG-7', '')
    expect(() => migration.up([blank])).not.toThrow()
    expect(hashOf(migration.up([blank])[0]!)).toBeUndefined()
  })

  it('agrees with repairContentHashes on every rule', () => {
    // The cross-check that matters: for a mixed corpus, the set of rows the
    // migration rewrites must equal the set repairContentHashes would repair,
    // and the values must match. repairContentHashes skips unhashable rows and
    // only writes when missing or stale — mirrored here without needing a Plur
    // instance and a store lock.
    const corpus = [
      mk('ENG-A', 'развертывание должно', EMPTY_SHA), // stale  → repair
      mk('ENG-B', 'plain ascii', computeContentHash('plain ascii')), // correct → skip
      mk('ENG-C', 'déploiement rapide'), // missing → repair
      mk('ENG-D', '!!! ???', EMPTY_SHA), // unhashable → skip
    ]

    const out = migration.up(corpus)
    const rewritten = out.filter((e, i) => e !== corpus[i]).map(e => e.id)

    const wouldRepair = corpus
      .filter(e => e.statement && isHashable(e.statement))
      .filter(e => hashOf(e) !== computeContentHash(e.statement))
      .map(e => e.id)

    expect(rewritten).toEqual(wouldRepair)
    expect(rewritten).toEqual(['ENG-A', 'ENG-C'])
    for (const e of out) {
      if (e.statement && isHashable(e.statement)) {
        expect(hashOf(e), e.id).toBe(computeContentHash(e.statement))
      }
    }
  })

  it('down() is a no-op and says why', () => {
    // v1 output is not recoverable from v2, so the only available "rollback"
    // would be recomputing under the buggy normalizer — the bug, not a revert.
    const engrams = [mk('ENG-8', 'развертывание должно', computeContentHash('развертывание должно'))]
    expect(migration.down(engrams)).toBe(engrams)
  })

  it('the normalizer contract version is the one this migration carries', () => {
    expect(HASH_NORMALIZER_VERSION).toBe(2)
  })
})
