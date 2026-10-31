import { computeContentHash } from '../content-hash.js'
import { legacyStorePrefix, parseNamespacedId, storePrefix } from '../engrams.js'
import { queryTimeline } from '../episodes.js'
import { normalizeIsoDate } from '../expiry.js'
import { countInjectionEvents, generateEventId, readHistoryForEngram } from '../history.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import { type OutboxSummary } from '../outbox-health.js'
import { listPacks } from '../packs.js'
import { gatherReceipt } from '../receipt-io.js'
import type { Receipt } from '../receipt.js'
import type { Engram } from '../schemas/engram.js'
import type { Episode } from '../schemas/episode.js'
import { engramDate } from '../tensions.js'
import type {
    LearnContext,
    LlmFunction
} from '../types.js'
import { StatusResult } from './types.js'

export interface StatusReportMethods {
/**
   * Promote an episode to an episodic engram (SP2 Idea 3).
   * Creates a new engram with memory_class='episodic' from an episode's summary.
   */
episodeToEngram(episodeId: string, context?: Omit<LearnContext, 'memory_class'>): Promise<Engram>

/**
   * Get history events for a specific engram (SP2 Idea 7).
   * Returns all events across all months for the given engram ID.
   */
getEngramHistory(engramId: string): import('../history.js').HistoryEvent[]

/**
   * An id plus the 0.21.0 spelling(s) of the same engram: for a current-form
   * store id, the old three-letter form records written before 0.21.1 carry.
   * Records keyed by id (history, tensions) match on this set. Not the
   * reverse — an old-form id was shared by every team store of an org (H1).
   */
/** @internal */
_idWithOldForms(engramId: string): Set<string>

/**
   * Report a failure for a procedural engram (SP2 Idea 18).
   * If LLM is provided, generates an improved procedure and updates the engram.
   * Without LLM, logs the failure without rewriting.
   * Returns the updated engram and the failure episode.
   */
reportFailure(engramId: string, failureContext: string, llm?: LlmFunction): Promise<{ engram: Engram; episode: Episode; evolved: boolean; blocked?: boolean }>

/** Return system health info. */
status(options?: { created_after?: string; domain?: string }): Promise<StatusResult>

/**
   * Counted report of what memory retrieved for this user — the "memory
   * receipt". Local and read-only: reads the primary engram store, installed
   * packs and the co_injection history, and transmits nothing.
   *
   * Scoped to LOCAL memory (primary store + installed packs). Remote/team
   * stores are deliberately excluded so the number is identical whether called
   * from the cold CLI or the warm MCP server; retrievals of team engrams are
   * reported separately as `external_retrieved` rather than counted as deleted.
   */
receipt(options?: { days?: number; now?: Date }): Promise<Receipt>
}

export const statusReportMethods: StatusReportMethods & ThisType<Plur> = {
async episodeToEngram(episodeId: string, context?: Omit<LearnContext, 'memory_class'>): Promise<Engram> {
    this._remoteOnlyRefuseLocalStore('Turning a timeline episode into a memory')
    const episodes = queryTimeline(this.paths.episodes)
    const episode = episodes.find(e => e.id === episodeId)
    if (!episode) throw new Error(`Episode not found: ${episodeId}`)

    const engram = await this.learn(episode.summary, {
      ...context,
      type: context?.type ?? 'behavioral',
      source: context?.source ?? `episode:${episodeId}`,
      memory_class: 'episodic',
      session_episode_id: episodeId,
    })

    this._appendHistory({
      event: 'engram_promoted',
      engram_id: engram.id,
      timestamp: new Date().toISOString(),
      data: { from_episode: episodeId },
    })

    return engram
  },

getEngramHistory(engramId: string): import('../history.js').HistoryEvent[] {
    // remote-only: history is personal-store bookkeeping.
    if (this._remoteOnly) return []
    // A team engram's events written before 0.21.1 are keyed by its old
    // three-letter id form; a lookup by its current id returns them too. Not
    // the reverse: an old-form id was shared by every team store of an org,
    // so it cannot say which store's new-form events are its own (H1).
    return readHistoryForEngram(this.paths.root, this._idWithOldForms(engramId))
  },

_idWithOldForms(engramId: string): Set<string> {
    const ids = new Set([engramId])
    const ns = parseNamespacedId(engramId, true)
    if (!ns) return ids
    for (const store of this.config.stores ?? []) {
      if (typeof store.scope !== 'string' || storePrefix(store.scope) !== ns.prefix) continue
      ids.add(ns.bare.replace(/^(ENG|ABS|META)-/, `$1-${legacyStorePrefix(store.scope)}-`))
    }
    return ids
  },

async reportFailure(engramId: string, failureContext: string, llm?: LlmFunction): Promise<{ engram: Engram; episode: Episode; evolved: boolean; blocked?: boolean }> {
    this._assertWritable()
    // A namespaced id evolves the engram in the one store it names (0.21.1 audit, H1).
    engramId = await this._resolveNamespacedId(engramId, 'evolve')
    const engram = await this.getById(engramId)
    if (!engram) throw new Error(`Engram not found: ${engramId}`)

    // Only procedural engrams can evolve
    const memClass = (engram as any).knowledge_type?.memory_class
    if (memClass !== 'procedural' && engram.type !== 'procedural') {
      throw new Error(`Only procedural engrams can evolve. This engram has type=${engram.type}, memory_class=${memClass}`)
    }

    // Rate limiting: max 3 revisions per procedure per 24h
    const history = readHistoryForEngram(this.paths.root, engramId)
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const recentEvolutions = history.filter(
      e => e.event === 'procedure_evolved' && e.timestamp > dayAgo
    )
    if (recentEvolutions.length >= 3) {
      throw new Error(`Rate limit: engram ${engramId} has been evolved ${recentEvolutions.length} times in the last 24h (max 3)`)
    }

    // Create failure episode
    const episode = this.capture(`Failure report for ${engramId}: ${failureContext}`, {
      tags: ['failure', 'procedure-evolution'],
    })

    // Log the failure event
    const failureEventId = generateEventId()
    this._appendHistory({
      event: 'failure_reported',
      engram_id: engramId,
      timestamp: new Date().toISOString(),
      data: { failure_context: failureContext, episode_id: episode.id, event_id: failureEventId },
    })

    // Try to evolve the procedure with LLM
    let evolved = false
    if (llm) {
      try {
        const prompt = `You are improving a procedural memory based on a failure report.

Current procedure: "${engram.statement}"
Failure report: "${failureContext}"
${recentEvolutions.length > 0 ? `\nPrevious revisions in last 24h: ${recentEvolutions.length}` : ''}

Generate an improved version of the procedure that prevents this failure. Return ONLY the improved procedure statement, nothing else.`

        const improved = await llm(prompt)
        if (improved && improved.trim().length > 0) {
          const eventId = generateEventId()
          const now = new Date().toISOString()

          // Try local primary first.
          const localResult = await this._withStoreLock(this.paths.engrams, async () => {
            const engrams = await this._primaryStore.load()
            const idx = engrams.findIndex(e => e.id === engramId)
            if (idx === -1) return null

            const raw = engrams[idx] as any
            // A save queued from a remote-only folder is not evolved: it is
            // delivered or forgotten as it was saved (re-audit 3 of #1521).
            if (Plur._isRemoteOnlyQueued(raw)) {
              logger.warning(`[plur] ${engramId} is a save queued from a remote-only folder; procedure evolution skips it until it is delivered.`)
              return { engram: engrams[idx], episode, evolved: false }
            }
            const oldStatement = raw.statement
            const oldVersion = raw.engram_version ?? 1

            raw.statement = improved.trim()
            // #852: the hash MUST follow the statement.
            //
            // This was the one statement-mutation path that did not recompute
            // it — learn-async's UPDATE and MERGE both do. A stale hash is not
            // cosmetic: `_hashDedup` matches on `content_hash`, so an engram
            // whose hash still describes its PRE-evolution text becomes an
            // attractor. A later write matching that old text hash-matches this
            // engram, which now says something else, and `_recordDuplicate`
            // absorbs the write into it — silently, since the engram is
            // returned as if it were the write's own. Measured on a real store:
            // 38 engrams carrying a hash that no longer matched their
            // statement, and one pair of distinct engrams sharing a hash.
            raw.content_hash = computeContentHash(raw.statement)
            // Leak guard (#353): the LLM-improved statement can introduce
            // sensitive content. This is a local write, so demotion is coherent:
            // hold it back from the shared scope by demoting to local/private.
            const localOffending = this._offendingHitsForScope(raw.statement, raw.scope ?? 'global')
            if (localOffending.length > 0) {
              const patterns = [...new Set(localOffending.map(h => h.pattern))].join(', ')
              logger.warning(
                `[plur] sensitive content (${patterns}) held back from shared scope "${raw.scope}" — ` +
                `demoted to local/private so it is not written to a shared store. ` +
                `Re-scope deliberately if this is a false positive.`,
              )
              raw.scope = 'local'
              raw.visibility = 'private'
            }
            raw.engram_version = oldVersion + 1
            raw.previous_version_ref = { event_id: eventId, changed_at: now }
            if (!raw.episode_ids) raw.episode_ids = []
            raw.episode_ids.push(episode.id)

            await this._writeEngrams(this.paths.engrams, engrams)
            await this._syncIndex()

            this._appendHistory({
              event: 'procedure_evolved',
              engram_id: engramId,
              timestamp: now,
              data: {
                event_id: eventId,
                old_statement: oldStatement,
                new_statement: improved.trim(),
                old_version: oldVersion,
                new_version: oldVersion + 1,
                failure_context: failureContext,
                failure_episode_id: episode.id,
              },
            })

            evolved = true
            return { engram: engrams[idx], episode, evolved }
          })
          if (localResult) return localResult

          // Remote routing (#86 reportFailure remainder): the engram lives
          // on a remote store. PATCH the new statement; history stays local.
          let blockedRemote = false
          for (const entry of (this.config.stores ?? [])) {
            if (!entry.url || entry.readonly === true) continue
            // remote-only: a personal or non-team url store is out of reach (re-audit 3, R3-4).
            if (this._remoteOnly && !this._remoteOnlyWalkAllows(entry.scope)) continue
            // Leak guard (#353): this is an AUTONOMOUS push to a shared/remote
            // store — there is no coherent demotion (we can't silently re-scope
            // someone else's remote engram). If the improved statement carries
            // content this scope forbids, SKIP the push entirely and warn. Never
            // throw: reportFailure is a background flow and must not crash.
            const remoteOffending = this._offendingHitsForScope(improved.trim(), entry.scope)
            if (remoteOffending.length > 0) {
              const patterns = [...new Set(remoteOffending.map(h => h.pattern))].join(', ')
              logger.warning(
                `[plur] sensitive content (${patterns}) blocked from remote shared scope "${entry.scope}" — ` +
                `procedure evolution NOT pushed. The remote engram is unchanged.`,
              )
              blockedRemote = true
              continue
            }
            const serverId = this._stripRemotePrefix(engramId, entry.scope)
            const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
            // The team store's host may also hold personal rows under the same token:
            // act on a bare id only when its row there is in a team scope (R3-4).
            if (this._remoteOnly && !(await this._remoteRowOwnedByTeam(driver, this._stripRemotePrefix(engramId, entry.scope)))) continue
            const patched = await driver.patch(serverId, { statement: improved.trim() })
            if (patched) {
              this._appendHistory({
                event: 'procedure_evolved',
                engram_id: engramId,
                timestamp: now,
                data: {
                  event_id: eventId,
                  old_statement: engram.statement,
                  new_statement: improved.trim(),
                  old_version: (engram as any).engram_version ?? 1,
                  new_version: ((engram as any).engram_version ?? 1) + 1,
                  failure_context: failureContext,
                  failure_episode_id: episode.id,
                  routed_to: 'remote',
                },
              })
              evolved = true
              return { engram: patched, episode, evolved }
            }
          }
          // Leak guard (#353): every candidate remote was skipped because the
          // improved statement was sensitive for its scope. The remote engram is
          // intentionally left unchanged — report a not-evolved/blocked outcome
          // (the failure episode is still linked below) instead of throwing.
          if (blockedRemote) {
            await this._withStoreLock(this.paths.engrams, async () => {
              const engrams = await this._primaryStore.load()
              const idx = engrams.findIndex(e => e.id === engramId)
              if (idx !== -1) {
                const raw = engrams[idx] as any
                if (!raw.episode_ids) raw.episode_ids = []
                raw.episode_ids.push(episode.id)
                await this._writeEngrams(this.paths.engrams, engrams)
                await this._syncIndex()
              }
            })
            return { engram, episode, evolved: false, blocked: true }
          }
          // Neither local nor remote had it — defensive fallback (should not
          // happen since getById succeeded at top of function).
          throw new Error(`Engram not found in any store: ${engramId}`)
        }
      } catch (err) {
        // The `try` above spans the LLM call AND the local/remote writes that
        // follow it, so a bare `catch` here reclassifies a genuine store
        // failure as "the LLM was unavailable" — swallowed, unlogged, and
        // reported to the caller as a successful not-evolved outcome. A write
        // that failed must not look like a model that declined.
        //
        // Not rethrown: this path's contract is best-effort evolution, and the
        // fallback below still links the failure episode. But it says so.
        logger.warning(
          `[plur] reportFailure: could not evolve ${engramId} — ${(err as Error).message}. `
          + `Falling back to linking the failure episode without rewriting.`,
        )
      }
    }

    // Fallback: link failure episode to engram without rewriting
    await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      const idx = engrams.findIndex(e => e.id === engramId)
      if (idx !== -1) {
        const raw = engrams[idx] as any
        if (!raw.episode_ids) raw.episode_ids = []
        raw.episode_ids.push(episode.id)
        await this._writeEngrams(this.paths.engrams, engrams)
        await this._syncIndex()
      }
    })

    const updated = await this.getById(engramId)
    return { engram: updated ?? engram, episode, evolved }
  },

async status(options?: { created_after?: string; domain?: string }): Promise<StatusResult> {
    // Every artifact this diagnostic reads is behind a refuse-on-corrupt loader,
    // and a diagnostic must REPORT a broken artifact rather than die on it
    // (audit 2026-08-03, finding 6). Each is isolated so one bad file cannot
    // suppress the rest of the report — which is the information an operator
    // needs precisely when one file IS bad.
    const storeErrors: Record<string, string> = {}
    const readOr = <T>(name: string, read: () => T, fallback: T): T => {
      try {
        return read()
      } catch (err) {
        storeErrors[name] = (err as Error).message
        return fallback
      }
    }
    const readOrAsync = async <T>(name: string, read: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await read()
      } catch (err) {
        storeErrors[name] = (err as Error).message
        return fallback
      }
    }
    // The corpus itself included: if engrams.yaml is the broken file, a thrown
    // status is the least useful possible response to "what is wrong?".
    const engrams = await readOrAsync('engrams', () => this._loadAllEngrams(), [] as Engram[])
    const episodes = readOr('episodes', () => queryTimeline(this.paths.episodes), [] as ReturnType<typeof queryTimeline>)
    const packs = readOr('packs', () => listPacks(this.paths.packs), [] as ReturnType<typeof listPacks>)

    let active = engrams.filter(e => e.status !== 'retired')
    if (options?.domain) {
      active = active.filter(e => e.domain?.startsWith(options.domain!))
    }
    if (options?.created_after) {
      // Validated, not trusted (#547). The comparison below is LEXICOGRAPHIC
      // against a `YYYY-MM-DD` stamp, which is exactly right for a well-formed
      // date and silently wrong for anything else: "last week" sorts after
      // every real date and returns 0, "2026-13-99" sorts after December and
      // does the same. A caller typo produced a confident, quietly wrong count
      // — the one failure a diagnostic must not have.
      //
      // Reuses `normalizeIsoDate` rather than adding a second date rule: it
      // already rejects both malformed shapes and impossible calendar dates
      // (2026-02-30), and one definition means the two cannot disagree.
      const cutoff = normalizeIsoDate(options.created_after)
      if (!cutoff) {
        throw new TypeError(
          `plur.status: created_after must be an ISO date (YYYY-MM-DD), got "${options.created_after}". `
          + `Dates are compared as strings, so a malformed value would return a silently wrong count.`,
        )
      }
      active = active.filter(e => { const d = engramDate(e); return d !== undefined && d >= cutoff })
    }
    const lockedCount = active.filter(e => (e as any).commitment === 'locked').length
    // #181 (audit #213 C2): tension_count counts UNRESOLVED persisted
    // tension records — the LLM-validated detector's output — instead of
    // relations.conflicts, which post-#138 holds only unvalidated importer
    // heuristics (or nothing, post-purge).
    const unresolvedTensions = readOr(
      'tensions',
      () => this.listTensions({ status: ['detected', 'confirmed'] }).length,
      0,
    )

    // Count engrams with version > 1 (SP2 Idea 8)
    const versionedCount = engrams.filter(e => {
      const raw = e as any
      return (raw.engram_version ?? 1) > 1
    }).length

    return {
      engram_count: active.length,
      episode_count: episodes.length,
      pack_count: packs.length,
      storage_root: this.paths.root,
      provenance_identity: this._configuredIdentity() ?? 'agent:unidentified',
      config: this.config,
      locked_count: lockedCount,
      tension_count: unresolvedTensions,
      versioned_engram_count: versionedCount,
      outbox_count: await readOrAsync('outbox', () => this.outboxCount(), 0),
      ...(await (async () => {
        const summary = await readOrAsync('outbox', () => this.outboxSummary(), undefined as OutboxSummary | undefined)
        if (!summary) return {}
        return {
          outbox_needs_action: summary.needs_action,
          ...(summary.needs_action > 0 ? { outbox_attention: summary.scopes } : {}),
          ...(summary.held?.length ? { outbox_held: summary.held } : {}),
        }
      })()),
      history_events: readOr('history', () => countInjectionEvents(this.paths.root), undefined as any),
      ...(this._lastIndexError ? { index_error: this._lastIndexError } : {}),
      ...(Object.keys(storeErrors).length > 0 ? { store_errors: storeErrors } : {}),
      // Back-compat alias for the field this replaced.
      ...(storeErrors.packs ? { pack_registry_error: storeErrors.packs } : {}),
      ...(this._spreadDrops.dropped_unresolvable > 0 || this._spreadDrops.dropped_retired > 0
        ? { spread_drops: { ...this._spreadDrops } }
        : {}),
    }
  },

async receipt(options?: { days?: number; now?: Date }): Promise<Receipt> {
    const primary = (await this._loadCached(this.paths.engrams)).filter(e => e.status === 'active')
    const ownIds = primary.map(e => e.id)

    // Statement snippets for the "most relied on" list, so it reads as memories
    // rather than opaque ids. Built only from LOCAL engrams (primary store +
    // installed packs); remote/team-store statements are never included. The
    // snippet is sanitized downstream and does surface in the MCP result, but
    // only for the caller's own engrams — content that agent already receives
    // via injection, so no new disclosure.
    const statements: Record<string, string> = {}
    for (const e of primary) {
      if (typeof e.statement === 'string') statements[e.id] = e.statement
    }

    const packIds: string[] = []
    for (const pack of this._loadInstalledPacks()) {
      for (const e of pack.engrams) {
        if (e.status === 'active') {
          packIds.push(e.id)
          if (typeof e.statement === 'string') statements[e.id] = e.statement
        }
      }
    }

    // A retrieved id namespaced with a configured store's prefix (ENG-DFU-…) is
    // a team-store engram this local receipt doesn't scope — mark those prefixes
    // so they read as external, not as retired.
    const externalPrefixes: string[] = []
    for (const store of this.config.stores ?? []) {
      // Both prefix forms: receipts recorded before 0.21.1 carry the old one.
      for (const p of [storePrefix(store.scope), legacyStorePrefix(store.scope)]) {
        externalPrefixes.push(`ENG-${p}-`, `ABS-${p}-`, `META-${p}-`)
      }
    }

    return gatherReceipt(this.paths.root, ownIds, packIds, externalPrefixes, { ...options, statements })
  },
}
