/**
 * The outbox flush order is a topological sort, and this is where that is
 * proved (#863 follow-up).
 *
 * The shipped version was `pending.sort((a, b) => aDependsOnB - bDependsOnA)`.
 * That comparator returns non-zero only for DIRECTLY related pairs, so it is
 * not a strict weak ordering and `Array.prototype.sort` may produce any result
 * for a chain. Every fixture #863 shipped used exactly two pending engrams —
 * the one size at which a comparator and a topological sort cannot disagree.
 *
 * These tests use the input orders that make them disagree, and assert the
 * INVARIANT ("no engram is placed before something it supersedes") rather than
 * one expected permutation, so a different-but-valid order does not fail.
 */
import { describe, it, expect } from 'vitest'
import { orderBySupersedes } from '../src/outbox-order.js'

type Node = { id: string; supersedes?: string[] }
const targetsOf = (n: Node) => n.supersedes ?? []
const order = (nodes: Node[]) => orderBySupersedes(nodes, targetsOf).map(n => n.id)

/** No node may appear before a node it supersedes, when both are present. */
function assertTopological(nodes: Node[], result: string[]) {
  const pos = new Map(result.map((id, i) => [id, i]))
  for (const n of nodes) {
    for (const t of targetsOf(n)) {
      if (!pos.has(t)) continue
      expect(pos.get(t)!, `${n.id} was pushed before its target ${t}`).toBeLessThan(pos.get(n.id)!)
    }
  }
}

describe('orderBySupersedes', () => {
  it('orders a three-deep chain given in exactly the wrong order', () => {
    // A→B→C presented as [A, B, C]. The old comparator produced [B, A, C] —
    // B before its own target C — under V8's insertion sort.
    const nodes: Node[] = [
      { id: 'A', supersedes: ['B'] },
      { id: 'B', supersedes: ['C'] },
      { id: 'C' },
    ]
    const result = order(nodes)
    expect(result).toEqual(['C', 'B', 'A'])
    assertTopological(nodes, result)
  })

  it('handles the panel-measured shape: correction, filler, target', () => {
    // The exact input the 2026-08-13 panel used to produce a permanent stall.
    const nodes: Node[] = [
      { id: 'correction', supersedes: ['target'] },
      { id: 'filler' },
      { id: 'target' },
    ]
    const result = order(nodes)
    assertTopological(nodes, result)
    expect(result).toHaveLength(3)
  })

  it('survives a deep chain in reverse, where any comparator is hopeless', () => {
    const n = 12
    const nodes: Node[] = Array.from({ length: n }, (_, i) => ({
      id: `E${i}`,
      ...(i < n - 1 ? { supersedes: [`E${i + 1}`] } : {}),
    }))
    const result = order(nodes)
    expect(result).toEqual(Array.from({ length: n }, (_, i) => `E${n - 1 - i}`))
    assertTopological(nodes, result)
  })

  it('is stable for the common case of no edges at all', () => {
    // The overwhelmingly common flush. Reordering it would make the push order
    // — and therefore the server ids — depend on an implementation detail.
    const nodes: Node[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]
    expect(order(nodes)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('keeps every engram when there is a cycle, rather than dropping one', () => {
    // A mutual supersedes has no valid order. The old comparator returned 0
    // for the pair and left them in place with no signal; dropping them would
    // be worse still, because a flush that silently omits an engram reports
    // success for work it did not do.
    const nodes: Node[] = [
      { id: 'X', supersedes: ['Y'] },
      { id: 'Y', supersedes: ['X'] },
      { id: 'Z' },
    ]
    const result = order(nodes)
    expect(result.sort()).toEqual(['X', 'Y', 'Z'])
  })

  it('ignores targets outside the pending set', () => {
    // A target already on the server, or one that lives only locally, is
    // resolved elsewhere. Counting it as a dependency would leave the node
    // waiting on something this flush can never deliver — every engram would
    // land in the cycle bucket.
    const nodes: Node[] = [
      { id: 'A', supersedes: ['ALREADY-PUSHED'] },
      { id: 'B' },
    ]
    expect(order(nodes)).toEqual(['A', 'B'])
  })

  it('ignores a self-edge instead of deadlocking on it', () => {
    const nodes: Node[] = [{ id: 'A', supersedes: ['A'] }, { id: 'B' }]
    expect(order(nodes)).toEqual(['A', 'B'])
  })

  it('orders a diamond: two corrections of one target', () => {
    const nodes: Node[] = [
      { id: 'top', supersedes: ['left', 'right'] },
      { id: 'left', supersedes: ['base'] },
      { id: 'right', supersedes: ['base'] },
      { id: 'base' },
    ]
    const result = order(nodes)
    assertTopological(nodes, result)
    expect(result[0]).toBe('base')
    expect(result[3]).toBe('top')
  })
})
