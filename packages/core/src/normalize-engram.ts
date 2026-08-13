/**
 * The ONE place field-compatibility rules live (#877).
 *
 * Three code paths turn stored data into an `Engram` — the YAML primary store
 * (`parseEngramFile`), Postgres/PGLite rows (`parseRow`), and rows reshaped
 * from an enterprise server (`RemoteStore.reshape`) — and each used to
 * normalise independently. Any per-field rule therefore had to be written three
 * times, with nothing enforcing that it was, and a miss is SILENT: Zod fills the
 * schema default and the result is indistinguishable from a real value.
 *
 * That is not hypothetical. `parseRow`'s own history records a row lacking
 * `associations` crashing `recall()`, and #875's `reference_count` → `write_count`
 * rename landed the backfill in the YAML loader only — so on the Postgres tier a
 * legacy row loaded as `write_count: 1` while `reference_count: 5` sat unread
 * under passthrough. `write_count` gates retirement, so a single `forget()`
 * would have retired an engram with five corroborating writes.
 *
 * ## Invariants
 *
 * 1. **Normalise BEFORE parse, never after.** Once Zod has filled a default,
 *    "absent" is unrecoverable — that is exactly the trap above.
 * 2. **Idempotent.** A store already migrated, or written by a newer PLUR, must
 *    be untouched. Every rule guards on the new key being absent.
 * 3. **Never applied to quarantined entries.** A rejected engram is written back
 *    verbatim and must not be silently rewritten on its way to being preserved.
 * 4. **Non-destructive on anything unrecognised.** A non-object is returned as
 *    given; the caller's own guards still apply.
 *
 * To add a migration: append a rule to `RULES`. `normalize-engram.test.ts` runs
 * every rule against every loader, so a fourth backend cannot quietly skip the
 * set.
 */

/** One field-compatibility rule. `apply` receives and returns a plain object. */
export interface NormalizeRule {
  /** Issue that introduced the rule — shows up in test names and failures. */
  readonly id: string
  /** What it does, in one line. */
  readonly description: string
  /** True when the rule still needs to run for this record. */
  applies: (raw: Record<string, unknown>) => boolean
  /** Return a NEW object; never mutate the input. */
  apply: (raw: Record<string, unknown>) => Record<string, unknown>
}

export const RULES: readonly NormalizeRule[] = [
  {
    id: '#866',
    description: 'reference_count → write_count (renamed in #866)',
    // Guarded on write_count being ABSENT, so a record already carrying the new
    // name keeps its value even if a stale reference_count rides alongside it.
    applies: raw => !('write_count' in raw) && 'reference_count' in raw,
    apply: ({ reference_count, ...rest }) => ({ ...rest, write_count: reference_count }),
  },
]

/**
 * Apply every field-compatibility rule to one stored record.
 *
 * Returns the input unchanged (same reference) when nothing applies, so the
 * common path — a current-format store — allocates nothing.
 */
export function normalizeEngramInput(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  let out = raw as Record<string, unknown>
  let touched = false
  for (const rule of RULES) {
    if (!rule.applies(out)) continue
    out = rule.apply(out)
    touched = true
  }
  return touched ? out : raw
}
