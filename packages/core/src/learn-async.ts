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

/**
 * Batch learn: process multiple statements sequentially with LLM dedup.
 */
export async function learnBatch(
  deps: LearnAsyncDeps,
  statements: Array<{ statement: string; context?: LearnAsyncContext }>,
  llm?: LlmFunction,
): Promise<LearnBatchResult> {
  const results: LearnAsyncResult[] = []
  const stats = { added: 0, updated: 0, merged: 0, noops: 0 }

  for (const { statement, context } of statements) {
    const ctx: LearnAsyncContext = { ...context, llm: context?.llm ?? llm }
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
