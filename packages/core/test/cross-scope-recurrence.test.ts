import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { readHistoryForEngram } from '../src/history.js'

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
    it('1st cross-scope re-learn: recurrence_count=1, scope unchanged', () => {
      const first = plur.learn('always verify days programmatically', { scope: 'project:a' })
      expect(first.scope).toBe('project:a')
      expect(first.recurrence_count).toBe(0)

      const second = plur.learn('always verify days programmatically', { scope: 'project:b' })

      // SAME engram, mutated — not a new one
      expect(second.id).toBe(first.id)
      // Scope stays project:a — 1 hit isn't enough evidence to broaden
      expect(second.scope).toBe('project:a')
      expect(second.recurrence_count).toBe(1)
      // sources should now have 2 entries (original + cross-scope hit)
      expect(second.sources).toHaveLength(2)
      expect(second.sources![1].scope).toBe('project:b')
    })

    it('2nd cross-scope re-learn: scope broadens to global, commitment escalates', () => {
      const first = plur.learn('rule', { scope: 'project:a' })
      expect(first.commitment).toBe('leaning')  // default

      plur.learn('rule', { scope: 'project:b' })  // 1st cross-scope, recurrence=1
      const third = plur.learn('rule', { scope: 'project:c' })  // 2nd cross-scope → broaden + escalate

      expect(third.id).toBe(first.id)
      expect(third.recurrence_count).toBe(2)
      expect(third.scope).toBe('global')                       // broadened
      expect(third.commitment).toBe('decided')                  // leaning → decided
      expect(third.sources).toHaveLength(3)
    })

    it('3rd+ cross-scope recurrence: commitment continues escalating', () => {
      plur.learn('repeated mistake', { scope: 'project:a' })
      plur.learn('repeated mistake', { scope: 'project:b' })  // recurrence=1
      plur.learn('repeated mistake', { scope: 'project:c' })  // recurrence=2: decided
      const fourth = plur.learn('repeated mistake', { scope: 'project:d' })  // recurrence=3: locked

      expect(fourth.recurrence_count).toBe(3)
      expect(fourth.commitment).toBe('locked')
      expect(fourth.locked_at).toBeDefined()
      expect(fourth.locked_reason).toMatch(/cross-scope recurrence/i)
    })

    it('locked engrams keep recording recurrences but do not re-escalate', () => {
      plur.learn('important rule', { scope: 'project:a' })
      plur.learn('important rule', { scope: 'project:b' })
      plur.learn('important rule', { scope: 'project:c' })
      plur.learn('important rule', { scope: 'project:d' })  // locked

      const fifth = plur.learn('important rule', { scope: 'project:e' })
      expect(fifth.commitment).toBe('locked')  // still locked
      expect(fifth.recurrence_count).toBe(4)  // counter still increments
      // No additional locked_at updates after first lock
    })

    it('escalates exploring → leaning forward, never backward (audit iter-1 fix)', () => {
      // Pre-create an engram with commitment='exploring' (the lowest rung)
      // and verify the ladder advances it FORWARD, not silently fallback
      // to 'leaning' via the ternary default arm.
      const first = plur.learn('exploring rule', { scope: 'project:a', commitment: 'exploring' })
      expect(first.commitment).toBe('exploring')

      plur.learn('exploring rule', { scope: 'project:b' })  // recurrence=1, no change
      const after = plur.learn('exploring rule', { scope: 'project:c' })  // recurrence=2

      // Forward ladder: exploring → leaning (NOT skipped, NOT demoted)
      expect(after.commitment).toBe('leaning')
      expect(after.scope).toBe('global')
      expect(after.recurrence_count).toBe(2)
    })

    it('persists escalation to a writable secondary store (audit iter-2 fix)', () => {
      // Set up a writable secondary store. _findEngramStore handles the
      // namespace stripping; _recordCrossScopeRecurrence must route the
      // write to the right store path (not silently drop).
      const secondaryDir = mkdtempSync(join(tmpdir(), 'plur-secondary-'))
      const secondaryPath = join(secondaryDir, 'engrams.yaml')
      // Initialize an empty store file so saveEngrams can be called
      writeFileSync(secondaryPath, '[]\n')
      try {
        plur.addStore(secondaryPath, 'project:secondary-a', { shared: true, readonly: false })

        // Learn at the secondary scope (writes to the secondary store path)
        const seed = plur.learn('cross-store rule', { scope: 'project:secondary-a' })
        expect(seed.scope).toBe('project:secondary-a')

        // Cross-scope re-learn at primary scope. Engram match is in the
        // secondary store; mutation must persist there.
        plur.learn('cross-store rule', { scope: 'project:primary-b' })  // recurrence=1, no scope change yet
        const after = plur.learn('cross-store rule', { scope: 'project:primary-c' })  // recurrence=2, broadens

        // In-memory state shows broadening
        expect(after.recurrence_count).toBe(2)
        expect(after.scope).toBe('global')

        // Reload from disk to verify durability — the mutation should
        // have been written to the SECONDARY store, not silently dropped
        // (this was the iter-1 defect Critic + Data flagged).
        const fresh = new Plur({ path: dir })
        const reloaded = fresh.list({ scope: 'global' })
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
    it('same-scope re-learn does NOT count as recurrence (uses #107 path instead)', () => {
      const first = plur.learn('rule', { scope: 'project:a' })
      const second = plur.learn('rule', { scope: 'project:a' })

      expect(second.id).toBe(first.id)
      expect(second.recurrence_count).toBe(0)   // unchanged — not a cross-scope event
      expect(second.reference_count).toBe(2)    // #107 path bumped this
      expect(second.scope).toBe('project:a')    // no broadening
    })

    it('different content at different scope creates a fresh engram', () => {
      const a = plur.learn('rule X', { scope: 'project:a' })
      const b = plur.learn('rule Y', { scope: 'project:b' })

      expect(b.id).not.toBe(a.id)
      expect(b.recurrence_count).toBe(0)
      expect(b.scope).toBe('project:b')
    })

    it('retired engrams are NOT candidates for cross-scope recurrence — re-learning creates fresh', async () => {
      const first = plur.learn('phoenix rule', { scope: 'project:a' })
      // Retire (force count to 0 then forget)
      await plur.forget(first.id)
      expect(plur.getById(first.id)!.status).toBe('retired')

      // Cross-scope re-learn should create a NEW engram, not resurrect
      const fresh = plur.learn('phoenix rule', { scope: 'project:b' })
      expect(fresh.id).not.toBe(first.id)
      expect(fresh.recurrence_count).toBe(0)
    })

    it('normalization-equivalent statements (punct/case) match across scopes', () => {
      plur.learn('Always Use Semicolons!', { scope: 'project:a' })
      const second = plur.learn('always use   semicolons', { scope: 'project:b' })
      expect(second.recurrence_count).toBe(1)
    })
  })

  describe('persistence + observability', () => {
    it('persists recurrence_count + broadened scope across Plur instances', () => {
      plur.learn('persisted rule', { scope: 'project:a' })
      plur.learn('persisted rule', { scope: 'project:b' })
      plur.learn('persisted rule', { scope: 'project:c' })

      const fresh = new Plur({ path: dir })
      const found = fresh.list({ scope: 'global' }).find(e => e.statement === 'persisted rule')
      expect(found).toBeDefined()
      expect(found!.recurrence_count).toBe(2)
      expect(found!.commitment).toBe('decided')
    })

    it('emits recurrence_detected history event ONLY when scope or commitment changes (audit iter-1)', () => {
      const first = plur.learn('history-watched rule', { scope: 'project:a' })

      // 1st cross-scope hit: counter increments but no scope/commitment
      // change (threshold is >=2). No history event emitted (would be a
      // no-op spam event). Counter is still visible via the engram field.
      const afterFirstHit = plur.learn('history-watched rule', { scope: 'project:b' })
      expect(afterFirstHit.recurrence_count).toBe(1)
      let events = readHistoryForEngram(plur.getStorageRoot(), first.id)
      expect(events.filter(e => e.event === 'recurrence_detected').length).toBe(0)

      // 2nd cross-scope hit: scope broadens to global + commitment escalates
      // → THIS time a history event fires, with before/after state.
      plur.learn('history-watched rule', { scope: 'project:c' })
      events = readHistoryForEngram(plur.getStorageRoot(), first.id)
      const recurrences = events.filter(e => e.event === 'recurrence_detected')
      expect(recurrences.length).toBe(1)
      expect(recurrences[0].data.from_scope).toBe('project:c')
      expect(recurrences[0].data.previous_scope).toBe('project:a')
      expect(recurrences[0].data.new_scope).toBe('global')
      expect(recurrences[0].data.previous_commitment).toBe('leaning')
      expect(recurrences[0].data.new_commitment).toBe('decided')
      expect(recurrences[0].data.recurrence_count).toBe(2)
    })

    it('does NOT spam history on subsequent recurrences once at global+locked (audit iter-1)', () => {
      // Drive engram to global + locked
      const first = plur.learn('rule', { scope: 'project:a' })
      plur.learn('rule', { scope: 'project:b' })  // recurrence_count=1, no event
      plur.learn('rule', { scope: 'project:c' })  // recurrence_count=2, scope→global commit→decided EVENT
      plur.learn('rule', { scope: 'project:d' })  // recurrence_count=3, commit→locked EVENT

      const eventsAfterLock = readHistoryForEngram(plur.getStorageRoot(), first.id)
        .filter(e => e.event === 'recurrence_detected')
      expect(eventsAfterLock.length).toBe(2)  // events at recurrence=2 and recurrence=3

      // Subsequent learns at new scopes: counter increments, NO events
      // (engram already at global+locked, nothing further to escalate).
      plur.learn('rule', { scope: 'project:e' })
      plur.learn('rule', { scope: 'project:f' })

      const finalEvents = readHistoryForEngram(plur.getStorageRoot(), first.id)
        .filter(e => e.event === 'recurrence_detected')
      expect(finalEvents.length).toBe(2)  // no new spurious events

      // But the counter is still incrementing for telemetry
      const final = plur.list({ scope: 'global' }).find(e => e.statement === 'rule')
      expect(final?.recurrence_count).toBe(5)
    })
  })
})
