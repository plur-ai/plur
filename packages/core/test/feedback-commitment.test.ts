/**
 * #905 — the schema and `nextCommitment`'s prose must agree.
 *
 * The docstring claimed deployments could extend the commitment enum with
 * `'draft'` and pointed at "the extension note in `schemas/engram.ts`". No such
 * note existed, and no such extension: `commitment` is a closed enum, so an
 * engram carrying `'draft'` never reaches `nextCommitment` — it fails
 * validation and is quarantined at load.
 *
 * These tests pin BOTH sides, so the two cannot drift apart again: the schema
 * really does reject the value the prose claimed, and the defensive branch
 * really does leave unknown values alone for the cases that can still reach it.
 */
import { describe, it, expect } from 'vitest'
import { nextCommitment } from '../src/feedback.js'
import { EngramSchema } from '../src/schemas/engram.js'

describe('commitment: schema and nextCommitment agree (#905)', () => {
  it('the schema REJECTS the value the docstring used to advertise', () => {
    const parsed = EngramSchema.shape.commitment.safeParse('draft')
    expect(parsed.success, "'draft' parses — then the docstring was right and this test is the bug")
      .toBe(false)
  })

  it('accepts exactly the four canonical values', () => {
    for (const v of ['exploring', 'leaning', 'decided', 'locked']) {
      expect(EngramSchema.shape.commitment.safeParse(v).success, v).toBe(true)
    }
  })

  it('advances the canonical ladder', () => {
    expect(nextCommitment(undefined)).toBe('leaning')
    expect(nextCommitment('exploring')).toBe('leaning')
    expect(nextCommitment('leaning')).toBe('decided')
    expect(nextCommitment('decided')).toBe('decided')
    expect(nextCommitment('locked')).toBe('locked')
  })

  it('leaves an unknown value untouched rather than advancing it', () => {
    // Unreachable through the normal load path, but reachable from a store
    // written by a newer version, a hand-edited file, or an engram constructed
    // without parsing. Advancing a state this function does not understand
    // would silently rewrite somebody else's semantics.
    for (const v of ['draft', 'archived', 'lokced']) {
      expect(nextCommitment(v), `${v} was advanced`).toBe(v)
    }
  })
})
