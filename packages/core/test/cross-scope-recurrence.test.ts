import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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
 *     reference_count: 1, recurrence_count: 0, scope: X
 *   - Re-learn of S at SAME scope X: scope-aware hash dedup hit
 *     (the #107 path) → reference_count++, recurrence_count unchanged
 *   - Re-learn of S at DIFFERENT scope Y: cross-scope recurrence
 *     → recurrence_count goes 0→1, scope unchanged (no broadening yet,
 *       1 cross-scope hit isn't enough evidence)
 *   - Re-learn of S at scope Z (or back at Y): recurrence_count goes 1→2
 *     → scope broadens to 'global', commitment escalates one step
 *   - Once scope='global' and commitment='locked': stops escalating
 *     (further recurrences still increment the counter for telemetry)
 */
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

      const second = await plur.learn('always verify days programmatically', { scope: 'project:b' })

      // SAME engram, mutated — not a new one
      expect(second.id).toBe(first.id)
      // Scope stays project:a — 1 hit isn't enough evidence to broaden
      expect(second.scope).toBe('project:a')
      expect(second.recurrence_count).toBe(1)
      // sources should now have 2 entries (original + cross-scope hit)
      expect(second.sources).toHaveLength(2)
      expect(second.sources![1].scope).toBe('project:b')
    })

    it('2nd cross-scope re-learn: scope broadens to global, commitment escalates', async () => {
      const first = await plur.learn('rule', { scope: 'project:a' })
      expect(first.commitment).toBe('leaning')  // default

      await plur.learn('rule', { scope: 'project:b' })  // 1st cross-scope, recurrence=1
      const third = await plur.learn('rule', { scope: 'project:c' })  // 2nd cross-scope → broaden + escalate

      expect(third.id).toBe(first.id)
      expect(third.recurrence_count).toBe(2)
      expect(third.scope).toBe('global')                       // broadened
      expect(third.commitment).toBe('decided')                  // leaning → decided
      expect(third.sources).toHaveLength(3)
    })

    it('3rd+ cross-scope recurrence: commitment continues escalating', async () => {
      await plur.learn('repeated mistake', { scope: 'project:a' })
      await plur.learn('repeated mistake', { scope: 'project:b' })  // recurrence=1
      await plur.learn('repeated mistake', { scope: 'project:c' })  // recurrence=2: decided
      const fourth = await plur.learn('repeated mistake', { scope: 'project:d' })  // recurrence=3: locked

      expect(fourth.recurrence_count).toBe(3)
      expect(fourth.commitment).toBe('locked')
      expect(fourth.locked_at).toBeDefined()
      expect(fourth.locked_reason).toMatch(/cross-scope recurrence/i)
    })

    it('locked engrams keep recording recurrences but do not re-escalate', async () => {
      await plur.learn('important rule', { scope: 'project:a' })
      await plur.learn('important rule', { scope: 'project:b' })
      await plur.learn('important rule', { scope: 'project:c' })
      await plur.learn('important rule', { scope: 'project:d' })  // locked

      const fifth = await plur.learn('important rule', { scope: 'project:e' })
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

      await plur.learn('exploring rule', { scope: 'project:b' })  // recurrence=1, no change
      const after = await plur.learn('exploring rule', { scope: 'project:c' })  // recurrence=2

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
      // Build a legacy engram via schema defaults — no reference_count, no
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
        const after1 = await plur.learn(legacyStmt, { scope: 'project:b' })
        expect(after1.id).toContain('LEGACY-001')
        expect(after1.recurrence_count).toBe(1)
        // sources started empty (Zod default) → should now have 1 entry
        expect(after1.sources).toHaveLength(1)
        expect(after1.sources![0].scope).toBe('project:b')

        // 2nd cross-scope hit — broadens to global, mutation should persist
        // to the SECONDARY store (where the engram actually lives), and the
        // stored engram's sources array must NOT be undefined after the round trip.
        await plur.learn(legacyStmt, { scope: 'project:c' })

        // Read the secondary store file directly to verify durability.
        // This bypasses namespace lookup ambiguity and asserts the on-disk truth.
        const storedEngrams = loadEngrams(secondaryPath)
        const stored = storedEngrams.find(e => e.id === 'ENG-LEGACY-001')
        expect(stored).toBeDefined()
        expect(stored!.scope).toBe('global')
        expect((stored as any).recurrence_count).toBe(2)
        // Critical: sources is a real array with 2 entries, NOT undefined or empty.
        // (Iter-3 bug: field-copy approach overwrote stored.sources with hit.sources,
        // which would be [...defaultedEmpty, newEntry] losing nothing here BUT
        // if hit.sources had been undefined (legacy not yet defaulted in caller chain)
        // the stored array would be destroyed. Single-mutation re-applies from
        // existing stored state.)
        expect(Array.isArray((stored as any).sources)).toBe(true)
        expect((stored as any).sources.length).toBe(2)

        // Iter-4 (Critic medium): the history event for the broadening
        // (2nd cross-scope hit) must record persisted_to='secondary' so an
        // observability consumer can confirm the mutation landed on disk
        // outside the primary store.
        const broadenEvents = readHistoryForEngram(plur.getStorageRoot(), after1.id)
          .filter(e => e.event === 'recurrence_detected')
        // Exactly one event: the broadening at recurrence=2 (1st hit doesn't fire here
        // because the engram is in a WRITABLE secondary store, so persisted_to='secondary'
        // is durable and the no-material-change branch correctly skips emission).
        expect(broadenEvents.length).toBe(1)
        expect(broadenEvents[0].data.persisted_to).toBe('secondary')
        expect(broadenEvents[0].data.new_scope).toBe('global')
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
        await plur.learn('cross-store rule', { scope: 'project:primary-b' })  // recurrence=1, no scope change yet
        const after = await plur.learn('cross-store rule', { scope: 'project:primary-c' })  // recurrence=2, broadens

        // In-memory state shows broadening
        expect(after.recurrence_count).toBe(2)
        expect(after.scope).toBe('global')

        // Reload from disk to verify durability — the mutation should
        // have been written to the SECONDARY store, not silently dropped
        // (this was the iter-1 defect Critic + Data flagged).
        const fresh = new Plur({ path: dir })
        const reloaded = (await fresh.list({ scope: 'global' }))
          .find(e => e.statement === 'cross-store rule')
        expect(reloaded).toBeDefined()
        expect(reloaded!.recurrence_count).toBe(2)
        expect(reloaded!.scope).toBe('global')
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
      expect(second.reference_count).toBe(2)    // #107 path bumped this
      expect(second.scope).toBe('project:a')    // no broadening
    })

    it('different content at different scope creates a fresh engram', async () => {
      const a = await plur.learn('rule X', { scope: 'project:a' })
      const b = await plur.learn('rule Y', { scope: 'project:b' })

      expect(b.id).not.toBe(a.id)
      expect(b.recurrence_count).toBe(0)
      expect(b.scope).toBe('project:b')
    })

    it('retired engrams are NOT candidates for cross-scope recurrence — re-learning creates fresh', async () => {
      const first = await plur.learn('phoenix rule', { scope: 'project:a' })
      // Retire (force count to 0 then forget)
      await plur.forget(first.id)
      expect((await plur.getById(first.id))!.status).toBe('retired')

      // Cross-scope re-learn should create a NEW engram, not resurrect
      const fresh = await plur.learn('phoenix rule', { scope: 'project:b' })
      expect(fresh.id).not.toBe(first.id)
      expect(fresh.recurrence_count).toBe(0)
    })

    it('force forget (#766): cross-scope recurrence bumps reference_count to 2; force=true retires in one call', async () => {
      // Learn at global — simulates a prior session's engram
      const eng = await plur.learn('comms rule', { scope: 'global' })
      expect((eng as any).reference_count).toBe(1)

      // Cross-scope relearn → reference_count=2, same engram returned
      const relearned = await plur.learn('comms rule', { scope: 'group:team/comms' })
      expect(relearned.id).toBe(eng.id)  // cross-scope recurrence matched, same ID
      expect((relearned as any).reference_count).toBe(2)

      // Without force: one forget only decrements → still active
      await plur.forget(eng.id)
      const afterDecrement = await plur.getById(eng.id)
      expect(afterDecrement?.status).toBe('active')
      expect((afterDecrement as any).reference_count).toBe(1)

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
      const second = await plur.learn('always use   semicolons', { scope: 'project:b' })
      expect(second.recurrence_count).toBe(1)
    })

    it('personal-scope engrams (local) are NOT promoted to global on cross-scope recurrence (#362 item ii)', async () => {
      // A local engram recurring across scopes should stay in the personal family.
      // Only shared scopes (project:*, space:*, etc.) get promoted to global.
      const first = await plur.learn('personal rule', { scope: 'local' })
      expect(first.scope).toBe('local')

      await plur.learn('personal rule', { scope: 'project:a' })  // 1st cross-scope, recurrence=1
      const third = await plur.learn('personal rule', { scope: 'project:b' })  // 2nd cross-scope

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
      await plur.learn('persisted rule', { scope: 'project:b' })
      await plur.learn('persisted rule', { scope: 'project:c' })

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
      const afterFirstHit = await plur.learn('history-watched rule', { scope: 'project:b' })
      expect(afterFirstHit.recurrence_count).toBe(1)
      let events = readHistoryForEngram(plur.getStorageRoot(), first.id)
      expect(events.filter(e => e.event === 'recurrence_detected').length).toBe(0)

      // 2nd cross-scope hit: scope broadens to global + commitment escalates
      // → THIS time a history event fires, with before/after state.
      await plur.learn('history-watched rule', { scope: 'project:c' })
      events = readHistoryForEngram(plur.getStorageRoot(), first.id)
      const recurrences = events.filter(e => e.event === 'recurrence_detected')
      expect(recurrences.length).toBe(1)
      expect(recurrences[0].data.from_scope).toBe('project:c')
      expect(recurrences[0].data.previous_scope).toBe('project:a')
      expect(recurrences[0].data.new_scope).toBe('global')
      expect(recurrences[0].data.previous_commitment).toBe('leaning')
      expect(recurrences[0].data.new_commitment).toBe('decided')
      expect(recurrences[0].data.recurrence_count).toBe(2)
      // Audit iter-4 fix (Critic medium): persisted_to field must be present
      // and accurate. Primary store engram → 'primary'.
      expect(recurrences[0].data.persisted_to).toBe('primary')
    })

    it('emits in-memory history event on 1st hit when stored engram is in a remote/readonly store (audit iter-4 Data)', async () => {
      // Set up a READONLY secondary store containing an engram. Cross-scope
      // re-learn cannot persist there — mutation stays in-memory only. Even
      // on the 1st hit (no scope/commitment change), the history event MUST
      // fire so consumers can detect divergence.
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

        // 1st cross-scope re-learn — no scope/commitment change, but the
        // mutation can't persist to the readonly store. Event SHOULD fire
        // with persisted_to='in-memory'.
        const after = await plur.learn(stmt, { scope: 'project:b' })
        expect(after.recurrence_count).toBe(1)
        // Use the engram's full (possibly namespaced) id to fetch history
        const events = readHistoryForEngram(plur.getStorageRoot(), after.id)
          .filter(e => e.event === 'recurrence_detected')
        expect(events.length).toBe(1)
        expect(events[0].data.persisted_to).toBe('in-memory')
        expect(events[0].data.recurrence_count).toBe(1)
        // No material change yet, so previous/new should match
        expect(events[0].data.previous_scope).toBe(events[0].data.new_scope)
      } finally {
        rmSync(readonlyDir, { recursive: true, force: true })
      }
    })

    it('does NOT spam history on subsequent recurrences once at global+locked (audit iter-1)', async () => {
      // Drive engram to global + locked
      const first = await plur.learn('rule', { scope: 'project:a' })
      await plur.learn('rule', { scope: 'project:b' })  // recurrence_count=1, no event
      await plur.learn('rule', { scope: 'project:c' })  // recurrence_count=2, scope→global commit→decided EVENT
      await plur.learn('rule', { scope: 'project:d' })  // recurrence_count=3, commit→locked EVENT

      const eventsAfterLock = readHistoryForEngram(plur.getStorageRoot(), first.id)
        .filter(e => e.event === 'recurrence_detected')
      expect(eventsAfterLock.length).toBe(2)  // events at recurrence=2 and recurrence=3

      // Subsequent learns at new scopes: counter increments, NO events
      // (engram already at global+locked, nothing further to escalate).
      await plur.learn('rule', { scope: 'project:e' })
      await plur.learn('rule', { scope: 'project:f' })

      const finalEvents = readHistoryForEngram(plur.getStorageRoot(), first.id)
        .filter(e => e.event === 'recurrence_detected')
      expect(finalEvents.length).toBe(2)  // no new spurious events

      // But the counter is still incrementing for telemetry
      const final = (await plur.list({ scope: 'global' })).find(e => e.statement === 'rule')
      expect(final?.recurrence_count).toBe(5)
    })
  })
})
