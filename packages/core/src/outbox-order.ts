/**
 * Ordering for an outbox flush: a supersedes TARGET must be pushed before the
 * engram that supersedes it.
 *
 * The server assigns its own id on push, so a `supersedes` naming a LOCAL id
 * means nothing there. `flushOutbox` builds a local→server map as it goes, and
 * a correction can only use it if its target went first.
 *
 * This needs a topological sort, not `Array.prototype.sort` with a pairwise
 * comparator: a comparator that is non-zero only for directly related pairs is
 * not a strict weak ordering, so a chain (A supersedes B supersedes C) can come
 * out with B before its target C, stalling the flush permanently. Kept pure
 * and exported so it can be tested directly with adversarial input orders.
 */

/**
 * Kahn's algorithm over the pending set, stable, cycles appended not dropped.
 *
 * Nodes are POSITIONS in `pending`, not ids, because a store can hold duplicate
 * ids (hand edits, a sync that kept both sides); keyed by id, a duplicate would
 * collapse to one entry and one copy would vanish from the flush. By position,
 * the output is a permutation of the input whatever the ids. An engram
 * superseding a duplicated id waits for every copy.
 */
export function orderBySupersedes<T extends { id: string }>(
  pending: readonly T[],
  targetsOf: (item: T) => string[],
): T[] {
  const n = pending.length
  /** Positions holding each id (more than one only for a duplicated id). */
  const positions = new Map<string, number[]>()
  pending.forEach((e, i) => {
    const list = positions.get(e.id)
    if (list) list.push(i)
    else positions.set(e.id, [i])
  })
  /** How many of THIS flush's engrams a node must wait for. */
  const waitingOn: number[] = new Array(n).fill(0)
  /** Reverse edges: target position -> positions that supersede it. */
  const dependents: number[][] = Array.from({ length: n }, () => [])

  for (let i = 0; i < n; i++) {
    const e = pending[i]
    // Only edges INSIDE the pending set constrain this flush. A target that is
    // already on the server, or lives only locally, is resolved elsewhere —
    // counting it here would leave every node waiting forever.
    for (const t of new Set(targetsOf(e))) {
      if (t === e.id) continue
      for (const j of positions.get(t) ?? []) {
        waitingOn[i]++
        dependents[j].push(i)
      }
    }
  }

  // Seeded in original order and drained FIFO, so the result is STABLE:
  // engrams with no dependency keep the order the store gave them, and the
  // flush stays predictable for the overwhelmingly common no-edges case.
  const ready: number[] = []
  for (let i = 0; i < n; i++) if (waitingOn[i] === 0) ready.push(i)
  const placed: boolean[] = new Array(n).fill(false)
  const ordered: T[] = []
  for (let k = 0; k < ready.length; k++) {
    const i = ready[k]
    placed[i] = true
    ordered.push(pending[i])
    for (const d of dependents[i]) {
      waitingOn[d]--
      if (waitingOn[d] === 0) ready.push(d)
    }
  }

  // Anything left is in a CYCLE (a mutual supersedes). Append in original
  // order rather than dropping: these engrams must still be attempted so the
  // flush refuses them out loud. An engram that vanishes from the flush is
  // worse than one that fails in it.
  for (let i = 0; i < n; i++) if (!placed[i]) ordered.push(pending[i])
  return ordered
}
