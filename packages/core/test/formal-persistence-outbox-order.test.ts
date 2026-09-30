/**
 * Formal-verification replay + property checks (spec/formal/PlurSpec/Persistence.lean §6,
 * candidate 8): `orderBySupersedes` must return a permutation of its input, place every
 * in-set supersedes target before its dependent, and keep the input order otherwise.
 */
import { describe, it, expect } from 'vitest'
import { orderBySupersedes } from '../src/outbox-order.js'

interface Row { id: string; tag: number; sup: string[] }
const targets = (r: Row) => r.sup

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

describe('formal-persistence: orderBySupersedes', () => {
  it('duplicate ids: nothing vanishes, nothing is doubled', () => {
    const rows: Row[] = [
      { id: 'ENG-A', tag: 1, sup: [] },
      { id: 'ENG-A', tag: 2, sup: [] },
      { id: 'ENG-B', tag: 3, sup: ['ENG-A'] },
    ]
    const out = orderBySupersedes(rows, targets)
    expect(out.map(r => r.tag).sort()).toEqual([1, 2, 3])
    // B waits for every copy of its target.
    expect(out.map(r => r.tag)).toEqual([1, 2, 3])
  })

  it('random DAGs with distinct ids: permutation, targets first, stable', () => {
    const rand = rng(863)
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 9)
      // Edges only from a hidden topological rank to lower ranks ⇒ acyclic.
      const rank = Array.from({ length: n }, (_, i) => i).sort(() => rand() - 0.5)
      const rows: Row[] = Array.from({ length: n }, (_, i) => ({ id: `ENG-${i}`, tag: i, sup: [] as string[] }))
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (rank[j] < rank[i] && rand() < 0.3) rows[i].sup.push(`ENG-${j}`)
      }
      if (rand() < 0.3) rows[0].sup.push('ENG-outside')
      const out = orderBySupersedes(rows, targets)
      expect(out.map(r => r.tag).sort((a, b) => a - b)).toEqual(rows.map(r => r.tag))
      const pos = new Map(out.map((r, k) => [r.id, k]))
      for (const r of rows) for (const t of r.sup) {
        if (pos.has(t)) expect(pos.get(t)!).toBeLessThan(pos.get(r.id)!)
      }
      if (rows.every(r => r.sup.length === 0)) expect(out).toEqual(rows)
    }
  })

  it('cycles are appended in input order, never dropped', () => {
    const rows: Row[] = [
      { id: 'ENG-X', tag: 1, sup: ['ENG-Y'] },
      { id: 'ENG-Y', tag: 2, sup: ['ENG-X'] },
      { id: 'ENG-Z', tag: 3, sup: [] },
    ]
    expect(orderBySupersedes(rows, targets).map(r => r.tag)).toEqual([3, 1, 2])
  })
})
