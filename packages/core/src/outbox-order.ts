/**
 * Ordering for an outbox flush: a supersedes TARGET must be pushed before the
 * engram that supersedes it (#863).
 *
 * The server assigns its own id on push, so a `supersedes` naming a LOCAL id
 * means nothing there. `flushOutbox` builds a local→server map as it goes, and
 * a correction can only use it if its target went first.
 *
 * ## Why this is a module and not four lines inside the flush
 *
 * It was four lines inside the flush, and they were:
 *
 *     pending.sort((a, b) => aDependsOnB - bDependsOnA)
 *
 * which returns non-zero only for DIRECTLY related pairs. That is not a strict
 * weak ordering, so `Array.prototype.sort` may produce anything for a chain: A
 * supersedes B supersedes C gives cmp(A,B)=1, cmp(B,C)=1, cmp(A,C)=0, and V8's
 * insertion sort turns `[A,B,C]` into `[B,A,C]` — B pushed before C, its target.
 * The 2026-08-13 panel measured the consequence as a PERMANENT stall.
 *
 * The bug is a property of the algorithm, not of any store state, so it belongs
 * where it can be tested as one: exported, pure, and exercised directly with
 * adversarial input orders. Every earlier fixture used exactly two pending
 * engrams, where a comparator and a topological sort agree.
 */

/** Kahn's algorithm over the pending set, stable, cycles appended not dropped. */
export function orderBySupersedes<T extends { id: string }>(
  pending: readonly T[],
  targetsOf: (item: T) => string[],
): T[] {
  const pendingIds = new Set(pending.map(e => e.id))
  const byId = new Map(pending.map(e => [e.id, e]))
  /** How many of THIS flush's engrams a node must wait for. */
  const waitingOn = new Map<string, number>()
  /** Reverse edges: target id -> ids that supersede it. */
  const dependents = new Map<string, string[]>()

  for (const e of pending) {
    // Only edges INSIDE the pending set constrain this flush. A target that is
    // already on the server, or lives only locally, is resolved elsewhere —
    // counting it here would leave every node waiting forever.
    const deps = targetsOf(e).filter(t => pendingIds.has(t) && t !== e.id)
    waitingOn.set(e.id, deps.length)
    for (const t of deps) {
      const list = dependents.get(t)
      if (list) list.push(e.id)
      else dependents.set(t, [e.id])
    }
  }

  // Seeded in original order and drained FIFO, so the result is STABLE:
  // engrams with no dependency keep the order the store gave them, and the
  // flush stays predictable for the overwhelmingly common no-edges case.
  const ready = pending.filter(e => waitingOn.get(e.id) === 0).map(e => e.id)
  const ordered: T[] = []
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]
    ordered.push(byId.get(id)!)
    for (const dep of dependents.get(id) ?? []) {
      const left = (waitingOn.get(dep) ?? 0) - 1
      waitingOn.set(dep, left)
      if (left === 0) ready.push(dep)
    }
  }

  // Anything left is in a CYCLE — a mutual supersedes, which the comparator
  // deadlocked on silently. Append in original order rather than dropping:
  // these engrams must still be attempted, so the flush refuses them out loud
  // and reports it. An engram that vanishes from the flush is worse than one
  // that fails in it.
  if (ordered.length < pending.length) {
    const placed = new Set(ordered.map(e => e.id))
    for (const e of pending) if (!placed.has(e.id)) ordered.push(e)
  }
  return ordered
}
