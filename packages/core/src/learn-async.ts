/**
 * Async learning with LLM-driven deduplication (Ideas 1+2+19).
 * Separated from index.ts to avoid merge conflicts with parallel SPs.
 */
import { loadEngrams, saveEngrams } from './engrams.js'
import { computeContentHash } from './content-hash.js'
import { buildDedupPrompt, parseDedupResponse } from './dedup.js'
import { appendHistory } from './history.js'
import { logger } from './logger.js'
import { withLock } from './sync.js'
import type { Engram } from './schemas/engram.js'
import type { SecretMatch } from './secrets.js'
import type { LearnContext, LearnAsyncContext, LearnAsyncResult, LearnBatchResult, DedupDecision, LlmFunction } from './types.js'

export interface LearnAsyncDeps {
  /** Content hash dedup against all engrams. Scope-aware: only matches same scope. */
  hashDedup: (statement: string, scope?: string) => Engram | null
  /** Hybrid recall for semantic similarity. */
  recallHybrid: (query: string, options?: { limit?: number }) => Promise<Engram[]>
  /** BM25 recall fallback. */
  recall: (query: string, options?: { limit?: number }) => Engram[]
  /** Sync learn for the ADD path. */
  learn: (statement: string, context?: LearnContext) => Engram
  /** Get engram by ID. */
  getById: (id: string) => Engram | null
  /** Paths. */
  engramsPath: string
  rootPath: string
  /** Dedup config. */
  dedupConfig: { enabled?: boolean; threshold?: number; mode?: string }
  /** Circuit breaker check. */
  isLlmAvailable: () => boolean
  /** Record LLM success. */
  recordLlmSuccess: () => void
  /** Record LLM failure. */
  recordLlmFailure: () => void
  /** Sync index after write. */
  syncIndex: () => void
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
 * Demote an engram in place when its (post-mutation) statement carries content
 * the engram's shared scope forbids. Local write, so demotion is coherent:
 * scope→'local', visibility→'private'. Warns naming the offending patterns,
 * mirroring `_guardSensitiveScope`'s warning style. No-op (returns the engram
 * unchanged) when there are no offending hits. (#353)
 */
function demoteIfSensitive(
  deps: LearnAsyncDeps,
  engram: any,
  newStatement: string,
): void {
  const offending = deps.offendingHitsForScope(newStatement, engram.scope ?? 'global')
  if (offending.length === 0) return
  const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
  logger.warning(
    `[plur] sensitive content (${patterns}) held back from shared scope "${engram.scope}" — ` +
    `demoted to local/private so it is not written to a shared store. ` +
    `Re-scope deliberately if this is a false positive.`,
  )
  engram.scope = 'local'
  engram.visibility = 'private'
}

/**
 * Execute LLM-driven dedup decision.
 */
function executeDedupDecision(
  deps: LearnAsyncDeps,
  statement: string,
  context: LearnContext | undefined,
  decision: DedupDecision,
  targetId: string | null,
): LearnAsyncResult {
  switch (decision) {
    case 'NOOP': {
      if (targetId) {
        const existing = deps.getById(targetId)
        if (existing) return { engram: existing, decision: 'NOOP', existing_id: targetId }
      }
      return { engram: deps.learn(statement, context), decision: 'ADD' }
    }

    case 'UPDATE': {
      if (targetId) {
        const existing = deps.getById(targetId)
        if (existing && (existing as any).commitment !== 'locked') {
          return withLock(deps.engramsPath, () => {
            const engrams = loadEngrams(deps.engramsPath)
            const idx = engrams.findIndex(e => e.id === targetId)
            if (idx === -1) return { engram: deps.learn(statement, context), decision: 'ADD' as DedupDecision }
            const updated = { ...engrams[idx] } as any
            updated.statement = statement
            updated.content_hash = computeContentHash(statement)
            updated.version = (updated.version ?? 1) + 1
            updated.activation.last_accessed = new Date().toISOString().slice(0, 10)
            if (context?.tags) updated.tags = [...new Set([...updated.tags, ...context.tags])]
            // Leak guard (#353): a dedup UPDATE can introduce sensitive content
            // into an engram living at a shared scope. Demote before persisting.
            demoteIfSensitive(deps, updated, updated.statement)
            engrams[idx] = updated
            saveEngrams(deps.engramsPath, engrams)
            deps.syncIndex()
            appendHistory(deps.rootPath, {
              event: 'engram_updated',
              engram_id: targetId,
              timestamp: new Date().toISOString(),
              data: { old_statement: existing.statement, new_statement: statement, reason: 'LLM dedup UPDATE' },
            })
            return { engram: updated as Engram, decision: 'UPDATE' as DedupDecision, existing_id: targetId }
          })
        }
      }
      return { engram: deps.learn(statement, context), decision: 'ADD' }
    }

    case 'MERGE': {
      if (targetId) {
        const existing = deps.getById(targetId)
        if (existing && (existing as any).commitment !== 'locked') {
          return withLock(deps.engramsPath, () => {
            const engrams = loadEngrams(deps.engramsPath)
            const idx = engrams.findIndex(e => e.id === targetId)
            if (idx === -1) return { engram: deps.learn(statement, context), decision: 'ADD' as DedupDecision }
            const merged = { ...engrams[idx] } as any
            merged.statement = `${merged.statement} ${statement}`
            merged.content_hash = computeContentHash(merged.statement)
            merged.version = (merged.version ?? 1) + 1
            merged.activation.last_accessed = new Date().toISOString().slice(0, 10)
            if (context?.tags) merged.tags = [...new Set([...merged.tags, ...context.tags])]
            if (0.7 > merged.activation.retrieval_strength) merged.activation.retrieval_strength = 0.7
            // Leak guard (#353): a dedup MERGE concatenates the incoming
            // statement, which can introduce sensitive content into an engram at
            // a shared scope. Demote before persisting.
            demoteIfSensitive(deps, merged, merged.statement)
            engrams[idx] = merged
            saveEngrams(deps.engramsPath, engrams)
            deps.syncIndex()
            appendHistory(deps.rootPath, {
              event: 'engram_merged',
              engram_id: targetId,
              timestamp: new Date().toISOString(),
              data: { merged_statement: statement, reason: 'LLM dedup MERGE' },
            })
            return { engram: merged as Engram, decision: 'MERGE' as DedupDecision, existing_id: targetId }
          })
        }
      }
      return { engram: deps.learn(statement, context), decision: 'ADD' }
    }

    case 'ADD':
    default:
      return { engram: deps.learn(statement, context), decision: 'ADD' }
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
  const hashMatch = deps.hashDedup(statement, context?.scope)
  if (hashMatch) {
    return { engram: hashMatch, decision: 'NOOP', existing_id: hashMatch.id }
  }

  // Step 2: Check dedup config
  const { enabled = true, threshold = 0.85, mode = 'llm' } = deps.dedupConfig
  if (!enabled || mode === 'off') {
    return { engram: deps.learn(statement, context), decision: 'ADD' }
  }

  // Step 3: Semantic similarity search
  let candidates: Engram[] = []
  try {
    candidates = await deps.recallHybrid(statement, { limit: 5 })
  } catch {
    candidates = deps.recall(statement, { limit: 5 })
  }
  // Fallback to BM25 when hybrid returns empty (e.g. embedding model warmup on
  // cold CI runners makes embeddings return []; BM25 usually still matches).
  if (candidates.length === 0) {
    candidates = deps.recall(statement, { limit: 5 })
  }
  candidates = candidates.filter(c => c.status === 'active')

  if (candidates.length === 0) {
    return { engram: deps.learn(statement, context), decision: 'ADD' }
  }

  // Step 4: LLM or cosine-only decision
  const llm = context?.llm
  let decision: DedupDecision = 'ADD'
  let targetId: string | null = null

  if (mode === 'llm' && llm && deps.isLlmAvailable()) {
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
      logger.warning(`LLM dedup failed, falling back to cosine: ${err}`)
      deps.recordLlmFailure()
      decision = 'ADD'
    }
  }
  // cosine mode: conservative ADD (hash-only NOOP already handled)

  // Step 5: Execute
  return executeDedupDecision(deps, statement, context, decision, targetId)
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
  const stats = { added: 0, updated: 0, merged: 0, noops: 0 }

  const maxLlmCalls = opts.maxLlmCalls ?? 50
  let llmCallsUsed = 0
  let capWarned = false

  for (const { statement, context } of statements) {
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
          logger.warning(`learnBatch: maxLlmCalls (${maxLlmCalls}) reached — remaining statements use cosine/ADD dedup`)
          capWarned = true
        }
      } else {
        effectiveLlm = async (prompt: string) => { llmCallsUsed++; return stmtLlm(prompt) }
      }
    }

    const ctx: LearnAsyncContext = { ...context, llm: effectiveLlm }
    const result = await learnAsync(deps, statement, ctx)
    results.push(result)
    const key = result.decision.toLowerCase()
    if (key === 'noop') stats.noops++
    else if (key === 'update') stats.updated++
    else if (key === 'merge') stats.merged++
    else stats.added++
  }

  return { results, stats }
}
