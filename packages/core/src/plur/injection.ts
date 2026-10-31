import * as fs from 'fs'
import { join } from 'path'
import { embedderStatus, embeddingSearchWithScores, semanticModelState, type SimilarityResult } from '../embeddings.js'
import { computeQueryHash, generateInjectionId, isRecentDuplicateInjection } from '../history.js'
import { Plur } from '../index.js'
import { assignLayer, formatWithLayer, selectAndSpread } from '../inject.js'
import { isEntityDomain } from '../intent/index.js'
import { logger } from '../logger.js'
import {
    type RemoteOnlyStatus
} from '../remote-only.js'
import {
    isRemoteRecallDisabled,
    settleBy,
    type RemoteRecallResult
} from '../remote-recall.js'
import type { Engram } from '../schemas/engram.js'
import { NO_SESSION } from '../session-scopes.js'
import { resolveScopeTarget } from '../store-resolver.js'
import { normalizeEndpointUrl } from '../store/remote-store.js'
import { withLock } from '../sync.js'
import type { DegradedReason, InjectionResult, InjectOptions } from '../types.js'

export interface InjectionMethods {
/** Scored injection within token budget (BM25 only). Returns formatted strings. */
inject(task: string, options?: InjectOptions): Promise<InjectionResult>

/**
   * Whether the remote-only folder's team server served this read
   * (`InjectionResult.remote_only`). Adapters say so, once per session, when
   * it did not: the session then has no memory, by design — never a silent
   * fallback to the personal store.
   */
/** @internal */
_remoteOnlyStatus(remote: RemoteRecallResult | null | undefined): RemoteOnlyStatus

/** Scored injection with embedding boost when available. Falls back to BM25 if embeddings not installed. */
injectHybrid(task: string, options?: InjectOptions): Promise<InjectionResult>

/** @internal */
_formatInjection(task: string, options?: InjectOptions, embeddingBoosts?: Map<string, number>, remote?: { engrams: Engram[]; boosts: Map<string, number> }, deadlineAt?: number): Promise<InjectionResult>
}

export const injectionMethods: InjectionMethods & ThisType<Plur> = {
async inject(task: string, options?: InjectOptions): Promise<InjectionResult> {
    if (this._remoteOnly) {
      // remote-only (owner decisions 2026-10-01): there is no local store to
      // inject from, so even the keyword path dials the folder's team server
      // (one call, bounded by remote_timeout_ms). Elsewhere inject() stays
      // local-only, as before.
      // Bounded by the same end-to-end deadline as injectHybrid (#1586).
      const deadlineAt = this._recallDeadlineAt(options)
      const remotePromise = this._startRemoteRecall(task, {
        scope: options?.scope,
        scopes: options?.scopes,
        session: options?.session_id,
        remote: options?.remote,
        remote_timeout_ms: options?.remote_timeout_ms,
      }, deadlineAt)
      const { result: remoteResult, report } = await this._awaitRemote(remotePromise, deadlineAt)
      const remote = this._remoteInjectCandidates(remoteResult, options)
      const result = await this._formatInjection(task, options, undefined, remote, deadlineAt)
      result.remote = report
      result.remote_only = this._remoteOnlyStatus(remoteResult)
      return result
    }
    return await this._formatInjection(task, options)
  },

_remoteOnlyStatus(remote: RemoteRecallResult | null | undefined): RemoteOnlyStatus {
    const ro = this._remoteOnly!
    const base = { folder: ro.folder, scope: ro.scope }
    if (!ro.scope) return { ...base, served: false, reason: 'no-scope' }
    // The store a write to the folder's scope goes to: the shared resolver (#1631).
    const target = resolveScopeTarget(ro.scope, this.config.stores ?? [])
    const store = target.kind === 'remote' && target.writable ? target.entry : undefined
    if (!store?.url) return { ...base, served: false, reason: 'no-store' }
    let host = store.url
    try { host = new URL(store.url).host } catch { /* keep as configured */ }
    if (!remote) return { ...base, host, served: false, reason: isRemoteRecallDisabled() ? 'disabled' : 'not-dialled' }
    const key = normalizeEndpointUrl(store.url)
    const outcome = remote.outcomes.find(o => normalizeEndpointUrl(o.url) === key)
    if (!outcome) return { ...base, host, served: false, reason: 'not-dialled' }
    return outcome.state === 'ok' ? { ...base, host, served: true } : { ...base, host, served: false, reason: outcome.state }
  },

async injectHybrid(task: string, options?: InjectOptions): Promise<InjectionResult> {
    // #776: the remote leg starts FIRST — it runs in parallel with the local
    // embedding work below and REPLACES the old hook `tryRemoteInject`
    // remote-first POST /inject path, so a prompt costs at most ONE remote
    // call per host.
    // #1586 audit L6: the same end-to-end deadline as recall.
    const deadlineAt = this._recallDeadlineAt(options)
    const remotePromise = this._startRemoteRecall(task, {
      scope: options?.scope,
      // The authorization allow-list bounds dialing too (#1515 audit F2).
      scopes: options?.scopes,
      // #243: the inject's session (same id plur_session_start minted for
      // co_injection provenance) doubles as the dialing-context key — the
      // session default scope drives org-affinity when no explicit scope is
      // given, so a mid-session scope switch redials the right org's hosts.
      // `dial_session` (#1566): the workspace's scope for a read with no
      // session default of its own; never recorded as a session.
      session: options?.dial_session ?? options?.session_id,
      remote: options?.remote,
      remote_timeout_ms: options?.remote_timeout_ms,
      remote_project: options?.remote_project,
    }, deadlineAt)
    // Use actual cosine similarity scores as boosts so the 0.5 threshold in
    // selectAndSpread is meaningful. (Pre-0.9.4 used rank-based 1/(1+i*0.1)
    // which gave the top result boost=1.0 even when its cosine was 0.4 —
    // letting unrelated short sentences leak through once embeddings actually
    // started running.)
    let embeddingBoosts: Map<string, number> | undefined
    // Why the semantic leg did not contribute, when it did not (R2-Retrieval
    // core-retrieval#12, applied by R2-CoreA). `embed()` swallows an embedder
    // failure and returns null, and this catch was silent, so the injection
    // quietly ran on keyword matching only and nobody could tell.
    let embedFailure: string | null = null
    // Stops the abandoned semantic leg's remaining work (the embeddings cache
    // save in particular) once the deadline has passed (#1586 audit L3).
    const semanticAbort = new AbortController()
    /** The model is not on disk: keyword only, never a download (#1586 R1). */
    let modelMissing = false
    const semanticLeg = async (): Promise<void> => {
    // remote-only: no embedder (Codex round 3; see recallSemantic).
    if (this._remoteOnly) return
    if (await semanticModelState() === 'missing') { modelMissing = true; return }
    try {
      // remote-only: the read corpus (team store rows + packs), and no PGLite
      // index, which mirrors the personal store.
      const engrams = (await this._readCorpus()).filter(e => e.status === 'active')
      // Route through PGLite/pgvector when active (#226 B-1), intersecting hits
      // with the YAML-rooted `engrams` set; else the JSON cache path.
      let results: SimilarityResult[] = []
      if (this.pgliteAdapter && !this._remoteOnly) {
        const { embed } = await import('../embeddings.js')
        const queryVec = await embed(task, 'query')
        if (queryVec) {
          try {
            // Scope-restricted in-query, same reason as the recall legs. Less
            // acute here because `limit` is `engrams.length` rather than a
            // small k, so there is no cut for permitted rows to fall below —
            // but passing it keeps every vector path consistent, and a future
            // change to that limit would otherwise reintroduce the dilution
            // silently.
            const hits = await this.pgliteAdapter!.searchVector(queryVec, engrams.length, { scopes: options?.scopes })
            if (hits.length > 0) {
              const allowed = new Map<string, Engram>(engrams.map(e => [e.id, e]))
              for (const hit of hits) {
                const e = allowed.get(hit.engram.id)
                if (e) results.push({ engram: e, score: Math.max(0, Math.min(1, hit.score)) })
              }
            }
          } catch (err) {
            logger.warning(`[plur] PGLite searchVector failed in injectHybrid: ${(err as Error).message}.`)
          }
        }
      }
      if (results.length === 0) {
        results = await embeddingSearchWithScores(engrams, task, engrams.length, this.paths.root, { signal: semanticAbort.signal, deadlineAt })
      }
      // Cross-encoder rerank stage (#220): replace the cosine boosts for the
      // top-K with the reranker's relevance, min-max normalized into [0,1] so
      // the selectAndSpread 0.5 threshold stays meaningful. Off by default.
      const rerank = await this._resolveRerankOptions(options?.rerank)
      if (rerank && results.length > 0) {
        const topK = Math.max(1, Math.min(results.length, rerank.topK ?? 50))
        const head = results.slice(0, topK)
        try {
          const scores = await rerank.reranker!.scoreBatch(task, head.map(r => r.engram.statement))
          if (scores.length === head.length) {
            const min = Math.min(...scores)
            const max = Math.max(...scores)
            const span = max - min
            for (let i = 0; i < head.length; i++) {
              const normalized = span > 0 ? (scores[i] - min) / span : 0.5
              head[i] = { engram: head[i].engram, score: normalized }
            }
            head.sort((a, b) => b.score - a.score)
            results = [...head, ...results.slice(topK)]
          }
        } catch (err) {
          logger.warning(`[plur] injectHybrid reranker "${rerank.reranker!.name}" failed: ${(err as Error).message}. Falling back to cosine boosts.`)
        }
      }
      if (results.length > 0) {
        embeddingBoosts = new Map()
        for (const r of results) {
          embeddingBoosts.set(r.engram.id, r.score)
        }
      }
      // Intent-aware boost (#224): modest (<=1.5x) upweight for engrams matching
      // the query intent. Boost cap stays 1.0 so the 0.5 threshold keeps meaning.
      const intent = this._resolveIntentProfile(task, options?.intentOverride)
      if (intent && embeddingBoosts) {
        for (const e of results.map(r => r.engram)) {
          let mult = 1.0
          if (intent.profile.entityBoost !== 1.0 && isEntityDomain(e.domain)) {
            mult *= intent.profile.entityBoost
          }
          if (intent.profile.episodeBoost !== 1.0 && Array.isArray(e.episode_ids) && e.episode_ids.length > 0) {
            mult *= intent.profile.episodeBoost
          }
          if (intent.profile.recencyBoost !== 1.0) {
            const ts = e.activation?.last_accessed ?? e.temporal?.learned_at
            if (ts) {
              const days = (Date.now() - Date.parse(ts)) / (1000 * 60 * 60 * 24)
              if (Number.isFinite(days) && days >= 0) {
                const r = Math.exp(-days / 30) // half-life ~30 days
                mult *= 1.0 + r * (intent.profile.recencyBoost - 1.0)
              }
            }
          }
          if (mult !== 1.0) {
            const cur = embeddingBoosts.get(e.id) ?? 0
            embeddingBoosts.set(e.id, Math.min(1.0, cur * mult))
          }
        }
      }
    } catch (err) {
      // Continue without boosts — but say so.
      embedFailure = (err as Error)?.message ?? String(err)
      logger.warning(`[plur] injectHybrid: embeddings failed (${embedFailure}) — keyword-only injection.`)
    }
    }
    // The semantic leg (corpus load, embedder, reranker) is bounded by the
    // deadline; past it the injection runs on keyword matching and says so.
    const semantic = await settleBy(semanticLeg(), deadlineAt)
    const semanticComplete = semantic.done && !modelMissing
    if (!semanticComplete) this._maybeFillEmbeddingCache()
    if (!semanticComplete) {
      semanticAbort.abort()
      embeddingBoosts = undefined
    }
    const boosts = embeddingBoosts
    // A swallowed failure shows in the embedder's status. Embeddings the USER
    // turned off (`disabled`) are a choice, not a degradation: never flagged.
    const st = embedderStatus()
    if (semanticComplete && !embedFailure && !st.disabled && !st.available) embedFailure = st.lastError ?? 'embedder unavailable'
    // #776: server rows join the candidate pool + boost channel. Visibility/
    // authorization run over them INSIDE _remoteInjectCandidates, before any
    // boost exists to resurrect a scope-excluded row.
    const { result: remoteResult, report } = await this._awaitRemote(remotePromise, deadlineAt)
    const remote = this._remoteInjectCandidates(remoteResult, options)
    const result = await this._formatInjection(task, options, boosts, remote, deadlineAt)
    // #1586 audit L6: what the server leg did on THIS call, as on recall.
    result.remote = report
    if (this._remoteOnly) result.remote_only = this._remoteOnlyStatus(remoteResult)
    result.results_complete = semanticComplete && (report.state === 'ok' || report.state === 'not_dialed')
    if (!semanticComplete) {
      // Cut by the deadline — not an embedder fault, so no operator log line.
      if (st.disabled) {
        result.mode = 'bm25-only'
      } else {
        const reason: DegradedReason = modelMissing ? 'embedding_model_missing' : 'semantic_deadline'
        result.mode = 'hybrid-degraded'
        result.embedder_error = Plur.DEGRADED_MESSAGES[reason]
        result.degraded_reason = reason
      }
      return result
    }
    // Reported as structured fields mirroring `HybridSearchResult`, not as a
    // `warnings` line: `warnings` is rendered into the injected context on
    // every prompt, and an install without the model would repeat the same
    // line forever. Logged once per process for an operator.
    if (embedFailure) {
      result.mode = 'hybrid-degraded'
      result.embedder_error = embedFailure
      if (!Plur._injectDegradedLogged) {
        Plur._injectDegradedLogged = true
        logger.warning(`[plur] injectHybrid: embedder unavailable (${embedFailure}) — injecting by keyword match only.`)
      }
    } else {
      result.mode = st.disabled ? 'bm25-only' : 'hybrid'
    }
    return result
  },

async _formatInjection(task: string, options?: InjectOptions, embeddingBoosts?: Map<string, number>, remote?: { engrams: Engram[]; boosts: Map<string, number> }, deadlineAt?: number): Promise<InjectionResult> {
    // remote-only: team store rows + packs, never the personal store.
    let allEngrams = await this._readCorpus()
    const allPacks = this._remoteOnly?.blocked ? [] : this._loadInstalledPacks()

    if (remote && remote.engrams.length > 0) {
      // Candidate-pool dedup by namespaced id — the SERVER copy wins (fresher
      // than any peek-cache copy of the same remote row that
      // _loadSecondaryAndPacks may have merged in).
      const serverIds = new Set(remote.engrams.map(e => e.id))
      allEngrams = [...allEngrams.filter(e => !serverIds.has(e.id)), ...remote.engrams]
      // Boost-channel entry. The map is SHARED with the local cosine/reranker
      // writes — collision rule is max-merge, so neither channel can lower
      // the other's signal.
      if (embeddingBoosts) {
        for (const [id, boost] of remote.boosts) {
          const cur = embeddingBoosts.get(id)
          embeddingBoosts.set(id, cur === undefined ? boost : Math.max(cur, boost))
        }
      } else {
        embeddingBoosts = remote.boosts
      }
    }

    // Permitted-scope allow-list — AUTHORIZATION, applied before selection.
    //
    // `options.scope` below is a VISIBILITY filter and deliberately passes the
    // whole personal family through (`local`, `global`, `user:*`, `agent:*`),
    // which is right for a single user and wrong for a multi-tenant caller:
    // without this, every principal's personal engrams reach every other
    // principal's context. `inject()` is what a session calls on every prompt,
    // so it was the widest surface with no authorization filter at all.
    //
    // Exact membership, matching `ScopeRestriction`: absent = unrestricted,
    // `[]` = nothing (never widened), non-empty = the list itself with no
    // hierarchy expansion.
    //
    // Packs are filtered too. A pack is installed knowledge rather than user
    // data, so it is tempting to exempt it — but its engrams carry scopes, they
    // reach the same output, and an allow-list with an exemption is not an
    // allow-list. A caller that wants pack content in scope names it.
    const permitted = options?.scopes
    const inScope = (e: Engram): boolean => permitted === undefined || permitted.includes(e.scope)
    // Pack engrams are carried by `packs`, NOT by this array (#901).
    //
    // `_loadAllEngrams` merges installed-pack engrams into the corpus and
    // stamps `_pack` — deliberately, and for RECALL: its own comment says
    // "include pack engrams so they're searchable via recall". Injection does
    // not need that merge, because it receives `packs` separately.
    //
    // Leaving them in meant `selectAndSpread` scored every pack engram TWICE:
    // once in its personal-engram loop and once in its pack loop. Not merely a
    // double count — the two loops apply different rules (the pack loop uses
    // `packMatchTerms` and is capped by MAX_PER_PACK, the personal loop is
    // neither), so the stray copy was scored under rules never meant for it,
    // competed for the same token budget, and could displace a genuinely
    // distinct engram. It also inflated `total_injections`, which feeds the
    // H003 activation-rate assumption in hypotheses.yaml.
    const withoutPacks = allEngrams.filter(e => (e as { _pack?: string })._pack === undefined)
    const engrams = permitted === undefined ? withoutPacks : withoutPacks.filter(inScope)
    const packs = permitted === undefined
      ? allPacks
      : allPacks
        .map(p => ({ ...p, engrams: p.engrams.filter(inScope) }))
        .filter(p => p.engrams.length > 0)

    const budget = options?.budget ?? this.config.injection_budget ?? 2000

    const result = selectAndSpread(
      {
        prompt: task,
        scope: options?.scope,
        // Mounted-scope visibility grants (#775): scopes from config.stores
        // pass the `scope` VISIBILITY filter inside scoreEngram like the
        // personal family. Deliberately independent of the `permitted`
        // authorization filter above — grants never widen `options.scopes`.
        grantedScopes: this._grantedScopes(),
        maxTokens: budget,
      },
      engrams,
      packs,
      {
        spread_cap: this.config.injection?.spread_cap,
        spread_budget: this.config.injection?.spread_budget,
        expiry: this.config.expiry,
        pinned_hard_ratio: this.config.injection?.pinned_hard_ratio,
        pinned_ratio: this.config.injection?.pinned_ratio,
      },
      embeddingBoosts,
    )

    if (result.spread_drops) {
      this._spreadDrops.dropped_unresolvable += result.spread_drops.dropped_unresolvable
      this._spreadDrops.dropped_retired += result.spread_drops.dropped_retired
    }

    const directivesStr = formatWithLayer(result.directives, assignLayer('directives'))
    const constraintsStr = formatWithLayer(result.constraints, assignLayer('constraints'))
    const considerStr = formatWithLayer(result.consider, assignLayer('consider'))
    const count = result.directives.length + result.constraints.length + result.consider.length
    const tokensUsed = result.tokens_used.directives + result.tokens_used.consider

    const injected_ids = [
      ...result.directives.map(e => e.id),
      ...result.constraints.map(e => e.id),
      ...result.consider.map(e => e.id),
    ]

    // Build per-pack injection counts for telemetry (session_end activation tracking).
    // Uses the `pack` field that selectAndSpread stamps onto every WireEngram —
    // null means the engram belongs to the user's personal store, not an installed pack.
    const injected_packs: Record<string, number> | undefined = injected_ids.length > 0
      ? (() => {
          const allEngrams = [
            ...result.directives,
            ...result.constraints,
            ...result.consider,
          ]
          const counts: Record<string, number> = {}
          for (const e of allEngrams) {
            // `_pack` FIRST, and that is a bug fix, not a preference (#553).
            //
            // This read only `pack` — the schema field, which an engram carries
            // only if its own YAML declares it. But `_loadAllEngrams` stamps
            // installed-pack engrams with `_pack` (the pack's manifest name),
            // and nothing sets `pack` on them. So the normal case — a pack
            // whose engrams do not self-declare their origin — bucketed
            // ENTIRELY as `__personal__`, and per-pack telemetry counted
            // nothing it existed to count.
            //
            // #553 predicted this shape ("a future regression in that
            // propagation would keep CI green") and was one step off: it was
            // not a future regression, it was already true, and no test
            // installed a pack so nothing could see it.
            //
            // `_pack` survives into `WireEngram` because `stripScoring`
            // rest-spreads. `pack` is kept as the fallback so a pack engram
            // that DOES declare its origin still buckets by it.
            const key = (e as { _pack?: string })._pack ?? e.pack ?? '__personal__'
            counts[key] = (counts[key] ?? 0) + 1
          }
          return counts
        })()
      : undefined

    // #452: log a co_injection provenance event — which engrams fired
    // together for which query context. Data source for the co-fires-with
    // edges (#200/#201) and temporal-replay self-labeling (#202). Compact by
    // design (IDs + query hash, never statements); best-effort — a history
    // write failure must never break injection.
    //
    // #975: cross-process dedup. Hooks spawn fresh processes (empty address
    // space each time), so an in-memory map cannot see the other process's
    // injection. The check reads the HISTORY FILE — durable, shared across
    // processes. Keyed on query_hash + sorted engram IDs (not hash alone)
    // because the same query can legitimately select different engrams after
    // a write.
    if (injected_ids.length > 0) {
      // #975: cross-process dedup for the co_injection HISTORY EVENT only.
      // The injection_count increment (#866) is NOT gated — the engram was
      // genuinely injected into context even if the history event is a
      // duplicate. Only the provenance log is deduped.
      const queryHash = computeQueryHash(task)

      // The check and the append are ONE critical section, or this does not
      // dedup anything.
      //
      // The duplicates being suppressed come from hook processes that spawn
      // "within milliseconds" of each other — which is precisely the window in
      // which both read the tail before either has appended to it. Read, decide,
      // then append is a read-modify-write across processes, and O_APPEND makes
      // the WRITE atomic without making the SEQUENCE atomic. Both would see no
      // duplicate and both would write one, so the fix would help only when the
      // processes happen to be staggered by more than a read plus an append —
      // the case that was never the problem.
      //
      // Its OWN lock file, deliberately not the one #1051 uses for chain
      // stamping. #1051 moves that lock INSIDE appendHistory; taking the same
      // file here would mean this frame holds it while appendHistory tries to
      // take it again, and withLock is file-based and not reentrant — so once
      // both changes are on main every co_injection would fail to acquire,
      // fall through to the unlocked path, and the dedup would be silently
      // inert again. Two locks, two concerns: this one serialises the
      // dedup DECISION, #1051's serialises the chain STAMP. They nest in one
      // direction only (this one outside), and never contend for the same file.
      //
      // Tuned like #1051's: the section is a tail read and an append, so the
      // stock 100 ms first backoff has waiters sleeping orders of magnitude
      // longer than the holder needs.
      const historyDir = join(this.paths.root, 'history')
      // Whether THIS call is the one that recorded the injection. Decided inside
      // the lock, read afterwards by the injection_count block so both counters
      // follow the same verdict.
      let recordedInjection = false
      // Dedup applies to HOOK-sourced injections only.
      //
      // The key is content-based — query hash, engram set, source, session — so
      // it cannot tell "the hook fired twice for one event" from "the caller
      // injected the same thing three times". #975's duplicates come from
      // hook processes: a fresh process per event, racing a sibling
      // milliseconds away. Every other source ('inject', 'session_start')
      // originates in a single long-lived MCP process making deliberate calls,
      // and three deliberate calls are three injections, not one duplicated.
      //
      // Applied to all sources, the filter swallowed those: it turned three
      // explicit `inject()` calls into one recorded injection, which
      // inject-counter-and-flush-merge.test.ts has asserted against since
      // #900. That test predates this dedup and is right — the counter is
      // supposed to accumulate.
      //
      // Narrowing here is what lets BOTH counters follow one reading without
      // redefining what an injection is for every other caller.
      const dedupApplies = options?.source === 'hook'
      // Decision E7: NO_SESSION selects "no session default" for the dial
      // context; it is not a session id and is never recorded as one.
      const recordedSessionId = options?.session_id === NO_SESSION ? undefined : options?.session_id
      const writeCoInjection = (): void => {
        if (dedupApplies
          && isRecentDuplicateInjection(this.paths.root, queryHash, injected_ids, 5_000, options?.source, recordedSessionId)) return
        const injection_id = generateInjectionId()
        try {
          // ASK whether the write landed; do not infer it from the absence of a
          // throw (review of #1017). `recordedInjection = true` used to sit
          // above this block, so a failed history write still counted the
          // injection — injection_count incremented with no co_injection event
          // to explain it, which is the store-disagrees-with-its-own-history
          // state this change set out to eliminate, relocated to the error
          // path.
          //
          // Moving the assignment below `appendHistory` — the obvious fix, and
          // the one the review suggested — does NOT close it: appendHistory
          // deliberately swallows its own failure and returns normally, so an
          // unwritable history directory cannot fail the learn that called it.
          // Nothing is ever thrown, so the try/catch never fires and the
          // assignment runs either way. Verified: the regression test still
          // read injection_count: 1 with the assignment moved.
          //
          // So it reports instead.
          // `this._appendHistory`, not the bare `appendHistory` (#963). The
          // wrapper stamps `event.actor` with the configured identity, and
          // taking main's dedup block wholesale would have dropped that from
          // co_injection events alone — the one history event with no actor.
          const wrote = this._appendHistory({
            event: 'co_injection',
            engram_id: injection_id,
            timestamp: new Date().toISOString(),
            data: {
              ids: injected_ids,
              query_hash: queryHash,
              // Event provenance for offline token-economics analysis of real
              // sessions (the plur-bench #42 measurement). Deliberately NOT read
              // by the receipt, which shows no token/cost figure by design.
              tokens_used: tokensUsed,
              source: options?.source ?? 'inject',
              ...(options?.scope ? { scope: options.scope } : {}),
              ...(recordedSessionId ? { session_id: recordedSessionId } : {}),
            },
          })
          // In-memory provenance is set regardless: the engrams WERE injected,
          // whatever the log managed to record.
          for (const id of injected_ids) this._lastInjectionByEngram.set(id, injection_id)
          recordedInjection = wrote
        } catch { /* best-effort */ }
      }

      try {
        // The lock file lives beside the month files, so the directory has to
        // exist before we can take it. appendHistory creates it too, but that
        // is inside the section we are trying to guard.
        if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true })
        withLock(join(historyDir, 'co-injection-dedup'), writeCoInjection, { maxRetries: 12, baseDelay: 2 })
      } catch {
        // Could not take the lock. Write UNDEDUPED rather than dropping the
        // event: a duplicate provenance record is noise, a missing one is a
        // hole in the log `plur restore` reads to NAME what it cannot recover.
        // Losing a record to avoid a duplicate is the wrong way round.
        writeCoInjection()
      }

      // #866: increment injection_count on primary-store engrams selected for context.
      // Distinct from activation.frequency (recall events) — this tracks actual
      // injection into the model's context window. Best-effort: never breaks injection.
      //
      // GATED on the same verdict as the history event. It used to be exempt, on
      // the reasoning that the engram was genuinely injected even when the log
      // entry is a duplicate — but that contradicts the premise the dedup rests
      // on. Either the two events describe ONE injection, in which case counting
      // it twice is the inflation #975 opens with ("usage data is inflated, and
      // not by a constant factor"), or they describe two, in which case the
      // history event should not have been suppressed either. It cannot be one
      // reading for the log and the other for the counter: that left
      // engrams.yaml showing injection_count: 2 against a single co_injection
      // event, which is a store that disagrees with its own history.
      //
      // One reading, taken: they are one injection. Both counters follow.
      if (!recordedInjection || this._remoteOnly) {
        // (remote-only: no counter on primary rows — audit of #1521, S6.)
        // A duplicate. The engram's count was already incremented by the call
        // that recorded the event, microseconds ago and in another process.
      } else {
      //
      // TARGETED, via the `_loadTargeted`/`_updateEngrams` pair (2026-08-13
      // panel). This first loaded the whole corpus and wrote the whole corpus
      // back, on a path that runs at EVERY session start. Measured cost of the
      // block, with and without:
      //
      //     corpus     with      without   overhead
      //        200     48 ms      11 ms      4.4x
      //      2,000    442 ms      42 ms     10.5x
      //     10,000  2,804 ms     142 ms     19.7x
      //
      // …all of it inside the global store lock, so it is not just this call
      // that pays, it is every concurrent writer waiting behind it. Counting
      // injections is worth a row update; it is not worth rewriting the store.
      // On YAML (no `updateMany`) the pair still falls back to a corpus write,
      // but the corpus is the one loaded under this lock, so the fallback is
      // the same shape it always was.
      try {
        await this._bookkeepingWithinDeadline(deadlineAt, async (tooLate) => {
          const primaryEngrams = await this._loadTargeted(injected_ids)
          const injectedSet = new Set(injected_ids)
          const touched: Engram[] = []
          for (const e of primaryEngrams) {
            if (injectedSet.has(e.id)) {
              e.injection_count = (e.injection_count ?? 0) + 1
              touched.push(e)
            }
          }
          if (tooLate()) return
          await this._updateEngrams(primaryEngrams, touched)
        })
      } catch (err) {
        // Best-effort, but not SILENT. `EngramStoreShrinkError` and
        // `EngramStoreUnreadableError` are the #795/#800 guards telling us the
        // store is degrading; swallowing them on the most frequently run write
        // path means the user gets no signal from the operation they run most.
        // Everything else stays quiet — a counter is not worth a warning.
        const name = (err as Error)?.constructor?.name
        if (name === 'EngramStoreShrinkError' || name === 'EngramStoreUnreadableError') {
          logger.warning(
            `[plur] injection counters were not recorded: ${(err as Error).message}. `
            + `The injection itself succeeded — this is a store-integrity signal, not an injection failure.`,
          )
        }
      }
      }
    }

    // #181: surface persisted tensions touching this injection — flag,
    // don't adjudicate (audit #213 item 4).
    const warnings = this._tensionWarningsFor(injected_ids)

    return {
      directives: directivesStr,
      constraints: constraintsStr,
      consider: considerStr,
      count,
      tokens_used: tokensUsed,
      injected_ids,
      ...(injected_packs ? { injected_packs } : {}),
      // Pinned engrams that did not make it (#1142). Surfaced here because the
      // internal result carried it and the public shape dropped it, so the
      // reporting existed and never reached a caller — the same silent-omission
      // shape the field was added to close.
      ...(result.omitted_pinned?.length ? { omitted_pinned: result.omitted_pinned } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  },
}
