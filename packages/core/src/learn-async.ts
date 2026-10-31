/**
 * Async learning with LLM-driven deduplication.
 */
import { buildDedupPrompt, parseDedupResponse } from './dedup.js'
import { appendHistory } from './history.js'
import { logger } from './logger.js'
import { searchTextFrom } from './fts.js'
import { isRemoteOnlyQueued } from './remote-only-rows.js'
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
 * where a future write gate might sit. Raising this narrows the evidence such
 * a gate would be chosen from.
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
   * Routed learn for the ADD path in learnBatch. When present, learnBatch uses
   * this instead of `learn` so remote-scope writes await the server push and
   * return the server-assigned id. With `learn`, the fire-and-forget outbox
   * deletes the local copy after a successful push, so the next
   * generateEngramId finds the same slot free and every item in the batch
   * gets the same id.
   */
  learnRouted?: (statement: string, context?: LearnContext) => Promise<Engram>
  /** Get engram by ID. */
  getById: (id: string) => Promise<Engram | null>
  /**
   * Source of truth for primary engram state. The UPDATE/MERGE paths read and
   * write through this rather than loadEngrams/saveEngrams on `engramsPath`,
   * so a non-YAML primary store works here too.
   */
  store: AsyncPrimaryStore
  /**
   * Paths. `engramsPath` is the LOCK KEY for `withAsyncLock` only; it is not
   * used to read or write engram state.
   */
  engramsPath: string
  rootPath: string
  /** Dedup config. */
  dedupConfig: { enabled?: boolean; threshold?: number; mode?: string }
  /**
   * Local similarity scores for `statement` against `candidates`.
   *
   * OPTIONAL: when absent — embedder disabled, or a caller constructing deps by
   * hand — dedup degrades to hash-only and says so in the result.
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
   * Leak guard predicate. Returns the offending sensitivity hits when
   * `statement` carries content the SHARED `scope` forbids, else `[]` (always
   * `[]` for personal/local scopes). Single source of truth lives on the Plur
   * class as `_offendingHitsForScope`; injected here so the UPDATE/MERGE paths
   * can demote a mutated engram before it is written back to a shared store.
   */
  offendingHitsForScope: (statement: string, scope: string) => SecretMatch[]
  /**
   * True when a save to `scope` is sent to a server (a writable url store
   * serves it). An unscoped save never inherits such a scope from a dedup
   * target. Absent: no scope is treated as server-backed.
   */
  sendsToServer?: (scope: string) => boolean
  /**
   * Put a pair in the user's review queue: a tension record with
   * status `detected`, the queue plur_tensions lists and the user resolves.
   * Returns the record id. Optional so hand-built deps keep working; without
   * it an UPDATE onto a locked memory still saves the new statement.
   */
  openReview?: (pair: TensionPair) => Promise<string | undefined>
  /**
   * Turn an already-saved memory into a draft (`commitment: 'draft'`: stored
   * and searchable, never injected). Used when a memory became locked between
   * the read and the save, so the statement was saved before the lock was
   * seen. Optional so hand-built deps keep working.
   */
  holdAsDraft?: (id: string) => Promise<void>
}


/**
 * The duplicate checker said UPDATE onto a locked memory. The locked memory is
 * left untouched; the new statement is saved as a draft (searchable, never
 * injected) with a `detected` tension linking the two for user review.
 * Resolving for the new one makes it normal (Plur.resolveTension), resolving
 * for the locked one retires it, dismissing leaves a draft. No setting skips review.
 */
async function saveBesideLocked(
  deps: LearnAsyncDeps,
  statement: string,
  context: LearnContext | undefined,
  locked: Engram,
  alreadySaved?: Engram,
): Promise<LearnAsyncResult> {
  let engram: Engram
  const problems: string[] = []
  if (alreadySaved) {
    engram = alreadySaved
    // Saved as a normal memory before the lock was seen: hold it back now.
    if (engram.id !== locked.id && engram.commitment !== 'draft' && deps.holdAsDraft) {
      // learn() already saves it as a draft when it sees the lock under the
      // store lock; this is the fallback for a lock it could not see.
      try {
        await deps.holdAsDraft(engram.id)
        engram = { ...engram, commitment: 'draft' }
      } catch (err) {
        logger.warning(`could not hold ${engram.id} back as a draft while its review waits: ${err}`)
        problems.push(`${engram.id} could not be held back as a draft: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } else {
    engram = await deps.learn(statement, { ...context, commitment: 'draft' })
  }
  let tensions: string[] | undefined
  if (deps.openReview && engram.id !== locked.id) {
    const pair = {
      id_a: locked.id,
      id_b: engram.id,
      statement_a: locked.statement,
      statement_b: engram.statement,
      confidence: 1,
      reason: `The duplicate checker said ${engram.id} updates ${locked.id}, which is locked. ` +
        `A locked memory is not superseded automatically, so both are kept and this pair waits for review.`,
    }
    // The draft is only reachable through this review, so opening
    // it is retried once, and a failure is REPORTED in the result (and logged):
    // a caller told nothing would believe the pair is waiting for the user.
    let lastErr: unknown
    for (let attempt = 0; attempt < 2 && !tensions; attempt++) {
      try {
        const id = await deps.openReview(pair)
        if (id) tensions = [id]
        else lastErr = new Error('the review queue returned no record')
      } catch (err) {
        lastErr = err
      }
    }
    if (!tensions) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
      logger.warning(`could not open a review item for ${locked.id} and ${engram.id}: ${msg}`)
      problems.push(
        `The review item for ${locked.id} and ${engram.id} could not be opened (${msg}). ` +
        `${engram.id} is saved as a draft and is not given to the agent until it is reviewed; ` +
        `open the review again or resolve it by hand.`,
      )
    }
  }
  return {
    engram,
    decision: 'ADD',
    existing_id: locked.id,
    ...(tensions ? { tensions } : {}),
    ...(problems.length ? { review_error: problems.join(' ') } : {}),
  }
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
  // No save overwrites an existing memory. A MERGE answer from the duplicate
  // checker means "related, both worth keeping", so the incoming statement is
  // saved as its own memory, linked to the one the checker named
  // (`relations.related`, forward edge only), and the result says so. The
  // existing memory is not touched: not its text, not its tags, not its
  // version. A real duplicate is the checker's NOOP; a changed value is its
  // UPDATE, which supersedes (below) and never rewrites either.
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
  // Name the model behind a dedup verdict. A model rewrote the
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
      // A changed value is saved as its own memory that supersedes the old one:
      // the old text is never rewritten, it is marked `superseded_by` the new
      // memory and stops being injected (the LearnContext.supersedes path). A
      // LOCKED target is never superseded automatically: it stays as it is,
      // the new statement is saved, and the pair goes to the review queue.
      const existing = targetId ? await deps.getById(targetId) : null
      if (!existing || existing.status !== 'active') {
        return { engram: await deps.learn(statement, context), decision: 'ADD' }
      }
      if ((existing as any).commitment === 'locked') {
        return await saveBesideLocked(deps, statement, context, existing)
      }
      // A save queued from a remote-only folder is never superseded by a dedup
      // decision: it is delivered or forgotten as it was saved, so the reverse
      // edge would be a local rewrite of it. Saved beside it, unlinked.
      if (isRemoteOnlyQueued(existing)) {
        return { engram: await deps.learn(statement, context), decision: 'ADD' }
      }
      // An unscoped save stays where an unscoped save goes. Taking the scope
      // of a memory on a team server would send a personal statement there
      // because the checker tied it to a team memory,
      // so it is saved as its own memory, linked as a likely duplicate.
      if (context?.scope === undefined && existing.scope && deps.sendsToServer?.(existing.scope)) {
        const related = [...new Set([...(context?.related ?? []), existing.id])]
        return {
          engram: await deps.learn(statement, { ...context, related }),
          decision: 'ADD',
          likely_duplicate_of: {
            id: existing.id,
            checker_decision: 'UPDATE' as const,
            note:
              `The duplicate checker said this updates ${existing.id}, which is a team memory on a server. ` +
              `This save named no scope, so it was kept where an unscoped save goes and linked to ${existing.id}; ` +
              `${existing.id} is unchanged. To replace it, save again with scope ${existing.scope}.`,
          },
        }
      }
      const supersedes = [...new Set([...(context?.supersedes ?? []), existing.id])]
      // The replacement lives where the memory it replaces lives, unless the
      // caller named a scope (candidates are then already filtered to it).
      // learn()'s own sensitive-content guard still runs on the new memory.
      const scope = context?.scope ?? existing.scope
      // An inherited scope brings the target's privacy with it: learn() keeps
      // a team-scope memory on this machine only when the save says private,
      // so without this a private team memory's replacement is sent to the
      // team server.
      const visibility = context?.visibility
        ?? (context?.scope === undefined && (existing as any).visibility === 'private' ? 'private' as const : undefined)
      // `supersedes_unless_locked`: learn() re-checks the lock under the store
      // lock, so a memory locked after the read above is not superseded either.
      const engram = await deps.learn(statement, { ...context, ...(scope ? { scope } : {}), ...(visibility ? { visibility } : {}), supersedes, supersedes_unless_locked: true })
      // Judged by effect: UPDATE is reported only when BOTH edges
      // landed — the forward edge on the new memory and the reverse edge on the
      // target, read back from the target's own store — because the reverse
      // edge is what stops the old memory being injected.
      const now = engram.id !== existing.id ? await deps.getById(existing.id) : null
      const forward = engram.id !== existing.id && ((engram as any).relations?.supersedes ?? []).includes(existing.id)
      // A target in another store names the new memory by a primary-qualified
      // id, so an edge counts when it RESOLVES to the new memory.
      const reverse: string[] = (now as any)?.relations?.superseded_by ?? []
      const landed = forward && (reverse.includes(engram.id)
        || (await Promise.all(reverse.map(id => deps.getById(id)))).some(r => r?.id === engram.id))
      if (!landed) {
        // learn() saw the lock under the store lock and saved a draft.
        if (now && ((now as any).commitment === 'locked' || (!forward && engram.commitment === 'draft' && context?.commitment !== 'draft'))) {
          return await saveBesideLocked(deps, statement, context, now, engram)
        }
        const linked = ((engram as any).relations?.related ?? []).includes(existing.id)
        return {
          engram,
          decision: 'ADD',
          ...(linked ? {
            likely_duplicate_of: {
              id: existing.id,
              checker_decision: 'UPDATE' as const,
              note:
                `The duplicate checker said this updates ${existing.id}, but ${existing.id} is held where this ` +
                `install cannot mark it replaced (a read-only store or a pack), so it would still be given to the ` +
                `agent. This was saved as its own memory linked to ${existing.id}; ${existing.id} is unchanged.`,
            },
          } : {}),
        }
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

/** Options for learnAsync that callers other than learnBatch do not set. */
export interface LearnAsyncOptions {
  /**
   * Accepted for compatibility; it has no effect. No save rewrites an
   * existing memory: a MERGE answer is saved as its own memory linked to the
   * one the checker named, and UPDATE supersedes.
   */
  neverOverwrite?: boolean
}

export async function learnAsync(
  deps: LearnAsyncDeps,
  statement: string,
  context?: LearnAsyncContext,
  opts: LearnAsyncOptions = {},
): Promise<LearnAsyncResult> {
  // Step 1: Content hash fast-path (scope-aware)
  const hashMatch = await deps.hashDedup(statement, context?.scope)
  if (hashMatch) {
    return { engram: hashMatch, decision: 'NOOP', existing_id: hashMatch.id }
  }

  // Step 2: Check dedup config
  // `threshold` is a REPORTING floor, not a write gate: cosine similarity never
  // suppresses a write (see step 4). Measured with the shipped embedder, real
  // under-contexted duplicates score below distinct pairs, so no threshold
  // separates them. 0.85 is a deliberately low floor to capture the band.
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
  // Mirror hashDedup scope-awareness: only dedup against same-scope engrams.
  // Without this, a global engram silently absorbs an explicitly-scoped write — the requested
  // scope is dropped and the team store never receives the engram.
  if (context?.scope) {
    candidates = candidates.filter(c => c.scope === context.scope)
  }

  if (candidates.length === 0) {
    return { engram: await deps.learn(statement, context), decision: 'ADD' }
  }

  // Step 4: decide — LLM if one is available, otherwise local cosine.
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
      // 0.8512 enriched; duplicate 0.9689 -> 0.9878).
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
        // id+score, but `candidates` is right here, and a report the reader
        // must make another call to act on tends to go unread.
        const byId = new Map(candidates.map(c => [c.id, c]))
        nearDuplicates = scores.slice(0, 3).map(s => {
          const st = byId.get(s.id)?.statement
          return {
            ...s,
            ...(st ? { statement: st.length > 240 ? `${st.slice(0, 240)}…` : st } : {}),
          }
        })
        // REPORTING ONLY — cosine never gates a write. Only the incoming side is
        // enriched, so real duplicates can score below distinct pairs, and a
        // guessed bar risks a false NOOP (a memory silently not stored — the
        // worst outcome). Observations are recorded to build a distribution.
        // Because nothing NOOPs here, a team-routed write cannot be absorbed by
        // a `global` near-duplicate either.
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
                // The context asymmetry described above. Recorded per write so the
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
   * bulk imports — a 1000-statement batch does not trigger 1000 LLM calls.
   * Defaults to 50. Pass Infinity to opt out.
   */
  maxLlmCalls?: number
}

/**
 * Minimal record of an engram written earlier in the same learnBatch call,
 * holding only what learnAsync's dedup step reads (buildDedupPrompt: id,
 * statement, type, domain; scope filtering: scope, status; similarityScores:
 * the object as candidate). The cast to Engram below is safe only while no
 * other consumer of `candidates` is added without updating this interface.
 */
interface BatchAccumulatorEntry {
  id: string
  statement: string
  type: string
  domain?: string
  scope?: string
  status: 'active'
  /**
   * REQUIRED: these entries reach `engramSearchText`, which reads
   * `engram.tags.length` unguarded. A missing `tags` would throw inside a
   * swallowing catch and silently drop the rest of the batch to hash-only
   * dedup. Real tags also make accumulated candidates score the way indexed
   * ones do.
   */
  tags: string[]
}

/**
 * Batch learn: process multiple statements sequentially with LLM dedup.
 * - Never overwrites: MERGE saves a new linked memory, UPDATE a new memory that
 *   supersedes (locked: goes to review), NOOP writes nothing.
 * - LLM calls are capped by opts.maxLlmCalls (default 50); exact-hash NOOPs and
 *   zero-candidate ADDs do not consume budget.
 * - _syncIndex() is fire-and-forget, so a `batchAccumulator` of engrams written
 *   so far is spliced into recall results to catch new-vs-new near-duplicates.
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

  // In-batch accumulator: collects every engram written (ADD decision)
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

    // Per-statement deps that splice accumulator entries into recall results
    // (after index results, so index-resident engrams rank first); the caller's
    // scope filter still runs inside learnAsync on their `scope`/`status`.
    // learnRouted (if available) awaits the server push and returns the
    // server-assigned id, so every batch result gets a distinct, correct id.
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
    // Partial-failure isolation: one statement's
    // failure must not abort the batch — an orchestrator persisting 50
    // consolidated findings should keep the 49 that succeed. Capture the error
    // against its input index and continue; the caller inspects `failures`.
    try {
      // Batch learning never overwrites an existing memory: a MERGE answer
      // becomes a linked ADD, an UPDATE answer a new memory that supersedes.
      const result = await learnAsync(batchDeps, statement, ctx, { neverOverwrite: true })
      // Tag with the input position so a caller can map this result back to its
      // input even though `results` is compacted (failed statements absent).
      results.push({ ...result, input_index: i })
      const key = result.decision.toLowerCase()
      if (key === 'noop') stats.noops++
      else if (key === 'merge') stats.merged++
      else {
        if (key === 'update') stats.updated++
        else stats.added++
        // Record newly written engrams in the accumulator so subsequent
        // statements in this batch can dedup against them. ADD writes a new
        // engram, and so does UPDATE (a new memory superseding the old one);
        // NOOP points at an existing engram already in the index, and MERGE is
        // saved as an ADD.
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
