/**
 * The one place field-compatibility rules live, applied by every loader (YAML
 * `parseEngramFile`, Postgres/PGLite `parseRow`, `RemoteStore.reshape`) — a missed rule
 * fails silently once Zod fills a default.
 * 1. Normalise BEFORE parse, never after ("absent" is unrecoverable afterwards).
 * 2. Idempotent: every rule guards on the new key being absent.
 * 3. Never applied to quarantined entries (written back verbatim).
 * 4. Non-objects are returned as given.
 * To add a migration, append to `RULES`; normalize-engram.test.ts runs every rule on every loader.
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
    description: 'reference_count → write_count',
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
