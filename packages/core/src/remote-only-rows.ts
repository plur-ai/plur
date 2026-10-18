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
  return !!(e as { structured_data?: { _outbox?: { remote_only?: unknown } } } | null | undefined)
    ?.structured_data?._outbox?.remote_only
}

/** `rows` without the queued remote-only saves. */
export function withoutRemoteOnlyQueued<T extends Engram | Record<string, unknown>>(rows: T[]): T[] {
  return rows.some(isRemoteOnlyQueued) ? rows.filter(r => !isRemoteOnlyQueued(r)) : rows
}
