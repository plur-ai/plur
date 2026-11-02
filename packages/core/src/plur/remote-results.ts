import { activeEmbedderIsRemote, backgroundModelLoadAllowed, fillEmbeddingCache } from '../embeddings.js'
import { rrfMergeEngrams as pgliteRrfMerge } from '../hybrid-search.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import {
    buildRecallRemoteReport,
    isRemoteRecallDisabled,
    PROBE_CLEARABLE_STATES,
    recordWriteOutcome,
    REMOTE_STATUS_TTL_MS,
    remoteRecall,
    resolveRecallDeadlineMs,
    resolveRemoteRecallTimeoutMs, scopeOrg,
    settleBy,
    type RecallRemoteReport,
    type RemoteRecallHost, type RemoteRecallResult,
    type RemoteStoreStatusEntry
} from '../remote-recall.js'
import type { StoreEntry } from '../schemas/config.js'
import type { Engram } from '../schemas/engram.js'
import { personalStoreEntry } from '../scope-target.js'
import { isScopeWithin, isSharedScope, makeVisibilityPredicate, scopeAllowFilter } from '../scope-util.js'
import { normalizeEndpointUrl } from '../store/remote-store.js'
import type {
    InjectOptions,
    RecallOptions,
    RemoteProjectConfig
} from '../types.js'

export interface RemoteResultsMethods {
  /**
   * Strict scope-relevance dialing, per (url, token) endpoint group:
   *   (a) shared scopes sharing the ORG segment with the session's project scope;
   *   (b) the host's personal-family scopes ONLY when an org context implicates it;
   *   (c) a caller-passed or session-registered `user:` scope adds its ONE matching entry.
   * `options.scopes` bounds everything (`[]` → nothing). No implicating context
   * → ZERO remote calls; one org's host is never dialed from another org's work.
   * Overrides: `dial: never|always`; a `.plur.yaml` remote project is its host's org context.
   */
  /** @internal */
  _remoteRecallHosts(options?: { scope?: string; scopes?: string[]; context_scopes?: string[]; session?: string; remote_project?: RemoteProjectConfig }): RemoteRecallHost[]

  /**
   * Start the remote recall leg — called BEFORE the local pipeline so the
   * effective added latency is max(0, remote − local). Returns null (zero
   * fetches, zero new latency) when: the caller opted out (`remote: false` —
   * learn-dedup, forget-by-search, self-eval), the `PLUR_REMOTE_RECALL`
   * kill-switch is set, the query is empty, or no host is implicated by the
   * current project/work. The returned promise NEVER rejects.
   */
  /** @internal */
  _startRemoteRecall(query: string, options?: { scope?: string; scopes?: string[]; context_scopes?: string[]; session?: string; remote?: boolean; remote_timeout_ms?: number; remote_project?: RemoteProjectConfig; limit?: number }, deadlineAt?: number): (Promise<RemoteRecallResult> & { hostUrls: string[] }) | null

  /**
   * Apply the SAME read-side filters to server rows that every local read
   * path applies: `options.scopes` authorization (exact membership),
   * `options.scope` visibility (with grants — server rows sit in granted
   * scopes by construction after the scope guard's global admission +
   * narrowing), domain, and the residual temporal/strength filters.
   */
  /** @internal */
  _filterRemoteRows(rows: Engram[], options?: RecallOptions & { include_expired?: boolean }): Engram[]

  /**
   * Wait for the remote leg until the recall's deadline. The leg
   * itself stops at the deadline — it aborts what is still in flight and
   * keeps what answered — so this normally gets its per-host
   * outcomes. The fallback, for a leg that still has not settled a moment
   * after the deadline, reports every dialed host as cut by the deadline.
   */
  /** @internal */
  _awaitRemote(remotePromise: (Promise<RemoteRecallResult> & { hostUrls?: string[] }) | null, deadlineAt: number): Promise<{ result?: RemoteRecallResult; report: RecallRemoteReport }>

  /**
   * In a long-lived process that opted in ({@link allowBackgroundModelLoad}),
   * fill the store's embedding cache in the background — once per instance,
   * never awaited by a recall, never retried. Each
   * cut-off recall also keeps its own progress; this finishes the job without
   * waiting for more recalls.
   */
  /** @internal */
  _maybeFillEmbeddingCache(): void

  /** The recall's absolute deadline: `deadline_at` when the caller took it,
   *  else now + `deadline_ms` (env and default as {@link resolveRecallDeadlineMs}). */
  /** @internal */
  _recallDeadlineAt(options?: { deadline_ms?: number; deadline_at?: number }): number

  /**
   * Merge the remote leg into a local result set via RRF. Server rows go
   * FIRST so the server copy wins object identity for ids present in both
   * sets (the local set can hold a stale peek-cache copy of the same remote
   * row); RRF scoring itself is order-independent, so this affects identity
   * only, not ranking.
   */
  /** @internal */
  _mergeRemoteRecall(local: Engram[], remotePromise: (Promise<RemoteRecallResult> & { hostUrls?: string[] }) | null, options: (RecallOptions & { include_expired?: boolean }) | undefined, limit: number, deadlineAt?: number): Promise<{ engrams: Engram[]; remote: RecallRemoteReport }>

  /**
   * Server rows for the injection path: filtered for authorization +
   * visibility BEFORE boosts are assigned — the boost channel resurrects
   * scope-zeroed rows otherwise (`scoreEngram` returns 0 for both
   * no-keyword-hits and scope-excluded, and `raw = embBoost*2` revives
   * anything > 0.5). Boost = 0.55 + 0.45·score, so every server-ranked row
   * clears the 0.5 semantic threshold and the server's top row maps to 1.0.
   */
  /** @internal */
  _remoteInjectCandidates(remote: RemoteRecallResult | undefined, options?: InjectOptions): { engrams: Engram[]; boosts: Map<string, number> } | undefined

  /**
   * Per-host remote recall degradation status, from the last outcomes this
   * process observed (not driver caches or fresh probes); only DIALED hosts
   * update it. Every entry carries `observed_at` and `age_ms`. Present-tense
   * callers ("serving local only") must pass `freshOnly`; historical callers
   * (doctor's "last live recall") read everything and render the age.
   */
  remoteStoreStatus(opts?: { freshOnly?: boolean; now?: number }): RemoteStoreStatusEntry[]

  /**
   * A direct write to `url` just succeeded: the host is reachable, so the
   * read leg's breaker cooldown ends, as an outbox flush success does.
   * Otherwise saves reach the server while reads stay paused for the full
   * cooldown. Best-effort: health bookkeeping never fails a write.
   */
  /** @internal */
  _noteRemoteWriteSucceeded(url: string): void

  /**
   * Record that a non-recall interaction with `url` just SUCCEEDED, clearing a
   * cached network-class failure so `plur_doctor` does not contradict its own
   * live probe. Only {@link PROBE_CLEARABLE_STATES} are cleared; authorization
   * and endpoint-support failures must survive a probe.
   */
  noteRemoteHostReachable(url: string): void

  /**
   * Endpoints configured with more than one distinct token. The
   * (url, token) fan-out dials once per token, so this is a misconfiguration
   * worth a doctor warning — same user, same instance should mean one token.
   */
  remoteEndpointTokenConflicts(): Array<{ url: string; tokens: number }>

  /**
   * Engrams a primary-store pushdown cannot see: `config.stores` secondary
   * stores and installed packs. Without this, the Postgres tier's `recall()`
   * would silently drop team-store results. Scope and domain are applied here to
   * mirror the SQL side; residual filters are applied by the caller.
   */
  /** @internal */
  _engramsOutsidePrimaryStore(options?: RecallOptions): Promise<Engram[]>
}

export const remoteResultsMethods: RemoteResultsMethods & ThisType<Plur> = {
  _remoteRecallHosts(options?: { scope?: string; scopes?: string[]; context_scopes?: string[]; session?: string; remote_project?: RemoteProjectConfig }): RemoteRecallHost[] {
    // Pick up out-of-process config edits before reading tokens: a rotated
    // credential must reach the very next dial, not the next restart, even
    // when the store count is unchanged.
    this.reloadConfigIfChanged()
    const stores = (this.config.stores ?? []).filter(s => s.url)
    if (this._remoteOnly) {
      // remote-only: dial exactly the store(s) serving the folder's team
      // scope, for that scope only — with or without a session scope, and
      // never a `.plur.yaml` remote.
      const scope = this._remoteOnly.scope
      // Only a deliverable team scope is dialled: a hand-written personal
      // scope reads nothing.
      if (!scope || this._remoteOnly.blocked || !this._isDeliverableTeamScope(scope)) return []
      // The caller's authorization allow-list bounds what is dialed, by exact
      // membership as RecallOptions.scopes documents.
      if (options?.scopes !== undefined && !options.scopes.includes(scope)) return []
      const seen = new Set<string>()
      const hosts: RemoteRecallHost[] = []
      for (const s of stores) {
        if (s.scope !== scope) continue
        // Never dial with an empty Bearer because the entry's `token_env`
        // variable is unset.
        if (!s.token && s.token_env) continue
        const key = `${normalizeEndpointUrl(s.url!)}::${s.token ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        hosts.push({ url: s.url!, token: s.token ?? '', scopes: [scope], entries: [{ scope }] })
      }
      return hosts
    }
    const rp = options?.remote_project
    const rpKey = rp ? normalizeEndpointUrl(rp.url) : null
    // Dialing context: an explicit recall scope wins; otherwise the SESSION
    // default scope establishes the org context — a session whose default
    // write scope names org X is doing org-X work, so its recalls dial org-X
    // hosts. Resolved per-session via the same registry the write path uses
    // (`options.session`), so a mid-session scope switch redirects subsequent
    // recall dialing too.
    const dialScope = options?.scope ?? this._sessionScopes.get(options?.session) ?? undefined
    const contextOrgs = new Set((options?.scope !== undefined ? [options.scope] : options?.context_scopes ?? [dialScope]).map(scopeOrg).filter(Boolean))
    // A personal `user:` scope names its own store: a recall scoped to
    // `user:acme:me` dials the ONE store entry whose scope matches it (case
    // folded, exact-case preferred — `personalStoreEntry`), with that entry
    // alone. Only a scope the caller passed, or the session's OWN
    // registration, counts — never the process default an unregistered
    // session inherits: that default is another caller's choice. Without this,
    // `recall` with a personal scope would never read back what `learn` wrote
    // to the personal remote store.
    const personalScope = options?.scope ?? this._sessionScopes.own(options?.session) ?? undefined
    // Selected over EVERY configured store, exactly as a write selects
    // (`_canonicalPersonalScope`); a selected path-backed or `dial: never`
    // store means no personal dial — never a fall-through to a case twin.
    const selectedPersonal = personalStoreEntry(personalScope, (this.config.stores ?? []).filter(e => typeof e.scope === 'string'))
    const personalEntry = selectedPersonal?.url && selectedPersonal.dial !== 'never' ? selectedPersonal : null
    // The caller's authorization allow-list bounds what is DIALED, not only
    // what is kept afterwards: a query sent to a scope the caller may not
    // read has already left the machine. `[]` dials nothing. A
    // store is dialable when it can hold rows the allow-list admits: its
    // scope equals, or is a parent of, an allowed scope (`isScopeWithin`,
    // the nesting every read filter uses). The rows themselves
    // are still filtered by exact membership afterwards (`_filterRemoteRows`).
    const allowList = options?.scopes
    const allowed = (storeScope: string): boolean =>
      allowList === undefined || allowList.some(a => isScopeWithin(a, storeScope))

    const groups = new Map<string, { url: string; token?: string; entries: StoreEntry[] }>()
    for (const s of stores) {
      // Same `::` composite-key convention as _getRemoteDriver. Normalized URLs
      // and tokens don't contain `::` in practice, and a contrived collision
      // only merges two entries into one endpoint group — same POST, same token.
      const key = `${normalizeEndpointUrl(s.url!)}::${s.token ?? ''}`
      let g = groups.get(key)
      if (!g) { g = { url: s.url!, token: s.token, entries: [] }; groups.set(key, g) }
      g.entries.push(s)
    }

    const hosts: RemoteRecallHost[] = []
    for (const g of groups.values()) {
      const dialable = g.entries.filter(e => e.dial !== 'never')
      if (dialable.length === 0) continue
      const always = dialable.filter(e => e.dial === 'always')
      const shared = dialable.filter(e => isSharedScope(e.scope))
      const personal = dialable.filter(e => !isSharedScope(e.scope))
      const orgAffine = shared.filter(e => contextOrgs.has(scopeOrg(e.scope)))
      const projectImplicated = rpKey !== null && rpKey === normalizeEndpointUrl(g.url)
      const personalExact = personalEntry && dialable.includes(personalEntry) ? [personalEntry] : []
      const orgContext = orgAffine.length > 0 || projectImplicated
      if (!orgContext && always.length === 0 && personalExact.length === 0) continue
      const selected = new Set<StoreEntry>(orgAffine)
      for (const e of personalExact) selected.add(e)
      if (projectImplicated) for (const e of shared) selected.add(e)
      for (const e of always) selected.add(e)
      if (orgContext) for (const e of personal) selected.add(e)
      // Config order preserved — row→entry mapping must be deterministic.
      const dialEntries = dialable.filter(e => selected.has(e) && allowed(e.scope))
      if (dialEntries.length === 0) continue
      // No token because its `token_env` variable is unset — never dial with
      // an empty Bearer.
      if (!g.token && !(projectImplicated && rp?.token) && dialEntries.some(e => e.token_env)) continue
      hosts.push({
        url: g.url,
        token: (projectImplicated && rp?.token) ? rp.token : (g.token ?? ''),
        scopes: [...new Set(dialEntries.map(e => e.scope))],
        entries: dialEntries.map(e => ({ scope: e.scope })),
      })
    }

    // Standalone `.plur.yaml` endpoint not mounted in config.stores: dial it
    // with the project's own remote_scopes (the scope guard needs a scope set
    // to admit rows against; without one there is nothing safe to accept).
    if (rp?.token && rpKey && !stores.some(s => normalizeEndpointUrl(s.url!) === rpKey)) {
      const scopes = [...new Set(rp.scopes ?? [])].filter(allowed)
      if (scopes.length > 0) {
        hosts.push({ url: rp.url, token: rp.token, scopes, entries: scopes.map(scope => ({ scope })) })
      }
    }
    return hosts
  },

  _startRemoteRecall(query: string, options?: { scope?: string; scopes?: string[]; context_scopes?: string[]; session?: string; remote?: boolean; remote_timeout_ms?: number; remote_project?: RemoteProjectConfig; limit?: number }, deadlineAt?: number): (Promise<RemoteRecallResult> & { hostUrls: string[] }) | null {
    if (options?.remote === false) return null
    // An origin-derived local/unknown default is a privacy boundary even for
    // always-dial stores. Explicit call/session scopes remain deliberate choices.
    if (!this._remoteOnly && options?.scope == null && !options?.context_scopes?.length && this._sessionScopes.get(options?.session) == null) {
      const scope = this._gitFolderScope()
      if (scope === 'local') return null
      if (scope) options = { ...options, scope }
    }
    if (isRemoteRecallDisabled()) return null
    if (!query || !query.trim()) return null
    const hosts = this._remoteRecallHosts(options)
    if (hosts.length === 0) return null
    // The dialed hosts ride along so a recall that stops waiting at its
    // deadline can still name them in its per-call report.
    return Object.assign(remoteRecall(hosts, query, {
      timeoutMs: resolveRemoteRecallTimeoutMs(options?.remote_timeout_ms),
      limit: options?.limit,
      statePath: this.remoteHealthStatePath(),
      ...(deadlineAt !== undefined && Number.isFinite(deadlineAt) ? { deadlineAt } : {}),
    }).then(result => {
      const observed_at = Date.now()
      for (const o of result.outcomes) {
        this._lastRemoteOutcomes.set(normalizeEndpointUrl(o.url), { outcome: o, observed_at })
      }
      return result
    }).catch((): RemoteRecallResult => ({ engrams: [], scores: new Map(), outcomes: [] })), { hostUrls: hosts.map(h => h.url) })
  },

  _filterRemoteRows(rows: Engram[], options?: RecallOptions & { include_expired?: boolean }): Engram[] {
    let filtered = rows.filter(e => e.status === 'active')
    if (options?.scopes !== undefined) {
      const allowed = scopeAllowFilter(options.scopes)
      filtered = filtered.filter(e => allowed(e.scope))
    }
    if (options?.domain) filtered = filtered.filter(e => e.domain?.startsWith(options.domain!))
    if (options?.scope) {
      const visible = makeVisibilityPredicate(options.scope, this._grantedScopes())
      filtered = filtered.filter(e => visible(e.scope))
    }
    return this._applyResidualFilters(filtered, options)
  },

  async _awaitRemote(remotePromise: (Promise<RemoteRecallResult> & { hostUrls?: string[] }) | null, deadlineAt: number): Promise<{ result?: RemoteRecallResult; report: RecallRemoteReport }> {
    if (!remotePromise) return { report: { state: 'not_dialed', hosts: [] } }
    const waited = Number.isFinite(deadlineAt)
      ? await settleBy(remotePromise, deadlineAt + Plur.REMOTE_SETTLE_GRACE_MS)
      : { done: true as const, value: await remotePromise }
    if (!waited.done || !waited.value) {
      const hosts = (remotePromise.hostUrls ?? []).map(u => ({
        host: normalizeEndpointUrl(u), state: 'timeout' as const, ms: 0, count: 0, ids: [] as string[], detail: 'recall_deadline',
      }))
      return { report: { state: hosts.length > 0 ? 'timeout' : 'not_dialed', hosts } }
    }
    return { result: waited.value, report: buildRecallRemoteReport(waited.value.outcomes) }
  },

  _maybeFillEmbeddingCache(): void {
    if (!backgroundModelLoadAllowed() || this._embeddingFillStarts > 0 || this._embeddingFillChecking) return
    this._embeddingFillChecking = true
    void (async () => {
      // Not for a remote embedder: it has no cold start,
      // and a fill would keep a host that exits on its own busy embedding the
      // whole store through a paid API. A cut-off recall still keeps what it
      // computed.
      if (await activeEmbedderIsRemote()) return
      if (this._embeddingFillStarts > 0) return
      this._embeddingFillStarts++
      const engrams = (await this._loadAllEngrams()).filter(e => e.status === 'active')
      await fillEmbeddingCache(engrams, this.paths.root)
    })().catch(err => logger.debug(`[plur] background embedding fill stopped: ${(err as Error).message}`))
      .finally(() => { this._embeddingFillChecking = false })
  },

  _recallDeadlineAt(options?: { deadline_ms?: number; deadline_at?: number }): number {
    const at = options?.deadline_at
    if (typeof at === 'number' && Number.isFinite(at)) return at
    return Date.now() + resolveRecallDeadlineMs(options?.deadline_ms)
  },

  async _mergeRemoteRecall(local: Engram[], remotePromise: (Promise<RemoteRecallResult> & { hostUrls?: string[] }) | null, options: (RecallOptions & { include_expired?: boolean }) | undefined, limit: number, deadlineAt: number = Infinity): Promise<{ engrams: Engram[]; remote: RecallRemoteReport }> {
    // Team rows from a warm cache sit among the local results.
    this._noteSeenRows(local)
    const { result: remote, report } = await this._awaitRemote(remotePromise, deadlineAt)
    if (!remote) return { engrams: local, remote: report }
    const rows = this._filterRemoteRows(remote.engrams, options)
    if (rows.length === 0) return { engrams: local, remote: report }
    const merged = pgliteRrfMerge([rows, local]).slice(0, limit)
    // Every live remote row returned, by the server id it carries.
    this._noteSeenRows(merged.filter(r => rows.includes(r)), true)
    return { engrams: merged, remote: report }
  },

  _remoteInjectCandidates(remote: RemoteRecallResult | undefined, options?: InjectOptions): { engrams: Engram[]; boosts: Map<string, number> } | undefined {
    if (!remote) return undefined
    if (remote.engrams.length === 0) return undefined
    const permitted = options?.scopes
    let rows = remote.engrams.filter(e => e.status === 'active')
    if (permitted !== undefined) rows = rows.filter(e => permitted.includes(e.scope))
    if (options?.scope) {
      if (options.scope === 'global') {
        // INJECT_GLOBAL_IS_TARGETED (D1-ASYMMETRY): explicit global inject is
        // targeted to the global namespace only. Server rows are namespaced —
        // global rows were narrowed to their store scope — so none pass here,
        // by design; grants do not reach the targeted-global branch.
        rows = rows.filter(e => e.scope === 'global')
      } else {
        const visible = makeVisibilityPredicate(options.scope, this._grantedScopes())
        rows = rows.filter(e => visible(e.scope))
      }
    }
    if (rows.length === 0) return undefined
    this._noteSeenRows(rows, true)
    const boosts = new Map<string, number>()
    for (const e of rows) {
      const s = remote.scores.get(e.id) ?? 0
      boosts.set(e.id, 0.55 + 0.45 * Math.max(0, Math.min(1, s)))
    }
    return { engrams: rows, boosts }
  },

  remoteStoreStatus(opts?: { freshOnly?: boolean; now?: number }): RemoteStoreStatusEntry[] {
    const now = opts?.now ?? Date.now()
    const out: RemoteStoreStatusEntry[] = []
    for (const { outcome: o, observed_at } of this._lastRemoteOutcomes.values()) {
      const age_ms = Math.max(0, now - observed_at)
      if (opts?.freshOnly && age_ms > REMOTE_STATUS_TTL_MS) continue
      out.push({
        host: normalizeEndpointUrl(o.url),
        ...(this._enterpriseRecoveryEndpoint(o.url) ? { enterprise: true } : {}),
        status: o.state,
        ...(o.dropped_scopes && o.dropped_scopes.length > 0 ? { dropped_scopes: o.dropped_scopes } : {}),
        ms: o.ms,
        count: o.count,
        observed_at,
        age_ms,
      })
    }
    return out
  },

  _noteRemoteWriteSucceeded(url: string): void {
    try {
      recordWriteOutcome(url, true, Date.now(), this.remoteHealthStatePath())
      this.noteRemoteHostReachable(url)
    } catch { /* advisory state only */ }
  },

  noteRemoteHostReachable(url: string): void {
    const key = normalizeEndpointUrl(url)
    const entry = this._lastRemoteOutcomes.get(key)
    if (entry && PROBE_CLEARABLE_STATES.has(entry.outcome.state)) {
      this._lastRemoteOutcomes.delete(key)
    }
  },

  remoteEndpointTokenConflicts(): Array<{ url: string; tokens: number }> {
    const byUrl = new Map<string, { url: string; tokens: Set<string> }>()
    for (const s of this.config.stores ?? []) {
      if (!s.url) continue
      const key = normalizeEndpointUrl(s.url)
      let rec = byUrl.get(key)
      if (!rec) { rec = { url: s.url, tokens: new Set() }; byUrl.set(key, rec) }
      rec.tokens.add(s.token ?? '')
    }
    return [...byUrl.values()]
      .filter(r => r.tokens.size > 1)
      .map(r => ({ url: r.url, tokens: r.tokens.size }))
  },

  async _engramsOutsidePrimaryStore(options?: RecallOptions): Promise<Engram[]> {
    // Delegates to the SAME loader `_loadAllEngrams` uses, so remote stores,
    // id namespacing, scope narrowing and the containment guard cannot drift
    // between the pushdown path and every other read path.
    let filtered = (await this._loadSecondaryAndPacks()).filter(e => e.status === 'active')
    if (options?.scopes !== undefined) {
      const allowed = scopeAllowFilter(options.scopes)
      filtered = filtered.filter(e => allowed(e.scope))
    }
    if (options?.domain) filtered = filtered.filter(e => e.domain?.startsWith(options.domain!))
    if (options?.scope) {
      // Visibility filter: scope containment, personal-family
      // pass-through, and mounted-scope grants — the ONE shared predicate.
      const visible = makeVisibilityPredicate(options.scope, this._grantedScopes())
      filtered = filtered.filter(e => visible(e.scope))
    }
    return filtered
  },
}
