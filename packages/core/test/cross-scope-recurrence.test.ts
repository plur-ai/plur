import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { readHistoryForEngram } from '../src/history.js'
import { computeContentHash } from '../src/content-hash.js'
import { loadEngrams, saveEngrams } from '../src/engrams.js'
import { EngramSchema } from '../src/schemas/engram.js'

/**
 * Cross-scope recurrence detection (issue #176).
 *
 * Contract:
 *   - First learn of statement S at scope X: creates engram with
 *     write_count: 1, recurrence_count: 0, scope: X
 *   - Re-learn of S at SAME scope X: scope-aware hash dedup hit
 *     (the #107 path) → write_count++, recurrence_count unchanged
 *   - Re-learn of S at DIFFERENT scope Y: cross-scope recurrence
 *     → recurrence_count goes 0→1, scope unchanged (no broadening yet,
 *       1 cross-scope hit isn't enough evidence)
 *   - Re-learn of S at scope Z (or back at Y): recurrence_count goes 1→2
 *     → scope broadens to 'global', commitment escalates one step
 *   - Once scope='global' and commitment='locked': stops escalating
 *     (further recurrences still increment the counter for telemetry)
 */
// Decision A1 (2026-09-29): a SHARED save is never absorbed — it credits the
// engram it matched and writes its own team copy. The ladder in these tests is
// therefore driven by personal saves (`user:*`, `local`), which still recur
// onto the engram they match; the recurring scopes used to be `project:b`,
// `project:c` and `project:primary-*`.
describe('cross-scope recurrence (#176)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-cross-scope-'))
    plur = new Plur({ path: dir })
  })

  afterEach(() => { rmSync(dir, { recursive: true }) })

  describe('detection thresholds', () => {
    it('1st cross-scope re-learn: recurrence_count=1, scope unchanged', async () => {
      const first = await plur.learn('always verify days programmatically', { scope: 'project:a' })
      expect(first.scope).toBe('project:a')
      expect(first.recurrence_count).toBe(0)

      const second = await plur.learn('always verify days programmatically', { scope: 'user:b' })

      // SAME engram, mutated — not a new one
      expect(second.id).toBe(first.id)
      // Scope stays project:a — 1 hit isn't enough evidence to broaden
      expect(second.scope).toBe('project:a')
      expect(second.recurrence_count).toBe(1)
      // sources should now have 2 entries (original + cross-scope hit)
      expect(second.sources).toHaveLength(2)
      expect(second.sources![1].scope).toBe('user:b')
    })

    it('2nd cross-scope re-learn: scope broadens to global, commitment escalates', async () => {
      const first = await plur.learn('rule', { scope: 'project:a' })
      expect(first.commitment).toBe('leaning')  // default

      await plur.learn('rule', { scope: 'user:b' })  // 1st cross-scope, recurrence=1
      const third = await plur.learn('rule', { scope: 'user:c' })  // 2nd cross-scope → broaden + escalate

      expect(third.id).toBe(first.id)
      expect(third.recurrence_count).toBe(2)
      expect(third.scope).toBe('global')                       // broadened
      expect(third.commitment).toBe('decided')                  // leaning → decided
      expect(third.sources).toHaveLength(3)
    })

    it('3rd+ cross-scope recurrence: commitment continues escalating', async () => {
      await plur.learn('repeated mistake', { scope: 'project:a' })
      await plur.learn('repeated mistake', { scope: 'user:b' })  // recurrence=1
      await plur.learn('repeated mistake', { scope: 'user:c' })  // recurrence=2: decided
      // #1268: a 4th SHARED save would only credit the graduated global engram
      // (never locking it) and write its own team copy, so the escalation to
      // locked is driven by a personal save here.
      const fourth = await plur.learn('repeated mistake', { scope: 'local' })  // recurrence=3: locked

      expect(fourth.recurrence_count).toBe(3)
      expect(fourth.commitment).toBe('locked')
      expect(fourth.locked_at).toBeDefined()
      expect(fourth.locked_reason).toMatch(/cross-scope recurrence/i)
    })

    it('locked engrams keep recording recurrences but do not re-escalate', async () => {
      await plur.learn('important rule', { scope: 'project:a' })
      await plur.learn('important rule', { scope: 'user:b' })
      await plur.learn('important rule', { scope: 'user:c' })
      await plur.learn('important rule', { scope: 'local' })  // locked (personal save, see #1268)

      const fifth = await plur.learn('important rule', { scope: 'user:e' })
      expect(fifth.commitment).toBe('locked')  // still locked
      expect(fifth.recurrence_count).toBe(4)  // counter still increments
      // No additional locked_at updates after first lock
    })

    it('escalates exploring → leaning forward, never backward (audit iter-1 fix)', async () => {
      // Pre-create an engram with commitment='exploring' (the lowest rung)
      // and verify the ladder advances it FORWARD, not silently fallback
      // to 'leaning' via the ternary default arm.
      const first = await plur.learn('exploring rule', { scope: 'project:a', commitment: 'exploring' })
      expect(first.commitment).toBe('exploring')

      await plur.learn('exploring rule', { scope: 'user:b' })  // recurrence=1, no change
      const after = await plur.learn('exploring rule', { scope: 'user:c' })  // recurrence=2

      // Forward ladder: exploring → leaning (NOT skipped, NOT demoted)
      expect(after.commitment).toBe('leaning')
      expect(after.scope).toBe('global')
      expect(after.recurrence_count).toBe(2)
    })

    it('preserves sources/refcount on legacy secondary-store engrams (audit iter-3 fix)', async () => {
      // Critic iter-3: field-copy approach would set stored.sources = hit.sources,
      // which destroys an existing sources array when hit's sources was loaded
      // through Zod defaults (empty array on a legacy engram without the field).
      // Single-mutation refactor re-applies the same mutation to the stored
      // engram, never copies undefined-able fields.
      const secondaryDir = mkdtempSync(join(tmpdir(), 'plur-secondary-legacy-'))
      const secondaryPath = join(secondaryDir, 'engrams.yaml')
      const legacyStmt = 'legacy rule that pre-dates ref-counting'
      // Build a legacy engram via schema defaults — no write_count, no
      // sources, no recurrence_count in the input → all defaulted on parse.
      const legacy = EngramSchema.parse({
        id: 'ENG-LEGACY-001',
        version: 2,
        status: 'active',
        consolidated: false,
        type: 'behavioral',
        scope: 'project:legacy-a',
        visibility: 'private',
        statement: legacyStmt,
        activation: {
          retrieval_strength: 0.7,
          storage_strength: 1.0,
          frequency: 0,
          last_accessed: '2024-01-01',
        },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 },
        episode_ids: [],
      })
      // computeContentHash matches what cross-scope detection will compute
      ;(legacy as any).content_hash = computeContentHash(legacyStmt)
      saveEngrams(secondaryPath, [legacy])
      try {
        plur.addStore(secondaryPath, 'project:legacy-a', { shared: true, readonly: false })

        // 1st cross-scope hit — no broadening yet but sources should append cleanly
        // Note: id may be namespaced (e.g. ENG-{prefix}-LEGACY-001) via secondary store
        const after1 = await plur.learn(legacyStmt, { scope: 'user:b' })
        expect(after1.id).toContain('LEGACY-001')
        expect(after1.recurrence_count).toBe(1)
        // sources started empty (Zod default) → should now have 1 entry
        expect(after1.sources).toHaveLength(1)
        expect(after1.sources![0].scope).toBe('user:b')

        // The 1st hit landed on disk in the SECONDARY store (where the engram
        // lives), and its sources array survived the round trip.
        const afterFirst = loadEngrams(secondaryPath).find(e => e.id === 'ENG-LEGACY-001')!
        expect((afterFirst as any).recurrence_count).toBe(1)
        expect(Array.isArray((afterFirst as any).sources)).toBe(true)
        expect((afterFirst as any).sources.length).toBe(1)

        // 2nd cross-scope hit. Owner decision (2026-09-29, #1268): what is in a
        // team store stays there. This is a `shared: true` store, so instead of
        // broadening the stored engram in place, the ladder leaves it exactly
        // as it is and credits a `global` copy in the local primary store
        // (copy-on-promote). Before, this test asserted the stored engram was
        // rewritten to global in the team's own file.
        const fileBefore = readFileSync(secondaryPath, 'utf8')
        const promoted = await plur.learn(legacyStmt, { scope: 'user:c' })
        expect(readFileSync(secondaryPath, 'utf8')).toBe(fileBefore)
        expect(promoted.scope).toBe('global')
        expect((promoted as any).derived_from).toBe(after1.id)
        expect(promoted.recurrence_count).toBe(2)
      } finally {
        rmSync(secondaryDir, { recursive: true, force: true })
      }
    })

    it('persists escalation to a writable secondary store (audit iter-2 fix)', async () => {
      // Set up a writable secondary store. _findEngramStore handles the
      // namespace stripping; _recordCrossScopeRecurrence must route the
      // write to the right store path (not silently drop).
      const secondaryDir = mkdtempSync(join(tmpdir(), 'plur-secondary-'))
      const secondaryPath = join(secondaryDir, 'engrams.yaml')
      // Initialize an empty store file so saveEngrams can be called. This must
      // be the shape PLUR actually writes — a mapping with an `engrams` key.
      // A bare `[]` is a top-level sequence, which the loader now rejects
      // rather than silently reading as an empty corpus (audit #794, F1).
      writeFileSync(secondaryPath, 'engrams: []\n')
      try {
        plur.addStore(secondaryPath, 'project:secondary-a', { shared: true, readonly: false })

        // Learn at the secondary scope (writes to the secondary store path)
        const seed = await plur.learn('cross-store rule', { scope: 'project:secondary-a' })
        expect(seed.scope).toBe('project:secondary-a')

        // Cross-scope re-learn at primary scope. Engram match is in the
        // secondary store; mutation must persist there.
        await plur.learn('cross-store rule', { scope: 'user:primary-b' })  // recurrence=1, no scope change yet
        const after = await plur.learn('cross-store rule', { scope: 'user:primary-c' })  // recurrence=2

        // Owner decision (2026-09-29, #1268): what is in a team store stays
        // there. This store is `shared: true`, so the 2nd hit does not rewrite
        // the stored engram to global; it creates a `global` copy in the local
        // primary store (copy-on-promote). Before, this test asserted the team
        // engram itself was broadened to global.
        expect(after.scope).toBe('global')
        expect(after.id).not.toBe(seed.id)
        expect(after.recurrence_count).toBe(2)

        // Reload from disk to verify durability: the 1st hit persisted in the
        // SECONDARY store (the iter-1 defect was that it was silently dropped),
        // and the promotion persisted as a copy in the primary store.
        const fresh = new Plur({ path: dir })
        const team = (await fresh.list({ scope: 'project:secondary-a' }))
          .find(e => e.statement === 'cross-store rule' && e.id === seed.id)
        expect(team).toBeDefined()
        expect(team!.recurrence_count).toBe(1)
        expect(team!.scope).toBe('project:secondary-a')
        const copy = (await fresh.list({ scope: 'global' }))
          .find(e => e.statement === 'cross-store rule' && e.scope === 'global')
        expect(copy).toBeDefined()
        expect(copy!.recurrence_count).toBe(2)
        expect((copy as any).derived_from).toBe(seed.id)
      } finally {
        rmSync(secondaryDir, { recursive: true, force: true })
      }
    })
  })

  describe('does not trigger when it should not', () => {
    it('same-scope re-learn does NOT count as recurrence (uses #107 path instead)', async () => {
      const first = await plur.learn('rule', { scope: 'project:a' })
      const second = await plur.learn('rule', { scope: 'project:a' })

      expect(second.id).toBe(first.id)
      expect(second.recurrence_count).toBe(0)   // unchanged — not a cross-scope event
      expect(second.write_count).toBe(2)    // #107 path bumped this
      expect(second.scope).toBe('project:a')    // no broadening
    })

    it('different content at different scope creates a fresh engram', async () => {
      const a = await plur.learn('rule X', { scope: 'project:a' })
      const b = await plur.learn('rule Y', { scope: 'user:b' })

      expect(b.id).not.toBe(a.id)
      expect(b.recurrence_count).toBe(0)
      expect(b.scope).toBe('user:b')
    })

    it('retired engrams are NOT candidates for cross-scope recurrence — re-learning creates fresh', async () => {
      const first = await plur.learn('phoenix rule', { scope: 'project:a' })
      // Retire (force count to 0 then forget)
      await plur.forget(first.id)
      expect((await plur.getById(first.id))!.status).toBe('retired')

      // Cross-scope re-learn should create a NEW engram, not resurrect
      const fresh = await plur.learn('phoenix rule', { scope: 'user:b' })
      expect(fresh.id).not.toBe(first.id)
      expect(fresh.recurrence_count).toBe(0)
    })

    it('force forget (#766): cross-scope recurrence bumps write_count to 2; force=true retires in one call', async () => {
      // Learn at global — simulates a prior session's engram
      const eng = await plur.learn('comms rule', { scope: 'global' })
      expect((eng as any).write_count).toBe(1)

      // Cross-scope relearn → write_count=2, same engram returned
      // Personal→personal (a shared write would not be absorbed, #1268).
      const relearned = await plur.learn('comms rule', { scope: 'local' })
      expect(relearned.id).toBe(eng.id)  // cross-scope recurrence matched, same ID
      expect((relearned as any).write_count).toBe(2)

      // Without force: one forget only decrements → still active
      await plur.forget(eng.id)
      const afterDecrement = await plur.getById(eng.id)
      expect(afterDecrement?.status).toBe('active')
      expect((afterDecrement as any).write_count).toBe(1)

      // With force: one call retires completely (#766 fix)
      await plur.forget(eng.id, undefined, { force: true })
      const afterForce = await plur.getById(eng.id)
      expect(afterForce?.status).toBe('retired')

      // Re-learn at a different scope creates fresh engram — resurrection is prevented
      const fresh = await plur.learn('comms rule', { scope: 'group:team/infra' })
      expect(fresh.id).not.toBe(eng.id)
      expect(fresh.scope).toBe('group:team/infra')
      expect((fresh as any).recurrence_count).toBe(0)
    })

    it('normalization-equivalent statements (punct/case) match across scopes', async () => {
      await plur.learn('Always Use Semicolons!', { scope: 'project:a' })
      const second = await plur.learn('always use   semicolons', { scope: 'user:b' })
      expect(second.recurrence_count).toBe(1)
    })

    it('personal-scope engrams (local) are NOT promoted to global on cross-scope recurrence (#362 item ii)', async () => {
      // A local engram recurring across scopes should stay in the personal family.
      // Only shared scopes (project:*, space:*, etc.) get promoted to global.
      const first = await plur.learn('personal rule', { scope: 'local' })
      expect(first.scope).toBe('local')

      // Personal scopes only: since #1268 a shared write (project:*) is never
      // absorbed into a personal engram, so it would not recur onto this one.
      await plur.learn('personal rule', { scope: 'user:a' })  // 1st cross-scope, recurrence=1
      const third = await plur.learn('personal rule', { scope: 'agent:b' })  // 2nd cross-scope

      // recurrence_count increments as normal
      expect(third.recurrence_count).toBe(2)
      // Commitment escalates (that behavior is unchanged)
      expect(third.commitment).toBe('decided')
      // But scope stays local — personal-family ceiling prevents global promotion
      expect(third.scope).toBe('local')
    })
  })

  describe('persistence + observability', () => {
    it('persists recurrence_count + broadened scope across Plur instances', async () => {
      await plur.learn('persisted rule', { scope: 'project:a' })
      await plur.learn('persisted rule', { scope: 'user:b' })
      await plur.learn('persisted rule', { scope: 'user:c' })

      const fresh = new Plur({ path: dir })
      const found = (await fresh.list({ scope: 'global' })).find(e => e.statement === 'persisted rule')
      expect(found).toBeDefined()
      expect(found!.recurrence_count).toBe(2)
      expect(found!.commitment).toBe('decided')
    })

    it('emits recurrence_detected history event ONLY when scope or commitment changes (audit iter-1)', async () => {
      const first = await plur.learn('history-watched rule', { scope: 'project:a' })

      // 1st cross-scope hit: counter increments but no scope/commitment
      // change (threshold is >=2). No history event emitted (would be a
      // no-op spam event). Counter is still visible via the engram field.
      const afterFirstHit = await plur.learn('history-watched rule', { scope: 'user:b' })
      expect(afterFirstHit.recurrence_count).toBe(1)
      let events = readHistoryForEngram(plur.getStorageRoot(), first.id)
      expect(events.filter(e => e.event === 'recurrence_detected').length).toBe(0)

      // 2nd cross-scope hit: scope broadens to global + commitment escalates
      // → THIS time a history event fires, with before/after state.
      await plur.learn('history-watched rule', { scope: 'user:c' })
      events = readHistoryForEngram(plur.getStorageRoot(), first.id)
      const recurrences = events.filter(e => e.event === 'recurrence_detected')
      expect(recurrences.length).toBe(1)
      expect(recurrences[0].data.from_scope).toBe('user:c')
      expect(recurrences[0].data.previous_scope).toBe('project:a')
      expect(recurrences[0].data.new_scope).toBe('global')
      expect(recurrences[0].data.previous_commitment).toBe('leaning')
      expect(recurrences[0].data.new_commitment).toBe('decided')
      expect(recurrences[0].data.recurrence_count).toBe(2)
      // Audit iter-4 fix (Critic medium): persisted_to field must be present
      // and accurate. Primary store engram → 'primary'.
      expect(recurrences[0].data.persisted_to).toBe('primary')
    })

    it('a hit in a remote/readonly store does not absorb the write: new row + history-only event (Decision A, was audit iter-4 Data)', async () => {
      // CHANGED by owner Decision A ("always store my write", 2026-09-27).
      // Before: the cross-scope re-learn was absorbed into the READONLY row,
      // mutated in memory only (`persisted_to: 'in-memory'`), and nothing was
      // stored — uninstall the store and the write had never happened.
      // Now: the write is stored as a new row in the requested scope, the
      // readonly row is not mutated at all, and the recurrence is recorded
      // against it in history only (`persisted_to: 'history-only'`).
      const readonlyDir = mkdtempSync(join(tmpdir(), 'plur-readonly-'))
      const readonlyPath = join(readonlyDir, 'engrams.yaml')
      const stmt = 'readonly-divergence rule'
      const readonlyEngram = EngramSchema.parse({
        id: 'ENG-RO-001',
        version: 2,
        status: 'active',
        consolidated: false,
        type: 'behavioral',
        scope: 'project:readonly-a',
        visibility: 'private',
        statement: stmt,
        activation: {
          retrieval_strength: 0.7,
          storage_strength: 1.0,
          frequency: 0,
          last_accessed: '2024-01-01',
        },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 },
        episode_ids: [],
      })
      ;(readonlyEngram as any).content_hash = computeContentHash(stmt)
      saveEngrams(readonlyPath, [readonlyEngram])
      try {
        plur.addStore(readonlyPath, 'project:readonly-a', { shared: true, readonly: true })

        const after = await plur.learn(stmt, { scope: 'project:b' })
        // A new row in the requested scope, not the readonly engram.
        expect(after.scope).toBe('project:b')
        expect(after.recurrence_count ?? 0).toBe(0)
        const roRow = (await plur.list({ include_expired: true })).find(e => e.scope === 'project:readonly-a')!
        expect(roRow.recurrence_count ?? 0).toBe(0)
        expect(roRow.write_count ?? 1).toBe(1)
        // The recurrence is recorded against the readonly hit, history only.
        const events = readHistoryForEngram(plur.getStorageRoot(), roRow.id)
          .filter(e => e.event === 'recurrence_detected')
        expect(events.length).toBe(1)
        expect(events[0].data.persisted_to).toBe('history-only')
        expect(events[0].data.stored_as).toBe(after.id)
        expect(events[0].data.held_in).toBe('readonly')
        expect(events[0].data.recurrence_count).toBe(0)
        expect(events[0].data.previous_scope).toBe(events[0].data.new_scope)
      } finally {
        rmSync(readonlyDir, { recursive: true, force: true })
      }
    })

    it('does NOT spam history on subsequent recurrences once at global+locked (audit iter-1)', async () => {
      // Drive engram to global + locked
      const first = await plur.learn('rule', { scope: 'project:a' })
      await plur.learn('rule', { scope: 'user:b' })  // recurrence_count=1, no event
      await plur.learn('rule', { scope: 'user:c' })  // recurrence_count=2, scope→global commit→decided EVENT
      await plur.learn('rule', { scope: 'local' })  // recurrence_count=3, commit→locked EVENT (personal save, #1268)

      const eventsAfterLock = readHistoryForEngram(plur.getStorageRoot(), first.id)
        .filter(e => e.event === 'recurrence_detected')
      expect(eventsAfterLock.length).toBe(2)  // events at recurrence=2 and recurrence=3

      // Subsequent learns at new scopes: counter increments, NO events
      // (engram already at global+locked, nothing further to escalate).
      await plur.learn('rule', { scope: 'user:e' })
      await plur.learn('rule', { scope: 'agent:f' })

      const finalEvents = readHistoryForEngram(plur.getStorageRoot(), first.id)
        .filter(e => e.event === 'recurrence_detected')
      expect(finalEvents.length).toBe(2)  // no new spurious events

      // But the counter is still incrementing for telemetry
      const final = (await plur.list({ scope: 'global' })).find(e => e.statement === 'rule')
      expect(final?.recurrence_count).toBe(5)
    })
  })
})
