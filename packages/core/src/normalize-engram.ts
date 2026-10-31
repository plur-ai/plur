/**
 * The one place field-compatibility rules live.
 *
 * Three code paths turn stored data into an `Engram` — the YAML primary store
 * (`parseEngramFile`), Postgres/PGLite rows (`parseRow`), and rows reshaped
 * from an enterprise server (`RemoteStore.reshape`). A per-field rule missed by
 * one of them fails silently: Zod fills the schema default and the result is
 * indistinguishable from a real value. For example, a legacy row carrying only
 * `reference_count` would load as `write_count: 1`, and since `write_count`
 * gates retirement, one `forget()` could retire a well-corroborated engram.
 *
 * ## Invariants
 *
 * 1. **Normalise BEFORE parse, never after.** Once Zod has filled a default,
 *    "absent" is unrecoverable.
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
  /** Stable rule identifier — shows up in test names and failures. */
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
