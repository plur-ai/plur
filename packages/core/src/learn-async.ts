/**
 * Async learning with LLM-driven deduplication (Ideas 1+2+19).
 * Separated from index.ts to avoid merge conflicts with parallel SPs.
 */
import { computeContentHash } from './content-hash.js'
import { buildDedupPrompt, parseDedupResponse } from './dedup.js'
import { appendHistory } from './history.js'
import { logger } from './logger.js'
import { withAsyncLock } from './store/async-lock.js'
import { maybeDailyBackup } from './backup.js'
import { searchTextFrom } from './fts.js'
import { engramContentFields } from './content-fields.js'
import type { Engram } from './schemas/engram.js'
import type { AsyncPrimaryStore } from './store/primary-store.js'
import type { SecretMatch } from './secrets.js'
import type { LearnContext, LearnAsyncContext, LearnAsyncResult, LearnBatchResult, LearnBatchFailure, DedupDecision, LlmFunction } from './types.js'

/**
 * Similarity below which a near-duplicate observation is not worth recording.
 *
 * Deliberately below every measured duplicate AND every measured distinct pair
 * (lowest observed: 0.8339), so the recorded distribution spans the whole band
 * where a future write gate might sit. Raising this narrows the evidence the
 * decision will eventually be made from — the mistake this pass is undoing.
 */
export const NEAR_DUPLICATE_OBSERVATION_FLOOR = 0.75

export interface LearnAsyncDeps {
  /** Content hash dedup against all engrams. Scope-aware: only matches same scope. */
  hashDedup: (statement: string, scope?: string) => Promise<Engram | null>
  /** Hybrid recall for semantic similarity. */
  recallHybrid: (query: string, options?: { limit?: number }) => Promise<Engram[]>
  /** BM25 recall fallback. */
  recall: (query: string, options?: { limit?: number }) => Promise<Engram[]>
  /** Sync learn for the ADD path. */
  learn: (statement: string, context?: LearnContext) => Promise<Engram>
  /** Get engram by ID. */
  getById: (id: string) => Promise<Engram | null>
  /**
   * Source of truth for primary engram state (convergence Phase 1). The
   * UPDATE/MERGE paths below read and write through this rather than calling
   * loadEngrams/saveEngrams on `engramsPath`, so a non-YAML primary store works
   * here too.
   */
  store: AsyncPrimaryStore
  /**
   * Paths. `engramsPath` is still the LOCK KEY for `withAsyncLock` — file-based
   * locking is Phase 2's problem, not this one — and is no longer used to read
   * or write engram state.
   */
  engramsPath: string
  rootPath: string
  /** Dedup config. */
  dedupConfig: { enabled?: boolean; threshold?: number; mode?: string }
  /**
   * Local similarity scores for `statement` against `candidates` (#854).
   *
   * OPTIONAL: when absent — embedder disabled, or a caller constructing deps by
   * hand — dedup degrades to hash-only and says so, rather than silently taking
   * the ADD default as it did before.
   */
  similarityScores?: (
    statement: string,
    candidates: Engram[],
  ) => Promise<Array<{ id: string; score: number }>>
  /** Circuit breaker check. */
  isLlmAvailable: () => boolean
  /** Record LLM success. */
  recordLlmSuccess: () => void
  /** Record LLM failure. */
  recordLlmFailure: () => void
  /** Sync index after write. */
  syncIndex: () => Promise<void>
  /**
   * Leak guard predicate (#353). Returns the offending sensitivity hits when
   * `statement` carries content the SHARED `scope` forbids, else `[]` (always
   * `[]` for personal/local scopes). Single source of truth lives on the Plur
   * class as `_offendingHitsForScope`; injected here so the UPDATE/MERGE paths
   * can demote a mutated engram before it is written back to a shared store.
   */
  offendingHitsForScope: (statement: string, scope: string) => SecretMatch[]
}


/**
 * Run `fn` under exclusive access to the store — the store's own mechanism when
 * it has one, the path-based file lock otherwise.
 *
 * Mirrors `Plur._withStoreLock`, and exists for the same reason. These writes
 * are load -> mutate -> `store.save(all)`, which REPLACES the whole corpus, so
 * two concurrent writers do not merely lose an update: the loser deletes rows
 * the winner committed.
 *
 * This module locked on `deps.engramsPath` unconditionally — an `O_EXCL` file on
 * the LOCAL disk. That is correct for a YAML store, where the path being locked
 * IS the data, and worthless for a shared database: two processes share neither
 * the mutex nor the file. So `learnAsync` and `learnBatch` bypassed the Postgres
 * advisory lock that every other write path takes.
 */
/**
 * Persist exactly one changed engram (audit #794 F3 remainder, issue #802).
 *
 * The dedup UPDATE and MERGE branches used to call `deps.store.save(engrams)`
 * directly, which bypasses the incremental write seam and is a WHOLE-CORPUS
 * REPLACE on every backend. That is a correctness bug, not just a slow path:
 * `PostgresAdapter.save()` finishes with
 *
 *   DELETE FROM engrams WHERE id NOT IN (<the ids being saved>)
 *
 * so every row absent from the array this call happened to load is deleted —
 * and an empty array deletes the table outright. It fires on ordinary
 * `plur_learn` calls, since UPDATE/MERGE is what LLM dedup returns whenever the
 * statement resembles something already stored.
 *
 * `updateMany` is the seam's "these rows changed, leave the rest alone"
 * primitive; a store that implements it gets a single-row UPDATE. A store
 * without it falls back to the whole-corpus save it always had — no worse than
 * before, and on YAML that save is itself guarded against an unexpected shrink.
 */
async function persistOne(deps: LearnAsyncDeps, corpus: Engram[], changed: Engram): Promise<void> {
  if (deps.store.updateMany) {
    await deps.store.updateMany([changed])
    deps.store.invalidate()
    return
  }
  await deps.store.save(corpus)
}

async function withStoreLock<T>(deps: LearnAsyncDeps, fn: () => Promise<T>): Promise<T> {
  // Take the daily snapshot here too (#813, audit finding 15). Plur's own
  // `_withStoreLock` does this, but the dedup paths lock through this helper
  // instead — so when the first mutation of the day was an UPDATE or a MERGE,
  // the pre-mutation corpus was never snapshotted and the statement being
  // overwritten had no copy anywhere.
  //
  // Same ordering as the engine's hook and for the same reasons: inside the
  // lock, before `fn` reads or writes, so the copy is of the on-disk bytes as
  // they were. Never throws — a backup is a safety net for the write, not a
  // precondition of it.
  const guarded = async (): Promise<T> => {
    try { maybeDailyBackup(deps.rootPath, deps.engramsPath) } catch { /* backup logs its own failures */ }
    return await fn()
  }
  if (deps.store.withExclusiveAccess) return await deps.store.withExclusiveAccess(guarded)
  return await withAsyncLock(deps.engramsPath, guarded)
}

/**
 * Demote an engram in place when its (post-mutation) statement carries content
 * the engram's shared scope forbids. Local write, so demotion is coherent:
 * scope→'local', visibility→'private'. Warns naming the offending patterns,
 * mirroring `_guardSensitiveScope`'s warning style. No-op (returns the engram
 * unchanged) when there are no offending hits. (#353)
 *
 * Stamps `structured_data._demoted = { from, to, patterns }` (LOW-9, #353)
 * mirroring the sync learnRouted demotion (index.ts `guarded.demotion`) and the
 * explicit-update / saveMetaEngrams demotion sites, so the MCP plur_learn
 * response (tools.ts) and the CLI can surface that the requested shared scope
 * was demoted. Captures `from` BEFORE the scope reassignment.
 */
function demoteIfSensitive(
  deps: LearnAsyncDeps,
  engram: any,
  newStatement: string,
): void {
  // Scan the post-mutation statement AND the rest of the engram. A dedup
  // UPDATE/MERGE unions `context.tags` into the engram before this runs, so a
  // secret/infra value in a merged tag would otherwise ride to a shared store
  // unguarded — the statement-only scan missed it (#409). The field set is the
  // same serialised surface every other engram-side guard reads
  // (`engramContentFields`), not a list kept here that could drift from it.
  const fields = engramContentFields({ ...engram, statement: newStatement } as Engram)
  const scanText = fields ? `${newStatement}\n${JSON.stringify(fields)}` : newStatement
  const offending = deps.offendingHitsForScope(scanText, engram.scope ?? 'global')
  if (offending.length === 0) return
  const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
  logger.warning(
    `[plur] sensitive content (${patterns}) held back from shared scope "${engram.scope}" — ` +
    `demoted to local/private so it is not written to a shared store. ` +
    `Re-scope deliberately if this is a false positive.`,
  )
  const from = engram.scope ?? 'global'
  engram.scope = 'local'
  engram.visibility = 'private'
  engram.structured_data = {
    ...(engram.structured_data ?? {}),
    _demoted: { from, to: 'local', patterns },
  }
}

/**
 * Execute LLM-driven dedup decision.
 *
 * Async since convergence Phase 2: the UPDATE/MERGE writes take
 * `withAsyncLock`, which queues concurrent in-process writers instead of making
 * all but one of them retry an `EEXIST` and eventually throw.
 *
 * The "target vanished" fallback (`idx === -1`) now runs OUTSIDE the lock. It
 * used to call `await deps.learn()` from inside it, and `Plur.learn()` takes the same
 * lock on the same path — a self-deadlock that resolved only by the inner
 * acquire exhausting its retries and throwing. Reachable whenever the target
 * engram disappears between `getById` and the lock, which is exactly the
 * concurrent case this phase is about.
 */
async function executeDedupDecision(
  deps: LearnAsyncDeps,
  statement: string,
  context: LearnContext | undefined,
  decision: DedupDecision,
  targetId: string | null,
): Promise<LearnAsyncResult> {
  // Name the model behind a dedup verdict (#962). A model rewrote the
  // statement, and that rewrite became the memory. Without naming it the
  // decision cannot be reviewed later. Omitted when the caller did not say
  // which model it passed — we never invent one.
  const dedupActor = context?.attribution?.model
    ? { model: context.attribution.model }
    : undefined
  switch (decision) {
    case 'NOOP': {
      if (targetId) {
        const existing = await deps.getById(targetId)
        if (existing) return { engram: existing, decision: 'NOOP', existing_id: targetId }
      }
      return { engram: await deps.learn(statement, context), decision: 'ADD' }
    }

    case 'UPDATE': {
      if (targetId) {
        const existing = await deps.getById(targetId)
        if (existing && (existing as any).commitment !== 'locked') {
          const result = await withStoreLock(deps, async () => {
            const engrams = await deps.store.load()
            const idx = engrams.findIndex(e => e.id === targetId)
            // Target gone — fall out of the lock and ADD; see the doc comment.
            if (idx === -1) return null
            const updated = { ...engrams[idx] } as any
            updated.statement = statement
            updated.content_hash = computeContentHash(statement)
            updated.engram_version = (updated.engram_version ?? 1) + 1
            updated.activation.last_accessed = new Date().toISOString().slice(0, 10)
            if (context?.tags) updated.tags = [...new Set([...updated.tags, ...context.tags])]
            // Leak guard (#353): a dedup UPDATE can introduce sensitive content
            // into an engram living at a shared scope. Demote before persisting.
            demoteIfSensitive(deps, updated, updated.statement)
            engrams[idx] = updated
            await persistOne(deps, engrams, updated)
            await deps.syncIndex()
            appendHistory(deps.rootPath, {
              event: 'engram_updated',
              engram_id: targetId,
              timestamp: new Date().toISOString(),
              data: { old_statement: existing.statement, new_statement: statement, reason: 'LLM dedup UPDATE' },
              // Which model decided this (#962). A model rewrote the statement,
              // and that rewrite became the memory. Without naming the model the
              // decision cannot be reviewed later.
              ...(dedupActor ? { actor: dedupActor } : {}),
            })
            return { engram: updated as Engram, decision: 'UPDATE' as DedupDecision, existing_id: targetId }
          })
          if (result) return result
        }
      }
      return { engram: await deps.learn(statement, context), decision: 'ADD' }
    }

    case 'MERGE': {
      if (targetId) {
        const existing = await deps.getById(targetId)
        if (existing && (existing as any).commitment !== 'locked') {
          const result = await withStoreLock(deps, async () => {
            const engrams = await deps.store.load()
            const idx = engrams.findIndex(e => e.id === targetId)
            // Target gone — fall out of the lock and ADD; see the doc comment.
            if (idx === -1) return null
            const merged = { ...engrams[idx] } as any
            merged.statement = `${merged.statement} ${statement}`
            merged.content_hash = computeContentHash(merged.statement)
            merged.engram_version = (merged.engram_version ?? 1) + 1
            merged.activation.last_accessed = new Date().toISOString().slice(0, 10)
            if (context?.tags) merged.tags = [...new Set([...merged.tags, ...context.tags])]
            if (0.7 > merged.activation.retrieval_strength) merged.activation.retrieval_strength = 0.7
            // Leak guard (#353): a dedup MERGE concatenates the incoming
            // statement, which can introduce sensitive content into an engram at
            // a shared scope. Demote before persisting.
            demoteIfSensitive(deps, merged, merged.statement)
            engrams[idx] = merged
            await persistOne(deps, engrams, merged)
            await deps.syncIndex()
            appendHistory(deps.rootPath, {
              event: 'engram_merged',
              engram_id: targetId,
              timestamp: new Date().toISOString(),
              data: { merged_statement: statement, reason: 'LLM dedup MERGE' },
              ...(dedupActor ? { actor: dedupActor } : {}),
            })
            return { engram: merged as Engram, decision: 'MERGE' as DedupDecision, existing_id: targetId }
          })
          if (result) return result
        }
      }
      return { engram: await deps.learn(statement, context), decision: 'ADD' }
    }

    case 'ADD':
    default:
      return { engram: await deps.learn(statement, context), decision: 'ADD' }
  }
}

/**
 * Async learn with LLM-driven deduplication.
 * Flow: hash dedup → semantic recall → LLM decision → execute.
 */
export async function learnAsync(
  deps: LearnAsyncDeps,
  statement: string,
  context?: LearnAsyncContext,
): Promise<LearnAsyncResult> {
  // Step 1: Content hash fast-path (scope-aware — issue #136)
  const hashMatch = await deps.hashDedup(statement, context?.scope)
  if (hashMatch) {
    return { engram: hashMatch, decision: 'NOOP', existing_id: hashMatch.id }
  }

  // Step 2: Check dedup config
  //
  // `threshold` is a REPORTING floor, not a write gate. Cosine similarity never
  // suppresses a write — see the reporting block in step 4 for why the gate was
  // removed rather than tuned.
  //
  // Measured with the shipped BGE-small embedder, comparing ENRICHED text on
  // both sides:
  //
  //   0.8512  DISTINCT   staging port 8080 vs 8081
  //   0.8826  DISTINCT   "Always rebase before pushing" vs "Never ..."
  //   0.9878  DUPLICATE  the #854 pair, fixtures contexted on BOTH sides
  //   0.8339  DUPLICATE  the SAME pair as actually written (twin had no
  //                      domain, no rationale) — below every candidate bar
  //
  // That last row is the one that matters: the real duplicates are the
  // under-contexted ones, and they score below the distinct pairs. There is no
  // value of `threshold` that separates them, which is why this reports rather
  // than decides. 0.85 is a deliberately low floor chosen to capture the
  // distribution around the interesting band, not to assert a duplicate.
  const { enabled = true, threshold = 0.85, mode = 'llm' } = deps.dedupConfig
  if (!enabled || mode === 'off') {
    return { engram: await deps.learn(statement, context), decision: 'ADD' }
  }

  // Step 3: Semantic similarity search
  let candidates: Engram[] = []
  try {
    candidates = await deps.recallHybrid(statement, { limit: 5 })
  } catch {
    candidates = await deps.recall(statement, { limit: 5 })
  }
  // Fallback to BM25 when hybrid returns empty (e.g. embedding model warmup on
  // cold CI runners makes embeddings return []; BM25 usually still matches).
  if (candidates.length === 0) {
    candidates = await deps.recall(statement, { limit: 5 })
  }
  candidates = candidates.filter(c => c.status === 'active')
  // Mirror hashDedup scope-awareness (issue #359): only dedup against same-scope engrams.
  // Without this, a global engram silently absorbs an explicitly-scoped write — the requested
  // scope is dropped and the team store never receives the engram.
  if (context?.scope) {
    candidates = candidates.filter(c => c.scope === context.scope)
  }

  if (candidates.length === 0) {
    return { engram: await deps.learn(statement, context), decision: 'ADD' }
  }

  // Step 4: decide — LLM if one is available, otherwise local cosine (#854).
  //
  // This branch used to fall straight through to the `ADD` default when no LLM
  // was configured, discarding the candidates fetched above unread. The
  // comments claimed a cosine fallback; none was ever written, and `threshold`
  // was destructured and never read. On any install without an LLM key that
  // made dedup exact-hash-only, so every reworded near-duplicate was written.
  const llm = context?.llm
  let decision: DedupDecision = 'ADD'
  let targetId: string | null = null
  let dedupMode: 'llm' | 'cosine' | 'hash-only' = 'hash-only'
  let nearDuplicates: Array<{ id: string; score: number }> | undefined

  if (mode === 'llm' && llm && deps.isLlmAvailable()) {
    dedupMode = 'llm'
    try {
      const prompt = buildDedupPrompt(
        statement,
        candidates.map(c => ({ id: c.id, statement: c.statement, type: c.type, domain: c.domain })),
      )
      const response = await llm(prompt)
      const parsed = parseDedupResponse(response)
      decision = parsed.decision
      targetId = parsed.target_id
      deps.recordLlmSuccess()
    } catch (err) {
      logger.warning(`LLM dedup failed, falling back to local similarity: ${err}`)
      deps.recordLlmFailure()
      decision = 'ADD'
      dedupMode = 'hash-only'
    }
  }

  // Local similarity path — zero API calls, works offline, which is the
  // property core is supposed to hold. Runs when no LLM decided above.
  if (dedupMode !== 'llm' && deps.similarityScores) {
    try {
      // Enrich the incoming side the SAME way stored engrams are enriched, so
      // this is a like-for-like comparison. Stored engrams embed
      // `engramSearchText` output; embedding a bare statement against that
      // compares a fragment to fully-contexted records, and measurably
      // collapses the two classes together (distinct pair 0.9749 bare ->
      // 0.8512 enriched; real duplicate 0.9689 -> 0.9878).
      const query = searchTextFrom({
        statement,
        domain: context?.domain,
        tags: context?.tags,
        rationale: context?.rationale,
        source: context?.source,
        dual_coding: context?.dual_coding as never,
        knowledge_anchors: context?.knowledge_anchors as never,
      })
      const scores = (await deps.similarityScores(query, candidates))
        .slice()
        .sort((a, b) => b.score - a.score)
      if (scores.length > 0) {
        dedupMode = 'cosine'
        nearDuplicates = scores.slice(0, 3)
        // REPORTING ONLY — cosine never gates a write (#856 audit).
        //
        // The gate was removed rather than retuned, because the audit showed
        // the bar could not have worked at any value. The fixtures that
        // justified 0.95 gave both sides an identical domain, tags and
        // rationale; the ten pairs from #854 did NOT — their second copy had no
        // domain and no rationale, which is defect 2 of that same issue. Scored
        // as actually written the pair sits at 0.8339, below 0.95 and below even
        // the old 0.85, so NONE of the reported duplicates would have been
        // caught. Production enriches only the incoming side from the write's
        // own context, so an under-contexted write is structurally compared
        // against a fully-contexted stored engram, and the symmetry the design
        // rested on does not hold for exactly the writes that produce duplicates.
        //
        // A bar guessed from paired fixtures would therefore have bought a real
        // false-NOOP risk — a memory silently not stored, the worst outcome this
        // product has — while not fixing #854. So: emit the observation, build a
        // distribution from real writes, and set a bar from that if the data
        // supports one. `threshold` is retained as the REPORTING floor below,
        // not as a write gate.
        //
        // This also disposes of the cross-scope hazard the audit raised: an
        // unscoped write that auto-routes to a team scope can no longer NOOP
        // against a `global` near-duplicate, because nothing NOOPs.
        const top = scores[0]
        if (top.score >= NEAR_DUPLICATE_OBSERVATION_FLOOR) {
          // History is what makes the distribution measurable after the fact.
          // Without it, "measure over the real store" means re-embedding the
          // corpus and guessing which pairs were writes.
          try {
            appendHistory(deps.rootPath, {
              event: 'dedup_near_duplicate',
              engram_id: top.id,
              timestamp: new Date().toISOString(),
              data: {
                statement: statement.slice(0, 200),
                top_score: Number(top.score.toFixed(4)),
                reporting_threshold: threshold,
                above_reporting_threshold: top.score >= threshold,
                scope: context?.scope ?? null,
                // The asymmetry that broke the bar. Recorded per write so the
                // distribution can be split by it instead of averaging over it.
                incoming_has_domain: Boolean(context?.domain),
                incoming_has_rationale: Boolean(context?.rationale),
              },
            })
          } catch (err) {
            logger.warning(`could not record near-duplicate observation: ${err}`)
          }
        }
      }
    } catch (err) {
      // Similarity is an optimisation, never a gate on writing. Falling back
      // to ADD is correct; claiming a cosine decision we did not make is not.
      logger.warning(`local similarity dedup unavailable, adding without it: ${err}`)
      dedupMode = 'hash-only'
      nearDuplicates = undefined
    }
  }

  // Step 5: Execute
  const executed = await executeDedupDecision(deps, statement, context, decision, targetId)
  return { ...executed, dedup: { mode: dedupMode, ...(nearDuplicates ? { near_duplicates: nearDuplicates } : {}) } }
}

/** Options for learnBatch. */
export interface LearnBatchOptions {
  /**
   * Maximum number of LLM dedup calls allowed across the whole batch.
   * Once spent, remaining statements skip the (expensive) LLM dedup decision
   * and fall back to the conservative hash/cosine path. Bounds the cost of
   * bulk imports — a 1000-statement batch no longer triggers 1000 LLM calls.
   * Defaults to 50. Pass Infinity to opt out. (Security audit 2026-06-10, finding #4.)
   */
  maxLlmCalls?: number
}

/**
 * Batch learn: process multiple statements sequentially with LLM dedup.
 *
 * LLM dedup calls are bounded by opts.maxLlmCalls (default 50). The cap only
 * bites on large batches of novel-but-similar statements — exact-hash NOOPs
 * and zero-candidate ADDs short-circuit before the LLM and don't consume budget.
 */
export async function learnBatch(
  deps: LearnAsyncDeps,
  statements: Array<{ statement: string; context?: LearnAsyncContext }>,
  llm?: LlmFunction,
  opts: LearnBatchOptions = {},
): Promise<LearnBatchResult> {
  const results: LearnAsyncResult[] = []
  const failures: LearnBatchFailure[] = []
  const stats = { added: 0, updated: 0, merged: 0, noops: 0, failed: 0 }

  const maxLlmCalls = opts.maxLlmCalls ?? 50
  let llmCallsUsed = 0
  let capWarned = false

  for (let i = 0; i < statements.length; i++) {
    const { statement, context } = statements[i]
    // Resolve the LLM for this statement (per-statement override wins), then
    // gate it on the remaining budget. The wrapper increments the counter only
    // when learnAsync actually invokes the LLM (Step 4), so cheap short-circuits
    // don't burn budget. The loop is sequential, so the counter needs no lock.
    const stmtLlm = context?.llm ?? llm
    let effectiveLlm: LlmFunction | undefined = stmtLlm
    if (stmtLlm) {
      if (llmCallsUsed >= maxLlmCalls) {
        effectiveLlm = undefined
        if (!capWarned) {
          logger.warning(`learnBatch: maxLlmCalls (${maxLlmCalls}) reached — remaining statements fall back to local cosine dedup (see each result's dedup.mode)`)
          capWarned = true
        }
      } else {
        effectiveLlm = async (prompt: string) => { llmCallsUsed++; return stmtLlm(prompt) }
      }
    }

    const ctx: LearnAsyncContext = { ...context, llm: effectiveLlm }
    // Partial-failure isolation (batch API, #281 item #3): one statement's
    // failure must not abort the batch — an orchestrator persisting 50
    // consolidated findings should keep the 49 that succeed. Capture the error
    // against its input index and continue; the caller inspects `failures`.
    try {
      const result = await learnAsync(deps, statement, ctx)
      // Tag with the input position so a caller can map this result back to its
      // input even though `results` is compacted (failed statements absent). #281
      results.push({ ...result, input_index: i })
      const key = result.decision.toLowerCase()
      if (key === 'noop') stats.noops++
      else if (key === 'update') stats.updated++
      else if (key === 'merge') stats.merged++
      else stats.added++
    } catch (err) {
      stats.failed++
      failures.push({ index: i, statement, error: err instanceof Error ? err.message : String(err) })
      logger.warning(`learnBatch: statement ${i} failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { results, stats, failures }
}
