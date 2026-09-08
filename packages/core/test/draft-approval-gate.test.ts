/**
 * A draft engram is not injected — #1141.
 *
 * `commitment: 'draft'` means the engram is sitting in a review queue. Core
 * stored and recalled it normally and the selector never looked at the field,
 * so an unapproved rule was eligible for injection like any other and could
 * shape an agent's behaviour before a human had agreed to it. The schema left
 * enforcement "to deployments", which means the guarantee held only where
 * someone had remembered to reimplement it.
 *
 * Decided 2026-09-07: while an engram is a draft it is not part of shared
 * memory and is not injected into prompts. Enforced in core.
 *
 * Retrieval is deliberately NOT gated. Reviewing something requires being able
 * to read it; what is closed is the automatic path into an agent's context.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'
import { Plur } from '../src/index.js'

const make = (o: Record<string, unknown> = {}) => EngramSchema.parse({
  id: 'ENG-2026-1141-001',
  statement: 'Always deploy using blue-green strategy',
  type: 'behavioral',
  scope: 'global',
  status: 'active',
  ...o,
})

const idsFrom = (r: { directives: Array<{ id: string }>; constraints: Array<{ id: string }>; consider: Array<{ id: string }> }) =>
  [...r.directives, ...r.constraints, ...r.consider].map(e => e.id)

describe('draft approval gate (#1141)', () => {
  it('does not inject a draft engram', () => {
    const r = selectAndSpread({ prompt: 'deploy the app', maxTokens: 5000 }, [
      make({ id: 'ENG-2026-1141-001', commitment: 'draft' }),
      make({ id: 'ENG-2026-1141-002', statement: 'Always run the deploy smoke test', commitment: 'decided' }),
    ], [])
    expect(idsFrom(r)).not.toContain('ENG-2026-1141-001')
    expect(idsFrom(r)).toContain('ENG-2026-1141-002')
  })

  it('does not inject a draft that arrives inside a pack', () => {
    // Packs are third-party content — an unreviewed rule shipped by someone
    // else is exactly the case the gate exists for.
    const r = selectAndSpread({ prompt: 'deploy the app', maxTokens: 5000 }, [], [{
      manifest: { name: 'p', version: '1.0.0', metadata: { injection_policy: 'always', match_terms: [] } } as never,
      engrams: [make({ id: 'ENG-2026-1141-003', commitment: 'draft' })],
    } as never])
    expect(idsFrom(r)).not.toContain('ENG-2026-1141-003')
  })

  it('cannot be reached through spreading activation either', () => {
    // The gate runs before the engram enters the association map, so a draft
    // is not a reachable target from an approved neighbour.
    const approved = make({
      id: 'ENG-2026-1141-004',
      statement: 'Always deploy using blue-green strategy',
      associations: [{ target: 'ENG-2026-1141-005', target_type: 'engram', type: 'semantic', strength: 0.9 }],
    })
    const draft = make({ id: 'ENG-2026-1141-005', statement: 'Skip the canary step', commitment: 'draft' })
    const r = selectAndSpread({ prompt: 'deploy the app', maxTokens: 5000 }, [approved, draft], [])
    expect(idsFrom(r)).not.toContain('ENG-2026-1141-005')
  })

  it('injects once the draft is approved', () => {
    const before = selectAndSpread({ prompt: 'deploy the app', maxTokens: 5000 },
      [make({ id: 'ENG-2026-1141-006', commitment: 'draft' })], [])
    expect(idsFrom(before)).not.toContain('ENG-2026-1141-006')

    const after = selectAndSpread({ prompt: 'deploy the app', maxTokens: 5000 },
      [make({ id: 'ENG-2026-1141-006', commitment: 'decided' })], [])
    expect(idsFrom(after)).toContain('ENG-2026-1141-006')
  })

  it('leaves engrams with no commitment untouched', () => {
    // Most of a real store carries no commitment at all. The gate must close
    // on `draft` specifically, not on "not explicitly approved".
    const r = selectAndSpread({ prompt: 'deploy the app', maxTokens: 5000 },
      [make({ id: 'ENG-2026-1141-007' })], [])
    expect(idsFrom(r)).toContain('ENG-2026-1141-007')
  })

  describe('review remains possible', () => {
    const dirs: string[] = []
    afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
    const freshPlur = () => {
      const dir = mkdtempSync(join(tmpdir(), 'plur-draftgate-'))
      dirs.push(dir)
      return new Plur({ path: dir })
    }

    it('still returns a draft from an explicit recall', async () => {
      // Gating retrieval would make the review queue unreadable, which defeats
      // the purpose: you cannot approve what you cannot see.
      const plur = freshPlur()
      await plur.learn('Always deploy using blue-green strategy', { scope: 'global', commitment: 'draft' } as never)
      const hits = await plur.recall('blue-green deploy strategy') as Array<{ statement: string }>
      expect(hits.some(h => h.statement.includes('blue-green'))).toBe(true)
    })

    it('feedback does not approve a draft', async () => {
      // Positive feedback is a relevance signal, never an approval. If it
      // promoted commitment it would be a bypass around the human gate.
      const plur = freshPlur()
      const e = await plur.learn('Always deploy using blue-green strategy', { scope: 'global', commitment: 'draft' } as never) as { id: string }
      await plur.feedback(e.id, 'positive')
      await plur.feedback(e.id, 'positive')
      const after = await plur.getById(e.id)
      expect((after as { commitment?: string } | null)?.commitment).toBe('draft')
    })
  })
})
