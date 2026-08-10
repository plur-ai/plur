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
import type { Engram } from './schemas/engram.js'
import type { AsyncPrimaryStore } from './store/primary-store.js'
import type { SecretMatch } from './secrets.js'
import type { LearnContext, LearnAsyncContext, LearnAsyncResult, LearnBatchResult, LearnBatchFailure, DedupDecision, LlmFunction } from './types.js'

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
  // Scan the post-mutation statement AND the engram's (merged) tags. A dedup
  // UPDATE/MERGE unions `context.tags` into the engram before this runs, so a
  // secret/infra value in a merged tag would otherwise ride to a shared store
  // unguarded — the statement-only scan missed it (#409).
  const tags = Array.isArray(engram.tags) ? engram.tags.filter((t: unknown) => typeof t === 'string') : []
  const scanText = tags.length ? `${newStatement}\n${tags.join(' ')}` : newStatement
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
  // threshold default raised 0.85 -> 0.95 when it was first actually WIRED
  // (#854). It sat unread for four months, so 0.85 was never exercised against
  // real writes and carries no evidence. It now gates an automatic NOOP, and a
  // false NOOP silently discards a memory — the worst failure class here — so
  // the untested value is not the one to start from. An explicit config value
  // still wins.
  const { enabled = true, threshold = 0.95, mode = 'llm' } = deps.dedupConfig
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
      const scores = (await deps.similarityScores(statement, candidates))
        .slice()
        .sort((a, b) => b.score - a.score)
      if (scores.length > 0) {
        dedupMode = 'cosine'
        nearDuplicates = scores.slice(0, 3)
        const top = scores[0]
        // A false NOOP silently discards a memory, which is a worse outcome
        // than a duplicate — so the bar is deliberately high. 0.85 was the
        // declared default for four months while nothing read it, so it was
        // never validated against real writes; a measured duplicate pair from
        // #854 sat at 0.928. Anything below the bar is still reported.
        if (top.score >= threshold) {
          const existing = candidates.find(c => c.id === top.id)
          if (existing) {
            return {
              engram: existing,
              decision: 'NOOP',
              existing_id: existing.id,
              dedup: { mode: 'cosine', near_duplicates: nearDuplicates },
            }
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
