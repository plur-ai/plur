/**
 * Async learning with LLM-driven deduplication (Ideas 1+2+19).
 * Separated from index.ts to avoid merge conflicts with parallel SPs.
 */
import { buildDedupPrompt, parseDedupResponse } from './dedup.js'
import { appendHistory } from './history.js'
import { logger } from './logger.js'
import { searchTextFrom } from './fts.js'
import type { Engram } from './schemas/engram.js'
import type { AsyncPrimaryStore } from './store/primary-store.js'
import type { SecretMatch } from './secrets.js'
import type { TensionPair } from './tensions.js'
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
  /**
   * Routed learn for the ADD path in learnBatch (#930). When present, learnBatch
   * uses this instead of `learn` so remote-scope writes await the server push and
   * return the server-assigned id. Without this, the fire-and-forget outbox in
   * `learn` deletes the local copy after a successful push, and the next
   * iteration's generateEngramId finds the same slot free, producing the same id
   * for every item in the batch.
   */
  learnRouted?: (statement: string, context?: LearnContext) => Promise<Engram>
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
  /**
   * Put a pair in the user's review queue (LRN-9): a tension record with
   * status `detected`, the queue plur_tensions lists and the user resolves.
   * Returns the record id. Optional so hand-built deps keep working; without
   * it an UPDATE onto a locked memory still saves the new statement.
   */
  openReview?: (pair: TensionPair) => Promise<string | undefined>
  /**
   * Turn an already-saved memory into a draft (`commitment: 'draft'`: stored
   * and searchable, never injected; INJ-4). Used by LRN-9 when a memory became
   * locked between the read and the save, so the statement was saved before
   * the lock was seen. Optional so hand-built deps keep working.
   */
  holdAsDraft?: (id: string) => Promise<void>
}


/**
 * The duplicate checker said UPDATE onto a locked memory (LRN-9, owner
 * decision 2026-10-18: "there should be a review queue unless the user
 * specifies differently"). The locked memory is left exactly as it is, the
 * new statement is saved as its own memory, and a tension record linking the
 * two (status `detected`) puts the pair in the user's review queue.
 *
 * Owner decision 2026-10-19: while the review waits only the locked memory is
 * given to the agent. The new statement is saved as a draft (stored and
 * searchable, never injected, INJ-4). Resolving the review in its favour makes
 * it a normal memory (Plur.resolveTension); resolving it for the locked memory
 * retires it; dismissing the review leaves it a draft. There is no setting to
 * skip the review.
 */
async function saveBesideLocked(
  deps: LearnAsyncDeps,
  statement: string,
  context: LearnContext | undefined,
  locked: Engram,
  alreadySaved?: Engram,
): Promise<LearnAsyncResult> {
  let engram: Engram
  if (alreadySaved) {
    engram = alreadySaved
    // Saved as a normal memory before the lock was seen: hold it back now.
    if (engram.id !== locked.id && engram.commitment !== 'draft' && deps.holdAsDraft) {
      try {
        await deps.holdAsDraft(engram.id)
        engram = { ...engram, commitment: 'draft' }
      } catch (err) {
        logger.warning(`could not hold ${engram.id} back as a draft while its review waits: ${err}`)
      }
    }
  } else {
    engram = await deps.learn(statement, { ...context, commitment: 'draft' })
  }
  let tensions: string[] | undefined
  if (deps.openReview && engram.id !== locked.id) {
    try {
      const id = await deps.openReview({
        id_a: locked.id,
        id_b: engram.id,
        statement_a: locked.statement,
        statement_b: engram.statement,
        confidence: 1,
        reason: `The duplicate checker said ${engram.id} updates ${locked.id}, which is locked. ` +
          `A locked memory is not superseded automatically, so both are kept and this pair waits for review.`,
      })
      if (id) tensions = [id]
    } catch (err) {
      // The new statement is saved either way; a missing review item is logged, not thrown.
      logger.warning(`could not open a review item for ${locked.id} and ${engram.id}: ${err}`)
    }
  }
  return { engram, decision: 'ADD', existing_id: locked.id, ...(tensions ? { tensions } : {}) }
}

/**
 * Execute LLM-driven dedup decision.
 *
 * No branch rewrites an existing memory: NOOP saves nothing, UPDATE saves a
 * new memory that supersedes the target, MERGE and ADD save a new memory (MERGE
 * linked to the target). Every write goes through `deps.learn`, which takes the
 * store lock itself, so nothing here locks.
 *
 * `opts` is accepted for callers that still pass it; see LearnAsyncOptions.
 */
async function executeDedupDecision(
  deps: LearnAsyncDeps,
  statement: string,
  context: LearnContext | undefined,
  decision: DedupDecision,
  targetId: string | null,
  opts: LearnAsyncOptions = {},
): Promise<LearnAsyncResult> {
  // No save overwrites an existing memory (owner decision 2026-10-18). A MERGE
  // answer from the duplicate checker means "related, both worth keeping", so
  // the incoming statement is saved as its own memory, linked to the one the
  // checker named (`relations.related`, forward edge only), and the result
  // says so. The existing memory is not touched: not its text, not its tags,
  // not its version. This holds for a single save and a batch save alike
  // (LRN-7): the single path used to concatenate the two statements into the
  // existing memory, which turned two different rules into one memory and
  // rewrote the old text. A real duplicate is the checker's NOOP; a changed
  // value is its UPDATE, which supersedes (below) and never rewrites either.
  if (decision === 'MERGE') {
    const existing = targetId ? await deps.getById(targetId) : null
    if (!existing || existing.status !== 'active') {
      return { engram: await deps.learn(statement, context), decision: 'ADD' }
    }
    const related = [...new Set([...(context?.related ?? []), existing.id])]
    const engram = await deps.learn(statement, { ...context, related })
    return {
      engram,
      decision: 'ADD',
      likely_duplicate_of: {
        id: existing.id,
        checker_decision: decision,
        note:
          `The duplicate checker suggested merging this into ${existing.id}. ` +
          `Learning never overwrites an existing memory, so this was saved as its own memory and linked to ` +
          `${existing.id} as a likely duplicate; ${existing.id} is unchanged.`,
      },
    }
  }
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
      // A changed value is saved as its own memory that supersedes the old one
      // (owner decision 2026-10-18, LRN-8): the old text is never rewritten,
      // it is marked `superseded_by` the new memory and stops being injected
      // (the LearnContext.supersedes path, #240). A LOCKED target is never
      // superseded automatically (LRN-9): it stays as it is, the new statement
      // is saved, and the pair goes to the review queue.
      const existing = targetId ? await deps.getById(targetId) : null
      if (!existing || existing.status !== 'active') {
        return { engram: await deps.learn(statement, context), decision: 'ADD' }
      }
      if ((existing as any).commitment === 'locked') {
        return await saveBesideLocked(deps, statement, context, existing)
      }
      const supersedes = [...new Set([...(context?.supersedes ?? []), existing.id])]
      // The replacement lives where the memory it replaces lives, unless the
      // caller named a scope (candidates are then already filtered to it).
      // learn()'s own sensitive-content guard still runs on the new memory.
      const scope = context?.scope ?? existing.scope
      // `supersedes_unless_locked`: learn() re-checks the lock under the store
      // lock, so a memory locked after the read above is not superseded either.
      const engram = await deps.learn(statement, { ...context, ...(scope ? { scope } : {}), supersedes, supersedes_unless_locked: true })
      // Judged by effect: UPDATE is reported only when the supersede landed.
      const landed = engram.id !== existing.id && ((engram as any).relations?.supersedes ?? []).includes(existing.id)
      if (!landed) {
        const now = await deps.getById(existing.id)
        if (now && (now as any).commitment === 'locked') {
          return await saveBesideLocked(deps, statement, context, now, engram)
        }
        return { engram, decision: 'ADD' }
      }
      appendHistory(deps.rootPath, {
        event: 'engram_updated',
        engram_id: existing.id,
        timestamp: new Date().toISOString(),
        data: { superseded_by: engram.id, new_statement: statement, reason: 'LLM dedup UPDATE: saved as a new memory that supersedes this one' },
        ...(dedupActor ? { actor: dedupActor } : {}),
      })
      return { engram, decision: 'UPDATE', existing_id: existing.id }
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
/** Options for learnAsync that callers other than learnBatch do not set. */
export interface LearnAsyncOptions {
  /**
   * Kept for callers that still pass it; it no longer changes anything. No
   * save rewrites an existing memory any more (owner decision 2026-10-18,
   * LRN-7): a MERGE answer is saved as its own memory linked to the one the
   * checker named, in a single save and a batch save alike, and UPDATE
   * supersedes in both (LRN-8).
   */
  neverOverwrite?: boolean
}

export async function learnAsync(
  deps: LearnAsyncDeps,
  statement: string,
  context?: LearnAsyncContext,
  opts: LearnAsyncOptions = {},
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
        // Join the neighbour's own text back on. `similarityScores` returns
        // id+score, but `candidates` is right here — and a report the reader
        // has to make another call to act on is a report that gets skipped
        // (2026-09-07: four near-identical engrams, every neighbour unread).
        const byId = new Map(candidates.map(c => [c.id, c]))
        nearDuplicates = scores.slice(0, 3).map(s => {
          const st = byId.get(s.id)?.statement
          return {
            ...s,
            ...(st ? { statement: st.length > 240 ? `${st.slice(0, 240)}…` : st } : {}),
          }
        })
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
  const executed = await executeDedupDecision(deps, statement, context, decision, targetId, opts)
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
 * Minimal record of an engram written earlier in the same learnBatch call.
 * Only the fields that learnAsync's dedup step reads are captured (#854):
 *   - buildDedupPrompt reads  {id, statement, type, domain}
 *   - scope filtering reads   {scope, status}
 *   - similarityScores reads  the Engram object (passed as candidate)
 *
 * The cast to Engram in the recall wrappers below is therefore safe as long
 * as no other consumer of `candidates` is introduced without updating this
 * interface. The alternative — storing full Engram objects — would require
 * re-loading the just-written engram and adds a store round-trip per ADD.
 */
interface BatchAccumulatorEntry {
  id: string
  statement: string
  type: string
  domain?: string
  scope?: string
  status: 'active'
  /**
   * REQUIRED, not optional, and the reason is a silent failure rather than a
   * type nicety. These entries are spliced into the dedup candidate list and
   * reach `engramSearchText`, which reads `engram.tags.length` unguarded. On an
   * entry without `tags` that throws, the throw is swallowed by the surrounding
   * catch, and the run drops to hash-only dedup for every batch item after the
   * first — silently, whenever embeddings are on and no LLM key is present,
   * which is the normal configuration. Carrying the real tags also makes the
   * accumulated candidates score the way indexed ones do.
   */
  tags: string[]
}

/**
 * Batch learn: process multiple statements sequentially with LLM dedup.
 *
 * Never overwrites (owner decision 2026-10-18): a MERGE answer is saved as a
 * new memory linked to the one the checker named (see
 * LearnAsyncOptions.neverOverwrite), an UPDATE answer as a new memory that
 * supersedes it (LRN-8; a locked one goes to review, LRN-9); NOOP still
 * writes nothing.
 *
 * LLM dedup calls are bounded by opts.maxLlmCalls (default 50). The cap only
 * bites on large batches of novel-but-similar statements — exact-hash NOOPs
 * and zero-candidate ADDs short-circuit before the LLM and don't consume budget.
 *
 * In-batch near-duplicate detection (#854): _syncIndex() is fire-and-forget,
 * so the BM25/embedding index does not contain statement i when statement i+N
 * is being processed. To catch new-vs-new near-duplicates, learnBatch maintains
 * a `batchAccumulator` of engrams written so far and splices them into the
 * recall results that learnAsync sees, before the dedup step runs. This keeps
 * _syncIndex fire-and-forget (no blocking flush required).
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

  // In-batch accumulator (#854): collects every engram written (ADD decision)
  // earlier in this learnBatch call. Spliced into recall results so the dedup
  // step can see new-vs-new near-duplicates before the index is flushed.
  const batchAccumulator: BatchAccumulatorEntry[] = []

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

    // Per-statement deps that splice in-batch accumulator entries into the
    // recall results so learnAsync's dedup step sees earlier batch writes even
    // before _syncIndex() has flushed (#854). The accumulator entries are
    // appended AFTER the index results so index-resident engrams rank first;
    // dedup trims to its `limit` anyway so duplicates across both lists are
    // harmless. Dedup-up to the caller's scope filter still runs inside
    // learnAsync — the accumulator entries carry `scope` and `status` for it.
    //
    // #930: use learnRouted (if available) as the ADD-path learn function.
    // learnRouted awaits the server push and returns the server-assigned id,
    // so every result in the batch gets a distinct, correct id. With the plain
    // `learn` path the fire-and-forget outbox deletes the local copy after a
    // successful push; the next generateEngramId call finds the same slot free
    // and produces the same id for every item. The effect is that all N items
    // report a single id that does not exist in any store once all pushes
    // complete (#930, defect 2). learnRouted's own hash-dedup and cross-scope
    // recurrence checks are redundant (learnAsync already ran them) but cheap.
    const effectiveLearn = deps.learnRouted ?? deps.learn
    const batchDeps: LearnAsyncDeps = {
      ...deps,
      learn: effectiveLearn,
      ...(batchAccumulator.length === 0 ? {} : {
        recallHybrid: async (query: string, options?: { limit?: number }) => {
          const indexResults = await deps.recallHybrid(query, options)
          // Cast is safe: learnAsync only reads {id,statement,type,domain,scope,status} from candidates.
          const extra = batchAccumulator.filter(e => !indexResults.some(r => r.id === e.id))
          return [...indexResults, ...extra as unknown as Engram[]]
        },
        recall: async (query: string, options?: { limit?: number }) => {
          const indexResults = await deps.recall(query, options)
          const extra = batchAccumulator.filter(e => !indexResults.some(r => r.id === e.id))
          return [...indexResults, ...extra as unknown as Engram[]]
        },
      }),
    }

    const ctx: LearnAsyncContext = { ...context, llm: effectiveLlm }
    // Partial-failure isolation (batch API, #281 item #3): one statement's
    // failure must not abort the batch — an orchestrator persisting 50
    // consolidated findings should keep the 49 that succeed. Capture the error
    // against its input index and continue; the caller inspects `failures`.
    try {
      // Batch learning never overwrites an existing memory (owner decision
      // 2026-10-18): a MERGE answer becomes a linked ADD, an UPDATE answer a
      // new memory that supersedes the old one (LRN-8).
      const result = await learnAsync(batchDeps, statement, ctx, { neverOverwrite: true })
      // Tag with the input position so a caller can map this result back to its
      // input even though `results` is compacted (failed statements absent). #281
      results.push({ ...result, input_index: i })
      const key = result.decision.toLowerCase()
      if (key === 'noop') stats.noops++
      else if (key === 'merge') stats.merged++
      else {
        if (key === 'update') stats.updated++
        else stats.added++
        // Record newly written engrams in the accumulator so subsequent
        // statements in this batch can dedup against them (#854). ADD writes a
        // new engram, and so does UPDATE, which saves the statement as a new
        // memory superseding the old one (LRN-8); NOOP points at an existing
        // engram already in the index, and batch MERGE is saved as an ADD.
        batchAccumulator.push({
          id: result.engram.id,
          statement: result.engram.statement,
          type: result.engram.type ?? 'observation',
          domain: result.engram.domain,
          scope: result.engram.scope,
          status: 'active',
          tags: result.engram.tags ?? [],
        })
      }
    } catch (err) {
      stats.failed++
      failures.push({ index: i, statement, error: err instanceof Error ? err.message : String(err) })
      logger.warning(`learnBatch: statement ${i} failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { results, stats, failures }
}
