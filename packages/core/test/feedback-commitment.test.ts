/**
 * #905 — the schema and `nextCommitment`'s prose must agree.
 *
 * The docstring claimed deployments could extend the commitment enum with
 * `'draft'` via the schema's `passthrough()`. That mechanism cannot work:
 * `passthrough()` preserves undeclared *keys*, not out-of-enum *values* for a
 * declared key. So the prose and the schema genuinely disagreed.
 *
 * #908 resolved the disagreement in the direction the issue asked for — by
 * widening the enum to include `'draft'` — rather than by deleting the claim.
 * `commitment` is therefore now a closed enum of FIVE values, and the prose is
 * true. Core stores and recalls a `draft` engram like any other; withholding it
 * is left to deployments that implement a review queue.
 *
 * These tests pin BOTH sides so they cannot drift apart again. The schema side
 * matters specifically: #908's widening is otherwise enforced only at compile
 * time, through `typecheck:tests`. That is a strong guarantee while that job
 * runs, but it lives outside the test job — so a runtime assertion is what
 * keeps the enum honest if the typecheck job is ever made optional.
 */
import { describe, it, expect } from 'vitest'
import { nextCommitment } from '../src/feedback.js'
import { EngramSchema } from '../src/schemas/engram.js'

const CANONICAL = ['exploring', 'leaning', 'decided', 'locked', 'draft'] as const

describe('commitment: schema and nextCommitment agree (#905)', () => {
  it('the schema ACCEPTS the value the docstring advertises (#908)', () => {
    const parsed = EngramSchema.shape.commitment.safeParse('draft')
    expect(parsed.success, "'draft' is rejected — then #908's widening has been reverted")
      .toBe(true)
  })

  it('accepts exactly the five canonical values, and nothing else', () => {
    for (const v of CANONICAL) {
      expect(EngramSchema.shape.commitment.safeParse(v).success, v).toBe(true)
    }
    // Closed, not open: without this the test above passes against a plain
    // z.string() and would stop describing an enum at all.
    for (const v of ['archived', 'lokced', 'DRAFT', '']) {
      expect(EngramSchema.shape.commitment.safeParse(v).success, v).toBe(false)
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
    //
    // `draft` is deliberately NOT in this list any more: since #908 it is a
    // known value, and the reason it does not advance is a review-queue
    // guarantee rather than defensive ignorance. That case is pinned in
    // feedback.test.ts ('does not promote a review-queue draft out of review').
    for (const v of ['archived', 'lokced']) {
      expect(nextCommitment(v), `${v} was advanced`).toBe(v)
    }
  })
})
