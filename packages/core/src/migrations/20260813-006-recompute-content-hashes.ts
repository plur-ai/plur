import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'
import { computeContentHash, isHashable } from '../content-hash.js'

/**
 * Recompute `content_hash` under the Unicode-aware normalizer (v2, #896).
 *
 * ## Why a migration when `plur reindex-hashes` already exists
 *
 * #896 was fixed forward — `normalizeStatement` now preserves non-Latin
 * letters, so newly written hashes are correct. Hashes already ON DISK were
 * written under v1 and are stale for any statement containing a character the
 * old ASCII `\w` stripped. `Plur.repairContentHashes` (the CLI's
 * `plur reindex-hashes`) repairs them, but only when a user knows to run it.
 *
 * #911 tracked the discoverability gap and is closed: the 0.18.0 changelog
 * names the affected population and the command (its option A), and `plur
 * doctor` counts stale hashes and prints the remedy (#919, its option B).
 * What #911's options did not include is folding the repair into `plur
 * migrate` — the step an upgrading user runs anyway — which is what this
 * migration adds. Note this is NOT #911's rejected option C (rewrite on
 * first load): `plur migrate` is an explicit write command that runs under
 * the corpus lock with a backup and rollback, not a write smuggled into a
 * read path.
 *
 * ## It must agree with `repairContentHashes`, not merely resemble it
 *
 * The two now run over the same corpus from different entry points, so any
 * divergence means the store's hashes depend on which one the user happened to
 * trigger — worse than having only one of them. The three rules below are
 * lifted from that method deliberately; change them together or not at all.
 *
 * 1. **Skip statement-less rows.** Nothing to hash.
 *
 * 2. **Skip unhashable statements** — those that normalize away entirely
 *    (all punctuation, all emoji). Hashing them stamps SHA-256 of the empty
 *    string onto every one, which is precisely the #896 collapse mechanism:
 *    they share a hash and dedup absorbs them into a single engram. #900 added
 *    this guard to the repair path after measuring 961 such rows. A migration
 *    that skipped it would re-inflict the bug it exists to repair, on the rows
 *    least able to survive it.
 *
 *    Any SHA-256("") value migration 002 already stamped on such a row is left
 *    in place rather than cleared — matching `repairContentHashes`, and inert
 *    because every matcher (`_hashDedup`, the cross-scope recurrence path,
 *    `learn`'s primary-delegate check) refuses to match an unhashable
 *    statement before it ever compares hashes.
 *
 * 3. **Only rewrite when the value actually changes.** An ASCII statement's v2
 *    hash is byte-identical to its v1 hash, which is the overwhelming majority
 *    of any real store. Rewriting them all would touch every row to change
 *    nothing.
 *
 * ## down()
 *
 * A no-op, deliberately. The v1 hashes were wrong; restoring them would
 * reintroduce #896. There is also no way back — v1's output is not recoverable
 * from v2's, so "restore" could only mean "recompute under the buggy
 * normalizer", which is the bug rather than a rollback.
 */
export const migration: Migration = {
  id: '20260813-006-recompute-content-hashes',
  description: 'Recompute content_hash with the Unicode-aware normalizer (#896, #911)',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      if (!e.statement || !isHashable(e.statement)) return e
      const correct = computeContentHash(e.statement)
      if ((e as { content_hash?: string }).content_hash === correct) return e
      return { ...e, content_hash: correct } as Engram
    })
  },
  down(engrams: Engram[]): Engram[] {
    return engrams
  },
}
