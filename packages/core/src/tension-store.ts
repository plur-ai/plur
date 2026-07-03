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
import { TensionRecordSchema, type TensionRecord, type TensionCategory } from './schemas/tension.js'
import type { Engram } from './schemas/engram.js'

/** Canonical unordered pair key: sorted ids joined by ':'. */
export function tensionPairKey(idA: string, idB: string): string {
  return [idA, idB].sort().join(':')
}

export function loadTensions(path: string): TensionRecord[] {
  if (!existsSync(path)) return []
  try {
    const raw = yaml.load(readFileSync(path, 'utf8'))
    if (!Array.isArray(raw)) return []
    const records: TensionRecord[] = []
    for (const entry of raw) {
      const parsed = TensionRecordSchema.safeParse(entry)
      if (parsed.success) records.push(parsed.data)
      // Malformed entries are skipped, not fatal — same posture as episodes.
    }
    return records
  } catch {
    return []
  }
}

export function saveTensions(path: string, records: TensionRecord[]): void {
  atomicWrite(path, yaml.dump(records, { lineWidth: 120, noRefs: true }))
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
 * date embedded in canonical ids (ENG-YYYY-MMDD-NNN, ENG-PREFIX-YYYY-MMDD-NNN,
 * server-assigned ENG-YYYY-MM-DD-NNN). Undefined when underivable.
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
