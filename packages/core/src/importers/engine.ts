/**
 * Import engine (issue #441) — routes normalized ImportRecords through
 * `plur.learn()` so every existing write gate applies:
 *
 *   - content-hash fast-path dedup (same scope → reference_count bump),
 *   - cross-scope recurrence (same statement, different scope → graduation),
 *   - secret detection and the sensitive-scope guard.
 *
 * Imports NEVER raw-append to the store. A record whose learn() resolves to a
 * pre-existing (or earlier-in-this-run) engram is reported as skipped.
 *
 * Conflicts are detected with the same non-LLM heuristic pre-filter the
 * tension scan uses (scope partition → domain overlap → subject overlap,
 * tensions.ts). Conflicted records are still imported — dropping data on a
 * heuristic would be worse — but they are counted in the report, and the new
 * engram's relations.conflicts links the suspects so `plur tensions --scan`
 * can confirm with an LLM later. Conflicts are evaluated against the engrams
 * that existed before the run, not between records of the same import.
 *
 * Temporal metadata is preserved where the source has it: created_at becomes
 * temporal.learned_at (with ingested_at stamped to import time), last_accessed
 * becomes activation.last_accessed. Dedup-skipped records never overwrite the
 * existing engram's temporal data.
 */
import type { Plur } from '../index.js'
import type { Engram } from '../schemas/engram.js'
import type { LearnContext } from '../types.js'
import { computeContentHash } from '../content-hash.js'
import { detectSecrets } from '../secrets.js'
import { scopesOverlap, domainSegmentsOverlap, subjectsOverlap } from '../tensions.js'
import type { ImportRecord, ImportRecordResult, MigrationReport } from './types.js'

export interface RunImportOptions {
  /** Source name for the report (generic | gp-engram | mem0 | ...). */
  from: string
  /** Input file path, echoed into the report. */
  path?: string
  /** Analyze and report without writing. */
  dryRun?: boolean
  /** Force every record into this scope (overrides record-level scopes). */
  scope?: string
  /** Source label for records that carry none (e.g. `import:mem0:memories.json`). */
  defaultSource?: string
}

/** Max conflict links recorded per imported record. */
const CONFLICT_CAP = 5

export function runImport(plur: Plur, records: ImportRecord[], opts: RunImportOptions): MigrationReport {
  const dryRun = opts.dryRun === true
  const now = new Date().toISOString()

  // Pre-existing view: dedup identity + conflict candidates. include_expired
  // for parity with learn()'s content-hash gate, which ignores temporal
  // validity — a plain list() would drop already-expired engrams and make the
  // engine misreport their duplicates as fresh imports (re-patching temporal
  // metadata on the existing engram along the way).
  const preExisting = plur.list({ include_expired: true })
  const knownIds = new Set(preExisting.map(e => e.id))
  const hashToId = new Map<string, string>()
  for (const e of preExisting) {
    const hash = (e as any).content_hash ?? computeContentHash(e.statement)
    if (!hashToId.has(hash)) hashToId.set(hash, e.id)
  }
  const allowSecrets = plur.status().config?.allow_secrets === true

  const results: ImportRecordResult[] = []
  let imported = 0
  let skipped = 0
  let conflicts = 0
  let errors = 0

  for (const record of records) {
    const statement = (record.statement ?? '').trim()
    if (!statement) {
      errors++
      results.push({ statement: record.statement ?? '', action: 'error', error: 'empty statement' })
      continue
    }
    const scope = opts.scope ?? record.scope

    if (dryRun) {
      // Mirror the learn() gates without writing.
      if (!allowSecrets) {
        const secretText = [statement, record.domain, ...(record.tags ?? [])].filter(Boolean).join(' ')
        const secrets = detectSecrets(secretText)
        if (secrets.length > 0) {
          errors++
          results.push({ statement, action: 'error', error: `Secret detected in statement/domain/tags: ${secrets[0].pattern}` })
          continue
        }
      }
      const hash = computeContentHash(statement)
      if (hashToId.has(hash)) {
        skipped++
        results.push({ statement, action: 'skipped', id: hashToId.get(hash) })
        continue
      }
      hashToId.set(hash, '') // in-file duplicates dedup against each other too
      const conflictIds = findConflicts(statement, scope, record.domain, preExisting)
      imported++
      if (conflictIds.length > 0) conflicts++
      results.push({ statement, action: 'imported', ...(conflictIds.length > 0 ? { conflicts: conflictIds } : {}) })
      continue
    }

    try {
      const context: LearnContext = {
        source: record.source ?? opts.defaultSource ?? `import:${opts.from}`,
      }
      if (record.type) context.type = record.type
      if (scope) context.scope = scope
      if (record.domain) context.domain = record.domain
      if (record.tags && record.tags.length > 0) context.tags = record.tags
      if (record.valid_from) context.valid_from = record.valid_from.slice(0, 10)
      if (record.valid_until) context.valid_until = record.valid_until.slice(0, 10)
      if (record.pinned) context.pinned = true

      const engram = plur.learn(statement, context)

      if (knownIds.has(engram.id)) {
        // learn() resolved to an existing engram (hash dedup or cross-scope
        // recurrence) — the dedup gate did its job.
        skipped++
        results.push({ statement, action: 'skipped', id: engram.id })
        continue
      }
      knownIds.add(engram.id)

      const conflictIds = findConflicts(statement, scope, record.domain, preExisting)
      const patched = applyImportMetadata(engram, record, conflictIds, now)
      if (patched) plur.updateEngram(patched)

      imported++
      if (conflictIds.length > 0) conflicts++
      results.push({ statement, action: 'imported', id: engram.id, ...(conflictIds.length > 0 ? { conflicts: conflictIds } : {}) })
    } catch (err) {
      errors++
      results.push({ statement, action: 'error', error: (err as Error).message })
    }
  }

  return {
    from: opts.from,
    ...(opts.path ? { path: opts.path } : {}),
    dry_run: dryRun,
    total: records.length,
    imported,
    skipped,
    conflicts,
    errors,
    records: results,
  }
}

/**
 * Heuristic conflict candidates: the tension scan's non-LLM pre-filter
 * (tensions.ts getCandidatePairs stages) applied between one incoming record
 * and the pre-existing active engrams.
 */
function findConflicts(statement: string, scope: string | undefined, domain: string | undefined, existing: Engram[]): string[] {
  const effScope = scope ?? 'global'
  const out: string[] = []
  for (const e of existing) {
    if (e.status !== 'active') continue
    if (!scopesOverlap(e.scope, effScope)) continue
    if (!domainSegmentsOverlap(e.domain, domain)) continue
    if (!subjectsOverlap(e.statement, statement)) continue
    out.push(e.id)
    if (out.length >= CONFLICT_CAP) break
  }
  return out
}

/**
 * Post-learn metadata the LearnContext cannot express: source-preserved
 * temporal anchors, confidence, and heuristic conflict links. Returns the
 * patched engram, or null when the record adds nothing.
 */
function applyImportMetadata(engram: Engram, record: ImportRecord, conflictIds: string[], now: string): Engram | null {
  let changed = false
  const out: Engram = { ...engram }

  if (record.created_at || record.last_accessed) {
    out.temporal = {
      learned_at: record.created_at ?? engram.temporal?.learned_at ?? now,
      ...(engram.temporal?.valid_from ? { valid_from: engram.temporal.valid_from } : {}),
      ...(engram.temporal?.valid_until ? { valid_until: engram.temporal.valid_until } : {}),
      ingested_at: now,
    }
    const lastAccessed = record.last_accessed ?? record.created_at ?? now
    out.activation = { ...engram.activation, last_accessed: lastAccessed.slice(0, 10) }
    changed = true
  }

  if (record.confidence !== undefined) {
    const conf = Math.min(10, Math.max(1, Math.round(1 + record.confidence * 9)))
    out.episodic = {
      emotional_weight: engram.episodic?.emotional_weight ?? 5,
      confidence: conf,
      ...(engram.episodic?.trigger_context ? { trigger_context: engram.episodic.trigger_context } : {}),
      ...(engram.episodic?.journal_ref ? { journal_ref: engram.episodic.journal_ref } : {}),
    }
    changed = true
  }

  if (conflictIds.length > 0) {
    out.relations = {
      broader: engram.relations?.broader ?? [],
      narrower: engram.relations?.narrower ?? [],
      related: engram.relations?.related ?? [],
      conflicts: [...new Set([...(engram.relations?.conflicts ?? []), ...conflictIds])],
    }
    changed = true
  }

  return changed ? out : null
}
