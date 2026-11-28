import { Plur } from '../index.js'
import type { EnrichApplyResult, EnrichPlan, EnrichPlanItem } from './types.js'


import { ENRICHER_VERSION, ENRICH_KINDS, type EnrichLabel, buildEnrichPrompt, enrichRow, isEnriched, parseEnrichReply } from '../enrich.js'
import { type Engram } from '../schemas/engram.js'
import { type LlmFunction } from '../types.js'
import { computeContentHash } from '../content-hash.js'
import { detectSecrets } from '../secrets.js'
import { logger } from '../logger.js'
export interface EnrichmentMethods {
  /**
   * Ask a host-supplied model to label every active, not-yet-enriched engram
   * of the local primary store (W10). Returns a plan; changes nothing. The
   * model is called here, outside any store lock. Core never chooses or calls
   * a model on its own — `llm` is the caller's.
   */
  planEnrichment(options: { llm: LlmFunction; model: string; limit?: number; batchSize?: number; onBatch?: (done: number, total: number) => void }): Promise<EnrichPlan>

  /**
   * Apply an enrichment plan through the change journal (W10): adds
   * `structured_data.enrichment` only; the statement and `knowledge_type`
   * are never touched. Skips, per item, a row that is gone, not active, already
   * enriched (so a second run changes nothing) or whose statement changed
   * since the plan. One journalled change; nothing journalled when nothing
   * applies. `limit` stops after that many rows.
   */
  applyEnrichmentPlan(plan: EnrichPlan, options?: { limit?: number }): Promise<EnrichApplyResult>
}

export const enrichmentMethods: EnrichmentMethods & ThisType<Plur> = {
  async planEnrichment(options: { llm: LlmFunction; model: string; limit?: number; batchSize?: number; onBatch?: (done: number, total: number) => void }): Promise<EnrichPlan> {
    // Memory text goes to a model: never from a remote-only folder.
    this._remoteOnlyRefuseLocalStore('Enriching personal memories (run it outside the remote-only folder)')
    const { llm, model } = options
    if (typeof llm !== 'function') throw new TypeError('planEnrichment: llm is required')
    const batchSize = Math.max(1, Math.min(100, options.batchSize ?? 20))
    const primary = await this._loadCached(this.paths.engrams)
    // Only active, current, locally owned rows go to the model — the same
    // exclusion consolidation uses (S9): never a row queued for a team store
    // or living in a scope a team store serves.
    let todo = primary.filter(e => typeof e.statement === 'string' && e.statement.trim()
      && !isEnriched(e) && !Plur._isRemoteOnlyQueued(e) && this._consolidationExclusion(e) === null)
    const alreadyEnriched = primary.filter(e => e.status === 'active' && isEnriched(e)).length
    if (options.limit !== undefined) todo = todo.slice(0, Math.max(0, options.limit))
    const items: EnrichPlanItem[] = []
    let unlabelled = 0
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize)
      let labels = new Map<string, EnrichLabel>()
      try {
        labels = parseEnrichReply(await llm(buildEnrichPrompt(batch)), batch.map(e => e.id))
      } catch (err) {
        logger.warning(`[plur] enrich: a model call failed (${(err as Error).message}); ${batch.length} engram(s) left unlabelled`)
      }
      for (const e of batch) {
        const label = labels.get(e.id)
        if (!label) { unlabelled++; continue }
        items.push({
          id: e.id,
          statement_hash: computeContentHash(e.statement),
          ...label,
          statement: e.statement.length > 120 ? e.statement.slice(0, 117) + '...' : e.statement,
        })
      }
      options.onBatch?.(Math.min(i + batchSize, todo.length), todo.length)
    }
    return {
      version: 1,
      kind: 'plur.enrich-plan',
      created_at: new Date().toISOString(),
      enricher: { model, version: ENRICHER_VERSION },
      items,
      skipped: { already_enriched: alreadyEnriched, unlabelled },
    }
  },

  async applyEnrichmentPlan(plan: EnrichPlan, options: { limit?: number } = {}): Promise<EnrichApplyResult> {
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Applying an enrichment plan (run it outside the remote-only folder)')
    if (!plan || plan.kind !== 'plur.enrich-plan' || !Array.isArray(plan.items) || !plan.enricher?.model) {
      throw new TypeError('applyEnrichmentPlan: not an enrichment plan (expected kind "plur.enrich-plan")')
    }
    const limit = options.limit ?? Infinity
    if (!(limit >= 1)) throw new TypeError('applyEnrichmentPlan: limit must be at least 1')
    const at = plan.created_at.slice(0, 10)
    const decide = (get: (id: string) => Engram | undefined) => {
      const rows: Engram[] = []
      const skipped: EnrichApplyResult['skipped'] = []
      for (const item of plan.items) {
        if (rows.length >= limit) break
        const row = get(item.id)
        if (!row) { skipped.push({ id: item.id, reason: 'not in the local primary store' }); continue }
        if (row.status !== 'active') { skipped.push({ id: item.id, reason: `not active (${row.status})` }); continue }
        if (isEnriched(row)) { skipped.push({ id: item.id, reason: 'already enriched' }); continue }
        const excluded = this._consolidationExclusion(row)
        if (excluded) { skipped.push({ id: item.id, reason: `not a locally owned current row (${excluded})` }); continue }
        if (computeContentHash(row.statement) !== item.statement_hash) { skipped.push({ id: item.id, reason: 'statement changed since the plan' }); continue }
        if (!(ENRICH_KINDS as readonly string[]).includes(item.kind)) { skipped.push({ id: item.id, reason: `invalid kind ${String(item.kind)}` }); continue }
        // The plan file is input like a model reply (S7): the same parser's
        // bounds apply (known kind, family and outcome; at most 15 words of
        // applies_when), and a label that would carry a secret or text the
        // row's scope may not hold is refused.
        const label = parseEnrichReply(JSON.stringify([{
          id: item.id, kind: item.kind, task_family: item.task_family, outcome: item.outcome ?? 'none', applies_when: item.applies_when ?? '',
        }]), [item.id]).get(item.id)
        if (!label) { skipped.push({ id: item.id, reason: 'invalid label' }); continue }
        const labelText = label.applies_when ?? ''
        if (labelText && (detectSecrets(labelText).length > 0 || this._offendingHitsForScope(labelText, row.scope).length > 0)) {
          skipped.push({ id: item.id, reason: 'sensitive: the label would carry a secret or text this scope may not hold' })
          continue
        }
        rows.push(enrichRow(row, label, plan.enricher, at))
      }
      return { rows, skipped }
    }
    const primary = await this._loadCached(this.paths.engrams)
    const index = new Map(primary.map(e => [e.id, e]))
    const preview = decide(id => index.get(id))
    if (preview.rows.length === 0) return { change: null, applied: [], skipped: preview.skipped }
    let inLock: ReturnType<typeof decide> = { rows: [], skipped: [] }
    const change = await this.beginChange('enrich.apply', { enricher: plan.enricher, plan_created_at: plan.created_at, limit: options.limit ?? null })
      .apply(tx => {
        inLock = decide(id => tx.get(id))
        for (const row of inLock.rows) tx.put(row)
      })
    return {
      change,
      applied: inLock.rows.map(r => ({ id: r.id, kind: (r.structured_data as any).enrichment.kind })),
      skipped: inLock.skipped,
    }
  },
}
