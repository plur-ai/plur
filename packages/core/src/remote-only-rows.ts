/**
 * The ONE predicate for "a save queued from a remote-only folder" (gate review
 * of #1663, structural change 1). Such a row is the only local copy of that
 * memory, kept only until it is delivered or forgotten, so no sink derives a
 * second local copy from it — whatever folder, if any, the instance is bound
 * to: not the local search index, not the embedder or its cache, not local
 * provenance, not history text.
 */
import type { Engram } from './schemas/engram.js'

export function isRemoteOnlyQueued(e: unknown): boolean {
  // Either marker field counts, so a half-stripped marker still keeps the row
  // out of every sink (well-formed or not).
  const ob = (e as { structured_data?: { _outbox?: { remote_only?: unknown; remote_only_folder?: unknown } } } | null | undefined)
    ?.structured_data?._outbox
  return !!ob && (ob.remote_only === true || ob.remote_only_folder !== undefined)
}

/** `rows` without the queued remote-only saves. */
export function withoutRemoteOnlyQueued<T extends Engram | Record<string, unknown>>(rows: T[]): T[] {
  return rows.some(isRemoteOnlyQueued) ? rows.filter(r => !isRemoteOnlyQueued(r)) : rows
}
