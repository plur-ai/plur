import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
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

    it('emits a recurrence_detected history event with before/after state', () => {
      const first = plur.learn('history-watched rule', { scope: 'project:a' })
      plur.learn('history-watched rule', { scope: 'project:b' })

      const events = readHistoryForEngram(plur.getStorageRoot(), first.id)
      const recurrence = events.find(e => e.event === 'recurrence_detected')
      expect(recurrence).toBeDefined()
      expect(recurrence!.data.from_scope).toBe('project:b')
      expect(recurrence!.data.previous_scope).toBe('project:a')
      expect(recurrence!.data.recurrence_count).toBe(1)
    })

    it('emits history events for each subsequent recurrence', () => {
      const first = plur.learn('multi-recurrence rule', { scope: 'project:a' })
      plur.learn('multi-recurrence rule', { scope: 'project:b' })
      plur.learn('multi-recurrence rule', { scope: 'project:c' })

      const events = readHistoryForEngram(plur.getStorageRoot(), first.id)
      const recurrences = events.filter(e => e.event === 'recurrence_detected')
      expect(recurrences.length).toBe(2)

      // Second recurrence event should show the scope BROADENED transition
      const second = recurrences[1]
      expect(second.data.previous_scope).toBe('project:a')  // before broadening
      expect(second.data.new_scope).toBe('global')           // after broadening
      expect(second.data.previous_commitment).toBe('leaning')
      expect(second.data.new_commitment).toBe('decided')
    })
  })
})
