/**
 * Import engine (issue #441) — routes normalized ImportRecords through
 * `plur.learn()` so every existing write gate applies (secret detection, the
 * sensitive-scope guard, routing).
 *
 * Re-running an import changes nothing (Decision R, owner 2026-09-27). A record
 * that learn() would resolve to an existing engram — same-scope content-hash
 * dedup or cross-scope recurrence, asked with `plur.wouldDeduplicate` (learn()'s
 * own dedup code) BEFORE learn() is called — is reported as skipped and the
 * existing engram is left completely untouched: no write_count bump, no sources
 * append, no recurrence, no graduation. A re-import is a retry, not new evidence.
 *
 * Imports NEVER raw-append to the store.
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
import { computeContentHash, isHashable } from '../content-hash.js'
import { detectSecrets } from '../secrets.js'
import { learnContextContent } from '../content-fields.js'
import { scopesOverlap, domainSegmentsOverlap, subjectsOverlap } from '../tensions.js'
import { isSharedScope } from '../scope-util.js'
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

export async function runImport(plur: Plur, records: ImportRecord[], opts: RunImportOptions): Promise<MigrationReport> {
  const dryRun = opts.dryRun === true
  const now = new Date().toISOString()

  // Pre-existing view: dedup identity + conflict candidates. include_expired
  // for parity with learn()'s content-hash gate, which ignores temporal
  // validity — a plain list() would drop already-expired engrams and make the
  // engine misreport their duplicates as fresh imports (re-patching temporal
  // metadata on the existing engram along the way).
  const preExisting = await plur.list({ include_expired: true })
  const knownIds = new Set(preExisting.map(e => e.id))
  // Dry run only: earlier records of this file, keyed both by hash and by
  // (hash, scope). The store half of the dedup question goes to
  // `plur.wouldDeduplicate` (learn()'s own code, which follows decision A1 /
  // F1: a shared-scope record is never absorbed by another scope's engram).
  // Which key a record is looked up by follows `plur.dedupScopeFor`:
  // scope-blind where learn() dedups across scopes (YAML, #176, non-shared
  // scopes), (hash, scope) where it does not (a shared scope, a delegating
  // Postgres/PGLite store, a writable-remote scope) — so two records of one
  // file in different scopes are predicted as the real run imports them.
  const hashToId = new Map<string, string>()
  const inFileKey = (hash: string, scope: string) => `${hash}\u0000${scope}`
  const allowSecrets = (await plur.status()).config?.allow_secrets === true

  const results: ImportRecordResult[] = []
  let imported = 0
  let skipped = 0
  let conflicts = 0
  let errors = 0

  for(const record of records) {
    const statement = (record.statement ?? '').trim()
    if (!statement) {
      errors++
      results.push({ statement: record.statement ?? '', action: 'error', error: 'empty statement' })
      continue
    }
    const scope = opts.scope ?? record.scope
    // One context for both modes: the dry run must scan and key exactly what
    // learn() will (formal R2, core-retrieval#10).
    let context: LearnContext
    try {
      context = importContext(record, scope, opts)
    } catch (err) {
      errors++
      results.push({ statement, action: 'error', error: (err as Error).message })
      continue
    }

    // learn()'s hard scan: the statement plus every content field of the
    // context (`_hardScanText`), not only statement/domain/tags — a secret in
    // `source` is refused by learn() and must be predicted as an error. Both
    // modes check it FIRST, so the real run's pre-learn dedup below cannot
    // turn learn()'s refusal into a skip (dry/real parity).
    let secretPattern: string | null = null
    if (!allowSecrets) {
      const content = learnContextContent(context)
      const secretText = content ? `${statement}\n${JSON.stringify(content)}` : statement
      secretPattern = detectSecrets(secretText)[0]?.pattern ?? null
    }

    if (dryRun) {
      // Mirror the learn() gates without writing.
      if (secretPattern !== null) {
        errors++
        results.push({ statement, action: 'error', error: `Secret detected in statement or context: ${secretPattern}` })
        continue
      }
      // learn() never dedups a statement that normalizes to nothing (#896):
      // every such statement shares the empty-string hash. Predict "imported".
      if (isHashable(statement)) {
        const hash = computeContentHash(statement)
        // Against the store: ask learn()'s own dedup (`Plur.wouldDeduplicate`),
        // not a scope-blind hash map — on a delegating store (Postgres/PGLite)
        // learn() does not treat another scope's primary row as a duplicate,
        // so the map reported `skipped` for a record the real run imports.
        const existing = await plur.wouldDeduplicate(statement, context)
        if (existing !== null) {
          skipped++
          results.push({ statement, action: 'skipped', id: existing })
          continue
        }
        // Earlier records of THIS file (nothing was written for them).
        const plan = await plur.dedupScopeFor(statement, context)
        const key = plan.acrossScopes ? hash : inFileKey(hash, plan.scope)
        if (hashToId.has(key)) {
          skipped++
          results.push({ statement, action: 'skipped', id: hashToId.get(key) })
          continue
        }
        // in-file duplicates dedup against each other too
        hashToId.set(hash, '')
        hashToId.set(inFileKey(hash, plan.scope), '')
      }
      const conflictIds = findConflicts(statement, scope, record.domain, preExisting)
      imported++
      if (conflictIds.length > 0) conflicts++
      results.push({ statement, action: 'imported', ...(conflictIds.length > 0 ? { conflicts: conflictIds } : {}) })
      continue
    }

    try {
      // Decision R: a record that already exists is a TRUE skip — asked before
      // learn(), so the existing engram is never touched (learn() on a hit
      // bumps write_count / appends a source / records recurrence). A secret
      // record goes on to learn(), which refuses it with its own message.
      if (secretPattern === null) {
        const existing = await plur.wouldDeduplicate(statement, context)
        if (existing !== null) {
          skipped++
          results.push({ statement, action: 'skipped', id: existing })
          continue
        }
      }
      const engram = await plur.learn(statement, context)

      if (knownIds.has(engram.id)) {
        // Defensive: learn() still resolved to an existing engram (a write
        // landed between the check and learn()). Reported as skipped.
        skipped++
        results.push({ statement, action: 'skipped', id: engram.id })
        continue
      }
      knownIds.add(engram.id)

      const conflictIds = findConflicts(statement, scope, record.domain, preExisting)
      const patched = applyImportMetadata(engram, record, conflictIds, now)
      if (patched) await plur.updateEngram(patched)

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

/** The LearnContext a record is written with (shared by the dry and real runs). */
function importContext(record: ImportRecord, scope: string | undefined, opts: RunImportOptions): LearnContext {
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
  return context
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
      // #240: preserve intentional-update edges when merging conflict ids
      supersedes: engram.relations?.supersedes ?? [],
      superseded_by: engram.relations?.superseded_by ?? [],
    }
    changed = true
  }

  return changed ? out : null
}
