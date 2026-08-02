/**
 * Tension persistence (#181) — load/save tension records and the pure
 * helpers around them (pair keys, ids, categorization).
 *
 * Storage mirrors episodes.ts: a YAML array in `tensions.yaml` at the store
 * root, written atomically. Mutations go through the Plur class, which holds
 * the file lock; this module stays pure I/O + helpers.
 */
import { existsSync, readFileSync } from 'fs'
import yaml from 'js-yaml'
import { atomicWrite } from './sync.js'
import { parseRecordArrayFile } from './engrams.js'
import { TensionRecordSchema, type TensionRecord, type TensionCategory } from './schemas/tension.js'
import type { Engram } from './schemas/engram.js'

/** Canonical unordered pair key: sorted ids joined by ':'. */
export function tensionPairKey(idA: string, idB: string): string {
  return [idA, idB].sort().join(':')
}

/**
 * Read tension records, or throw when the file is unreadable.
 *
 * Both halves of the engram-store defect lived here too (#794 F1/F2, still
 * live after the first remediation and re-found by the #811 audit): a corrupt
 * or wrongly-shaped file returned `[]`, and schema-invalid entries were
 * silently skipped. Since `saveTensions` rewrites the whole array, the next
 * `recordTensions` persisted only the survivors — a silent permanent delete.
 */
export function loadTensionsWithQuarantine(path: string): { valid: TensionRecord[]; quarantined: unknown[] } {
  return parseRecordArrayFile<TensionRecord>(path, entry => {
    const parsed = TensionRecordSchema.safeParse(entry)
    return parsed.success ? parsed.data : null
  })
}

export function loadTensions(path: string): TensionRecord[] {
  return loadTensionsWithQuarantine(path).valid
}

/**
 * Write the tension list.
 *
 * `quarantined` is the set withheld by {@link loadTensionsWithQuarantine};
 * passing it back is what stops a malformed record being deleted by an
 * unrelated write. Callers that loaded through the quarantine helper should
 * always hand it back.
 */
export function saveTensions(path: string, records: TensionRecord[], quarantined: unknown[] = []): void {
  const out = quarantined.length > 0 ? [...records, ...(quarantined as TensionRecord[])] : records
  atomicWrite(path, yaml.dump(out, { lineWidth: 120, noRefs: true }))
}

/**
 * Next tension id for `now`: T-YYYY-MMDD-NNN, NNN numbered per detection day
 * across the existing records.
 */
export function generateTensionId(existing: TensionRecord[], now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 10)
  const day = iso.replace(/-/g, '').slice(0, 8) // YYYYMMDD
  const prefix = `T-${day.slice(0, 4)}-${day.slice(4, 8)}-`
  let max = 0
  for (const r of existing) {
    if (!r.id.startsWith(prefix)) continue
    const n = parseInt(r.id.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

/** Explicit correction marker — "use 9 agents (not 5)". */
const SUPERSEDED_PATTERN = /\(\s*not\s+[^)]+\)/i

/**
 * Recorded date of an engram: `temporal.learned_at`, falling back to the
 * date embedded in the id — canonical ENG-YYYY-MM-DD-NNN (also what servers
 * assign, #771), legacy compact ENG-YYYY-MMDD-NNN, and either form behind a
 * store prefix (ENG-{PREFIX}-...). Undefined when underivable.
 */
function recordedDate(e: Engram): string | undefined {
  const learned = e.temporal?.learned_at
  if (learned && /^\d{4}-\d{2}-\d{2}/.test(learned)) return learned.slice(0, 10)
  const m = e.id.match(/(\d{4})-(\d{2})-?(\d{2})(?=-|$)/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return undefined
}

/**
 * v1 deterministic category heuristic (#181). See TensionCategorySchema for
 * the contract; advisory only — resolution never branches on category.
 */
export function categorizeTension(
  statementA: string,
  statementB: string,
  engramA?: Engram,
  engramB?: Engram,
): TensionCategory {
  if (SUPERSEDED_PATTERN.test(statementA) || SUPERSEDED_PATTERN.test(statementB)) {
    return 'superseded'
  }
  if (engramA && engramB) {
    const dateA = recordedDate(engramA)
    const dateB = recordedDate(engramB)
    if (dateA && dateB && dateA !== dateB) return 'temporal'
  }
  return 'factual'
}
