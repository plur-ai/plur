import { engramContentFields, learnContextContent } from '../content-fields.js'
import { computeContentHash, isHashable } from '../content-hash.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import { isRemoteOnlyQueued } from '../remote-only-rows.js'
import { collapseLineTerminators } from '../sanitize.js'
import type { ScopeRoutingConfig } from '../schemas/config.js'
import type { Engram } from '../schemas/engram.js'
import { MeasuredUnderSchema, type MeasuredUnder } from '../schemas/engram.js'
import { type ScopeMetadata, type SensitivityCategory } from '../schemas/scope-metadata.js'
import { decideAutoRoute, rankScopes, SCOPE_MATCH_THRESHOLD, type AutoRouteDecision, type ScopeCandidate, type ScopeSignals, type ScopeSource } from '../scope-routing.js'
import { isSharedScope } from '../scope-util.js'
import type { SecretMatch } from '../secrets.js'
import { detectPromptInjection, detectSecrets, detectSensitive, SCAN_TRUNCATED, sensitivityCategory } from '../secrets.js'
import type {
    LearnContext
} from '../types.js'
import { VALID_ENGRAM_TYPES } from './helpers.js'

export interface ScopeGuardsMethods {
  /**
   * Resolve self-describing metadata for a scope from the loaded config.
   * Metadata is carried on a `stores` entry: the first entry whose `scope`
   * matches and that declares any metadata field (`description`/`covers`/
   * `sensitivity`) is materialized into a {@link ScopeMetadata}. Returns
   * `undefined` when the scope is unknown or declares no metadata — callers
   * (notably the leak guard) treat that as "fall back to default behavior".
   */
  getScopeMetadata(scope: string): ScopeMetadata | undefined

  /**
   * All registered scopes that declare self-describing metadata, materialized
   * via {@link getScopeMetadata}. Deduplicated on scope (first declaration
   * wins, matching getScopeMetadata's find-first semantics). Drives discovery
   * surfacing and the {@link suggestScope} ranker. Additive — does not touch
   * routing.
   */
  listScopeMetadata(): ScopeMetadata[]

  /**
   * Registered scopes eligible as an AUTO-ROUTE target: those declaring
   * metadata, minus readonly stores. Shared by the write path and
   * {@link previewAutoRoute} so the two cannot rank different candidate sets.
   */
  /** @internal */
  _writableScopeMetadata(): ScopeMetadata[]

  /**
   * What a genuinely-unscoped write of these signals WOULD do.
   *
   * `suggestScope` ranks; this decides. Both the write path and this preview
   * go through `decideAutoRoute`, so a suggestion surface reports the real
   * outcome instead of an approximation of it.
   */
  previewAutoRoute(input: ScopeSignals): AutoRouteDecision

  /**
   * Suggest registered scopes for an engram, ranked by fit. Deterministic, no
   * LLM or network: scores statement keywords, `domain` and `tags` against each
   * scope's `covers[]` (weights: {@link rankScopes}). ADVISORY ONLY — routing is
   * {@link previewAutoRoute}. `options.minConfidence` (else
   * `scope_routing.min_confidence`, else 0) floors this suggestion list only;
   * the auto-route gate `scope_routing.match_threshold` is independent.
   * Sorted by confidence descending; empty means no match above the floor.
   */
  suggestScope(input: ScopeSignals, options?: { minConfidence?: number }): ScopeCandidate[]

  /**
   * Read-only view of the `scope_routing` config block. Lets display
   * surfaces (the MCP `plur_suggest_scope` handler) resolve the configured
   * suggestion floor without reaching into the private config — precedence at
   * that surface is: explicit tool arg > this config value >
   * SUGGEST_DISPLAY_MIN_CONFIDENCE.
   */
  getScopeRoutingConfig(): Readonly<ScopeRoutingConfig>

  /**
   * Single source of truth for "does this content carry sensitivity that
   * `scope` forbids?" — returns the offending hits, or `[]`. Used by
   * `_guardSensitiveScope` and every mutation-path guard.
   * Only SHARED or REMOTE-backed scopes are checked; purely local scopes return
   * `[]` (content never leaves the machine). Hits from `detectSensitive` are kept
   * unless the scope's `sensitivity` policy allows them (by category or pattern
   * name) or does not forbid their category; the default forbids secrets and infra.
   */
  /** @internal */
  _offendingHitsForScope(statement: string, scope: string): SecretMatch[]

  /**
   * Everything on an engram, apart from its statement, for the explicit-update /
   * meta / outbox-reguard / rescope leak scan.
   *
   * Serialises the whole engram (see `engramContentFields` for the one
   * deliberate exclusion) rather than a hand-kept field list, so a field that
   * reaches the engram by any route is scanned by construction.
   */
  /** @internal */
  _engramContextFields(engram: Engram): Record<string, unknown> | undefined

  /**
   * Leak guard for explicit updates (`updateEngram`/`updateEngramAsync`).
   * Remote-resident: a forbidden hit THROWS (an engram on another server cannot
   * be silently re-scoped). Local-resident: it DEMOTES in place (scope 'local',
   * visibility 'private') and warns, returning the override; `null` when clean.
   * Scans `statement` plus `contextFields` so credentials in context are caught;
   * size is bounded inside `detectSensitive`.
   */
  /** @internal */
  _guardExplicitUpdate(statement: string, scope: string, isRemote: boolean, contextFields?: Record<string, unknown>): { scope: string; visibility: 'private' } | null

  /**
   * Resolve the scope for a genuinely UNSCOPED write (no explicit scope, no
   * session/`.plur.yaml` default). With `config.auto_route_scope` (default true)
   * run {@link suggestScope}: a full domain-prefix match routes deterministically
   * (a lone domain match squashes to exactly the 0.5 threshold, so it bypasses
   * the gate); weaker matches must pass the threshold. Otherwise fall to
   * `config.unscoped_default`. Inert until scopes declare `covers`. This is an
   * organizational default, not a leak control; the sensitivity guard runs after.
   * `routed` is null on the fall-through, so a default `global` is never labelled routed.
   */
  /** @internal */
  _resolveUnscopedScope(statement: string, context?: LearnContext): Promise<{ scope: string; routed: { scope: string; confidence: number; reason: string } | null; refusedShared: { scope: string; confidence: number; reason: string } | null }>

  /**
   * The text the write-time HARD secret scan reads: the statement plus every
   * caller-supplied content field, as listed by `LEARN_CONTEXT_FIELD_ROLES`.
   * Statement-only when the context carries no content field, so a plain
   * write scans exactly what it always did.
   */
  /** @internal */
  _hardScanText(statement: string, context: LearnContext | undefined): string

  /**
   * Write-time leak guard, called by both `learn()` and `learnRouted()` so every
   * client is covered. If the target scope is SHARED (`isSharedScope`) or
   * REMOTE-backed (`_hasUrlStoreForScope`) and the content trips
   * `detectSensitive`, DEMOTE to a private local scope and warn. Purely-local
   * scopes are exempt. A scope's `sensitivity` metadata decides via
   * {@link _offendingHitsForScope}; the default policy (`forbid: ['secrets','infra']`)
   * demotes on any hit.
   */
  /** @internal */
  _guardSensitiveScope(statement: string, context?: LearnContext): Promise<{ scope: string; context: LearnContext | undefined; demotion: { from: string; to: string; patterns: string } | null; routed: { scope: string; confidence: number; reason: string } | null; refusedShared: { scope: string; confidence: number; reason: string } | null; scopeSource: ScopeSource }>

  /**
   * `measured_under` as it may be persisted: validated against
   * MeasuredUnderSchema, or absent. The MCP tool passes the LLM's object
   * through as a bare cast, and a non-string dimension written to disk makes
   * the loader quarantine the WHOLE engram on the next read — the field that
   * was meant to add context would silently remove the memory. Refusing at
   * write time keeps the store loadable; the caller gets a TypeError naming
   * the field instead of a warning in a log they may never see.
   */
  /** @internal */
  _validatedMeasuredUnder(context: LearnContext | undefined): MeasuredUnder | undefined

  /**
   * The input gate every learn path runs before touching a store: non-empty
   * statement with line terminators collapsed (no forged prompt boundaries);
   * known engram type, checked BEFORE the secret scan; and, unless
   * `config.allow_secrets`, no secret in the statement or any field listed in
   * `LEARN_CONTEXT_FIELD_ROLES`. Both `learn()` and `learnRouted()` call it —
   * learnRouted's remote route never enters learn(). Idempotent. Returns the
   * sanitised statement, which every downstream gate and the content hash must see.
   */
  /** @internal */
  _validateLearnInput(fn: 'learn' | 'learnRouted', statement: string, context?: LearnContext): string

  /** learn()'s delegation test — the capability SET, see learn(). */
  /** @internal */
  _learnCanDelegate(): boolean

  /** learn()'s same-scope content-hash dedup: the store seam first (a primary
   *  match wins), then the in-memory scan. One implementation for learn(),
   *  learnRouted(), learnAsync's hash step and {@link wouldDeduplicate}.
   *
   *  "Always store my write": only a hit the writer can persist absorbs the
   *  write (`hashMatch`). A match held only where the writer cannot persist
   *  it — a pack, a readonly store, another scope's remote cache — comes back
   *  as `foreign`: the caller stores a new row and records the recurrence
   *  against it in history only. */
  /** @internal */
  _learnHashMatch(statement: string, scope: string, canDelegate: boolean, allEngrams: Engram[]): Promise<{ primaryHashMatch: Engram | null; hashMatch: Engram | null; foreign: Engram | null }>

  /** `_hashDedup`'s match rule as a predicate (null: nothing can match). */
  /** @internal */
  _hashDedupPredicate(statement: string, scope?: string): ((e: Engram) => boolean) | null

  /** `_crossScopeRecurrenceDetect`'s match rule as a predicate. */
  /** @internal */
  _crossScopePredicate(statement: string, scope: string): ((e: Engram) => boolean) | null

  /**
   * Where a dedup hit lives, as far as a writer to `scope` is concerned.
   * `primary`, a writable `secondary` path store, and
   * `own-remote` (the cache of a writable URL store for exactly `scope`) are
   * the writer's own; `pack`, `readonly` and another scope's `remote-cache`
   * are not. Every non-primary row carries the loader's `_storeScope` or
   * `_pack` stamp (`_loadSecondaryAndPacks`), so an unstamped row is primary.
   */
  /** @internal */
  _hitHolder(hit: Engram, scope: string): Promise<'primary' | 'secondary' | 'own-remote' | 'pack' | 'readonly' | 'remote-cache'>

  /** The first candidate matching `pred` that the writer can persist (`hit`),
   *  and the first one it cannot (`foreign`), in corpus order. */
  /** @internal */
  _firstPersistableHit(candidates: Engram[], pred: ((e: Engram) => boolean) | null, scope: string | undefined): Promise<{ hit: Engram | null; foreign: Engram | null }>

  /** learnAsync's dedup candidates: keep only rows the writer
   *  can persist (`_hitHolder` of the row in its own scope). */
  /** @internal */
  _persistableCandidates(rows: Engram[]): Promise<Engram[]>

  /** Cross-scope match over `allEngrams`, split into persistable and foreign like
   *  {@link _learnHashMatch}. Nothing when `_crossScopeRecurrenceApplies`
   *  says a cross-scope hit may not absorb a write into `scope`. */
  /** @internal */
  _crossScopeMatch(statement: string, allEngrams: Engram[], scope: string, opts?: { creditOnly?: boolean }): Promise<{ hit: Engram | null; foreign: Engram | null }>

  /**
   * The write was stored as `storedAs` although its statement was
   * already held by `hit`, which the writer cannot persist (pack, readonly
   * store, another scope's remote cache). The hit is NOT mutated — not on disk
   * and not in memory; the recurrence is recorded in history only.
   */
  /** @internal */
  _noteUnpersistableRecurrence(hit: Engram, scope: string, storedAs: string): Promise<void>

  /**
   * Would `learn(statement, context)` resolve to an EXISTING engram instead of
   * writing? Returns its id, or null; writes nothing. Uses learn()'s scope
   * resolution and dedup (incl. excluding the primary store on delegating
   * backends), so an importer's dry run predicts the real run on every backend.
   * A hit the writer cannot persist (pack, readonly, another scope's remote
   * cache) answers null. Secret refusal is the caller's own check.
   */
  wouldDeduplicate(statement: string, context?: LearnContext): Promise<string | null>

  /**
   * The scope learn() would write `statement` into (after the sensitive-scope
   * guard and routing), and whether learn()'s dedup there also matches a row
   * of ANOTHER scope in the primary store. False on a
   * delegating store (Postgres/PGLite: scopes are a permission boundary, see
   * learn()) and for a writable-remote scope (`_crossScopeRecurrenceApplies`).
   * Writes nothing. The importer's dry run keys its in-file duplicate map with
   * it, so two records of one file in different scopes are predicted as the
   * real run treats them.
   */
  dedupScopeFor(statement: string, context?: LearnContext): Promise<{ scope: string; acrossScopes: boolean }>
}

export const scopeGuardsMethods: ScopeGuardsMethods & ThisType<Plur> = {
  getScopeMetadata(scope: string): ScopeMetadata | undefined {
    const entry = (this.config.stores ?? []).find(
      s => s.scope === scope &&
        (s.description !== undefined || s.covers !== undefined || s.sensitivity !== undefined),
    )
    if (!entry) return undefined
    return {
      scope,
      description: entry.description ?? '',
      covers: entry.covers ?? [],
      ...(entry.sensitivity ? { sensitivity: entry.sensitivity } : {}),
    }
  },

  listScopeMetadata(): ScopeMetadata[] {
    const seen = new Set<string>()
    const out: ScopeMetadata[] = []
    for (const s of this.config.stores ?? []) {
      if (seen.has(s.scope)) continue
      const md = this.getScopeMetadata(s.scope)
      if (md) { out.push(md); seen.add(s.scope) }
    }
    return out
  },

  // Synchronous: it does no async work.
  _writableScopeMetadata(): ScopeMetadata[] {
    return this.listScopeMetadata().filter(md => {
      const entry = (this.config.stores ?? []).find(s => s.scope === md.scope)
      return entry?.readonly !== true
    })
  },

  previewAutoRoute(input: ScopeSignals): AutoRouteDecision {
    this.reloadConfigIfChanged()
    if (this.config.auto_route_scope === false) {
      return { action: 'no-match', scope: null, candidate: null, refusedShared: null }
    }
    const cfg = this.config.scope_routing ?? {}
    const candidates = rankScopes(
      input,
      this._writableScopeMetadata(),
      cfg.weight_tag !== undefined ? { weightTag: cfg.weight_tag } : undefined,
    )
    return decideAutoRoute(candidates, {
      matchThreshold: cfg.match_threshold ?? SCOPE_MATCH_THRESHOLD,
      allowSharedScope: cfg.allow_shared_auto_route === true,
      refuseScope: s => this._refuseRemotePersonalAutoRoute(s),
    })
  },

  suggestScope(input: ScopeSignals, options?: { minConfidence?: number }): ScopeCandidate[] {
    this.reloadConfigIfChanged()  // pick up out-of-process config edits
    const minConfidence =
      options?.minConfidence ?? this.config.scope_routing?.min_confidence ?? 0
    return rankScopes(input, this.listScopeMetadata(), { minConfidence })
  },

  getScopeRoutingConfig(): Readonly<ScopeRoutingConfig> {
    this.reloadConfigIfChanged()
    return { ...(this.config.scope_routing ?? {}) }
  },

  _offendingHitsForScope(statement: string, scope: string): SecretMatch[] {
    // Guard runs when data can leave the machine: a SHARED scope (others read it)
    // OR a REMOTE-backed scope (routes to a remote store). A scope that is neither
    // — `global`/`local`/a local-file store — stays on this machine, so there is
    // nothing to leak and the demotion target (local) is where it lives anyway.
    // "Remote-backed" here is ANY url store with this exact scope, not the
    // personal-store selection: callers that PATCH or push to a concrete url
    // entry rely on this scan.
    if (!isSharedScope(scope) && !this._hasUrlStoreForScope(scope)) return []
    const hits = detectSensitive(statement)
    if (hits.length === 0) return []
    const policy = this.getScopeMetadata(scope)?.sensitivity
    // An EMPTY forbid list means "not configured", not "forbid nothing".
    // Omitting the block already says "forbid nothing", and a layer that
    // normalises a partial policy may fill absent keys with empty arrays; an
    // explicit `[]` must not switch this scope's scan off while making it look
    // more governed than a scope with no policy. Length check rather than `??`,
    // so both shapes default.
    const forbid = new Set<SensitivityCategory>(
      policy?.forbid && policy.forbid.length > 0 ? policy.forbid : ['secrets', 'infra'],
    )
    const allow = new Set<string>(policy?.allow ?? [])
    return hits.filter(h => {
      // Fail-closed: a truncated-scan signal is always offending — the
      // unscanned tail can't be certified clean, and no scope policy may allow it.
      if (h.pattern === SCAN_TRUNCATED) return true
      const category = sensitivityCategory(h.pattern)
      if (allow.has(category) || allow.has(h.pattern)) return false
      return forbid.has(category)
    })
  },

  _engramContextFields(engram: Engram): Record<string, unknown> | undefined {
    return engramContentFields(engram)
  },

  _guardExplicitUpdate(statement: string, scope: string, isRemote: boolean, contextFields?: Record<string, unknown>): { scope: string; visibility: 'private' } | null {
    // Scan statement + context fields (mirrors _guardSensitiveScope). Omit the
    // context join entirely when there are no fields so a clean-statement scan
    // reads exactly the statement.
    const scanText = contextFields
      ? `${statement}\n${JSON.stringify(contextFields)}`
      : statement
    const offending = this._offendingHitsForScope(scanText, scope)
    if (offending.length === 0) return null
    const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
    if (isRemote) {
      throw new Error(
        `Cannot update a shared/remote engram with sensitive content: ${patterns}. ` +
        `Use a local scope or config.allow_secrets.`,
      )
    }
    logger.warning(
      `[plur] sensitive content (${patterns}) held back from shared scope "${scope}" — ` +
      `demoted to local/private so it is not written to a shared store. ` +
      `Re-scope deliberately if this is a false positive.`,
    )
    return { scope: 'local', visibility: 'private' }
  },

  async _resolveUnscopedScope(statement: string, context?: LearnContext): Promise<{ scope: string; routed: { scope: string; confidence: number; reason: string } | null; refusedShared: { scope: string; confidence: number; reason: string } | null }> {
    // Pick up out-of-process config edits, so a scope registered (or covers
    // synced) by another process after startup is visible to auto-routing.
    // Cheap: one statSync, reload only on an actual mtime change.
    this.reloadConfigIfChanged()
    // Match the schema default (config.ts `unscoped_default.default('global')`)
    // so the two cannot drift.
    const fallback = this.config.unscoped_default ?? 'global'
    if (this.config.auto_route_scope === false) {
      return { scope: fallback, routed: null, refusedShared: null }
    }
    // Exclude readonly / non-writable scopes from the AUTO-ROUTE candidate set
    // so a clean unscoped write is never LABELED as routed to a scope a write
    // can't land on. This is reporting, not write safety:
    // `_resolveRemoteStoreForScope` already skips readonly stores. `readonly`
    // applies to both path- and url-based stores, so this view covers both.
    // `listScopeMetadata()` and `suggestScope()` still surface readonly scopes.
    const writableScopeMetadata = this._writableScopeMetadata()
    // Scope-routing tuning: enterprise installs with many narrow,
    // covers-rich scopes can raise `match_threshold` to cut false-positive
    // routing, or adjust `weight_tag` to re-weight tag-only signals. Both default
    // to the module constants in scope-routing.ts; WEIGHT_DOMAIN stays hardcoded —
    // the lone-domain-clears-threshold invariant (THRESHOLD_SINGLE_DOMAIN) is
    // load-bearing and must not be tunable.
    const scopeRoutingCfg = this.config.scope_routing ?? {}
    const matchThreshold = scopeRoutingCfg.match_threshold ?? SCOPE_MATCH_THRESHOLD
    const weightTagOverride = scopeRoutingCfg.weight_tag
    const candidates = rankScopes(
      { statement, domain: context?.domain, tags: context?.tags },
      writableScopeMetadata,
      weightTagOverride !== undefined ? { weightTag: weightTagOverride } : undefined,
    )
    // ONE decision function, shared with `previewAutoRoute`, so the write path
    // and `plur_suggest_scope` cannot disagree. A forward domain match routes
    // deterministically; weaker matches stay gated by `matchThreshold`.
    // SHARED candidates are refused unless the install opted in (a push to a
    // team remote cannot be undone locally); a URL-backed personal scope that is
    // not the user's own `/me` namespace is refused the same way. The next
    // eligible PERSONAL candidate still wins.
    const decision = decideAutoRoute(candidates, {
      matchThreshold,
      allowSharedScope: scopeRoutingCfg.allow_shared_auto_route === true,
      refuseScope: s => this._refuseRemotePersonalAutoRoute(s),
    })
    const marker = (c: ScopeCandidate) => ({ scope: c.scope, confidence: c.confidence, reason: c.reason })
    const refusedShared = decision.refusedShared ? marker(decision.refusedShared) : null
    if (decision.action === 'route' && decision.scope && decision.candidate) {
      return { scope: decision.scope, routed: marker(decision.candidate), refusedShared }
    }
    // Both 'refuse-shared' and 'no-match' fall to the unscoped default. The
    // refusal travels separately so the caller can say what it declined to do,
    // rather than reporting a plain unrouted write.
    return { scope: fallback, routed: null, refusedShared }
  },

  _hardScanText(statement: string, context: LearnContext | undefined): string {
    const content = learnContextContent(context)
    return content ? `${statement}\n${JSON.stringify(content)}` : statement
  },

  async _guardSensitiveScope(statement: string, context?: LearnContext): Promise<{ scope: string; context: LearnContext | undefined; demotion: { from: string; to: string; patterns: string } | null; routed: { scope: string; confidence: number; reason: string } | null; refusedShared: { scope: string; confidence: number; reason: string } | null; scopeSource: ScopeSource }> {
    // Every egress decision below reads the CURRENT config, so an
    // explicit-scope write in a long-running process is not guarded against a
    // `sensitivity` policy another process has since tightened. One statSync;
    // reloads only on an mtime change.
    this.reloadConfigIfChanged()
    // remote-only folder: the folder's team scope
    // is the default, nothing is auto-routed, and anything that would stay on
    // this machine is refused rather than written — including the sensitive
    // content the guard below would otherwise demote to local.
    if (this._remoteOnly) {
      context = this._remoteOnlyContext(context)
      const scope = context!.scope!
      const scanText = `${statement}\n${JSON.stringify(context ?? {})}`
      const offending = this._offendingHitsForScope(scanText, scope)
      if (offending.length > 0) {
        const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
        throw this._remoteOnlyError('sensitive', scope, patterns)
      }
      return { scope, context, demotion: null, routed: null, refusedShared: null, scopeSource: 'session' }
    }
    // "Truly unscoped" = caller passed no scope AND no session/`.plur.yaml`
    // default is in effect (both land in the session scope registry). Only this
    // path auto-routes / applies unscoped_default; everything else is honored
    // as-is.
    //
    // The session scope is resolved for THIS call's session (`context.session`),
    // not read off a shared field, so one session's `setSessionScope` cannot
    // decide another session's write. See `session-scopes.ts`.
    const sessionScope = this._sessionScopes.get(context?.session) ?? this._gitFolderScope()
    let routed: { scope: string; confidence: number; reason: string } | null = null
    let refusedShared: { scope: string; confidence: number; reason: string } | null = null
    let scope: string
    // WHO chose this scope. The decision is made here and nowhere else, so it
    // is recorded here rather than inferred later from the absence of a
    // `_routed` marker — "the caller named it" and "nothing named it and the
    // default applied" are different facts and both are absent-marker cases.
    let scopeSource: ScopeSource
    if (context?.scope == null && sessionScope == null) {
      const resolved = await this._resolveUnscopedScope(statement, context)
      scope = resolved.scope
      routed = resolved.routed
      refusedShared = resolved.refusedShared
      scopeSource = resolved.routed ? 'routed' : 'default'
    } else {
      // Terminal fallback respects unscoped_default so a `unscoped_default:'local'`
      // user with no session scope and no context scope is not silently forced
      // to global.
      scope = context?.scope ?? sessionScope ?? (this.config.unscoped_default ?? 'global')
      // A session / `.plur.yaml` scope is a human's standing choice, not a
      // guess — deliberate, but not stated on this call, which is a distinction
      // a server reviewing writes may reasonably care about.
      scopeSource = context?.scope != null ? 'explicit' : 'session'
    }
    // A personal `user:` scope that names a configured store under a
    // different case writes to that store under ITS configured scope — the
    // same case-folded, exact-first, single-entry match the recall dial uses
    // (`_canonicalPersonalScope`). Every configured store counts, path-backed
    // ones included, so a scope that exactly names a LOCAL store is never
    // redirected to a remote case twin.
    const canonical = this._canonicalPersonalScope(scope)
    if (canonical !== scope) {
      // On the auto-routing path the router already judged `scope` with the
      // "me-only" ownership check. The rewrite must not carry
      // the write past that check to a different destination: judge the
      // rewritten scope again and keep the original when it is refused.
      if (scopeSource === 'routed' && this._refuseRemotePersonalAutoRoute(canonical)) {
        logger.warning(`[plur:learn] auto-routed scope=${scope} not rewritten to ${canonical}: not your own remote namespace`)
      } else {
        scope = canonical
        if (context?.scope != null) context = { ...context, scope }
      }
    }
    // Guard fires when the write can leave the machine: shared scope (others can
    // read it) OR remote-backed scope (routes to a remote store, e.g. a personal
    // `user:` scope on a remote server). Purely-local scopes (`global`/`local`/
    // local-file stores) stay on this machine and are exempt — same gate as
    // _offendingHitsForScope, kept in sync because this short-circuits before it.
    // The scan gate is "a url store has this exact scope" (`_hasUrlStoreForScope`),
    // not the personal-store selection.
    if (!isSharedScope(scope) && !this._hasUrlStoreForScope(scope)) {
      return { scope, context, demotion: null, routed, refusedShared, scopeSource }
    }
    // Scan the FULL content the engram will carry — the statement AND the
    // context fields (rationale, key_files, source, …), not just the statement.
    // Sensitive material hides in context too.
    const scanText = `${statement}\n${JSON.stringify(context ?? {})}`
    // Single source of truth for the offending-hit policy.
    const offending = this._offendingHitsForScope(scanText, scope)
    if (offending.length === 0) return { scope, context, demotion: null, routed, refusedShared, scopeSource }

    const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
    logger.warning(
      `[plur] sensitive content (${patterns}) held back from shared scope "${scope}" — ` +
      `demoted to local/private so it is not written to a shared store. ` +
      `Re-scope deliberately if this is a false positive.`,
    )
    // Preserve `routed` through demotion: an auto-routed SHARED scope carrying
    // sensitive content is both routed AND demoted — surfacing both is correct.
    return {
      scope: 'local',
      context: { ...context, scope: 'local', visibility: 'private' },
      demotion: { from: scope, to: 'local', patterns },
      routed,
      refusedShared,
      // The demotion overrode the destination; it did not change who picked it.
      scopeSource,
    }
  },

  _validatedMeasuredUnder(context: LearnContext | undefined): MeasuredUnder | undefined {
    const raw = context?.measured_under
    if (raw === undefined || raw === null) return undefined
    const parsed = MeasuredUnderSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      throw new TypeError(`plur.learn: invalid measured_under — ${issues}. Every dimension must be a string.`)
    }
    return parsed.data
  },

  _validateLearnInput(fn: 'learn' | 'learnRouted', statement: string, context?: LearnContext): string {
    if (typeof statement !== 'string' || statement.length === 0) {
      throw new TypeError(`plur.${fn}: statement must be a non-empty string, got ${typeof statement}`)
    }
    statement = collapseLineTerminators(statement)
    if (context?.type !== undefined && !VALID_ENGRAM_TYPES.has(context.type)) {
      throw new TypeError(
        `plur.${fn}: invalid type '${context.type}'. Must be one of: behavioral, terminological, procedural, architectural`
      )
    }
    // Pinned two-tier fields. Nothing Zod-validates an engram before save, so
    // an out-of-range priority written here would be stored verbatim — and a
    // 9999 sorts ahead of every legitimately prioritised pin.
    if (context?.pin_tier !== undefined && context.pin_tier !== 'hard' && context.pin_tier !== 'soft') {
      throw new TypeError(`plur.${fn}: invalid pin_tier '${String(context.pin_tier)}'. Must be "hard" or "soft"`)
    }
    if (context?.pinned_priority !== undefined) {
      const p = context.pinned_priority
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 100) {
        throw new TypeError(`plur.${fn}: pinned_priority must be an integer from 1 to 100, got ${String(p)}`)
      }
    }
    if (!this.config.allow_secrets) {
      // Scan the statement AND every caller-supplied content field. The field
      // set comes from ONE table, `LEARN_CONTEXT_FIELD_ROLES`, checked against
      // `LearnContext` by the compiler, so no field goes unscanned.
      // Shared/remote writes are additionally policy-scanned by
      // _guardSensitiveScope below.
      const secrets = detectSecrets(this._hardScanText(statement, context))
      if (secrets.length > 0) {
        throw new Error(`Secret detected in statement or context: ${secrets[0].pattern}. Use config.allow_secrets to override.`)
      }
    }
    // Prompt-injection check for auto-harvested writes: text an agent merely
    // READ can carry attacker-authored content. Gate on `claim_class: 'inferred'`
    // (set by every automatic harvester, never by a human `plur_learn`), not on
    // free-text `source`, so human writes are untouched. Refuse rather than
    // quarantine, like the secret check: there is no review queue for engram
    // writes, and a genuine user statement can be written as `asserted`.
    if (context?.claim_class === 'inferred') {
      const injections = detectPromptInjection(this._hardScanText(statement, context))
      if (injections.length > 0) {
        throw new Error(
          `Prompt injection pattern detected in an auto-harvested (claim_class: 'inferred') statement or context: `
          + `${injections[0].pattern}. Refusing the write.`,
        )
      }
    }
    return statement
  },

  _learnCanDelegate(): boolean {
    const ps = this._primaryStore
    return Boolean(
      ps.findActiveByContentHash && ps.nextEngramId
      && ps.append && ps.updateMany && ps.loadByIds,
    )
  },

  async _learnHashMatch(statement: string, scope: string, canDelegate: boolean, allEngrams: Engram[]): Promise<{ primaryHashMatch: Engram | null; hashMatch: Engram | null; foreign: Engram | null }> {
    const primaryHashMatch = canDelegate && isHashable(statement)
      ? await this._primaryStore.findActiveByContentHash!(computeContentHash(statement), scope)
      : null
    // A queued remote-only save never absorbs a write.
    if (primaryHashMatch && !isRemoteOnlyQueued(primaryHashMatch)) return { primaryHashMatch, hashMatch: primaryHashMatch, foreign: null }
    const { hit, foreign } = await this._firstPersistableHit(
      allEngrams, this._hashDedupPredicate(statement, scope), scope,
    )
    return { primaryHashMatch: null, hashMatch: hit, foreign }
  },

  _hashDedupPredicate(statement: string, scope?: string): ((e: Engram) => boolean) | null {
    if (!isHashable(statement)) return null
    const hash = computeContentHash(statement)
    return e => e.status === 'active' && (e as any).content_hash === hash
      && (scope === undefined || e.scope === scope)
  },

  _crossScopePredicate(statement: string, scope: string): ((e: Engram) => boolean) | null {
    if (!isHashable(statement)) return null
    const hash = computeContentHash(statement)
    return e => e.status === 'active' && (e as any).content_hash === hash && e.scope !== scope
  },

  async _hitHolder(hit: Engram, scope: string): Promise<'primary' | 'secondary' | 'own-remote' | 'pack' | 'readonly' | 'remote-cache'> {
    if ((hit as any)._pack) return 'pack'
    const storeScope = (hit as any)._storeScope as string | undefined
    if (storeScope === undefined) return 'primary'
    const info = await this._findEngramStore(hit.id, storeScope)
    if (info) {
      if (info.path === this.paths.engrams) return 'primary'
      return info.readonly ? 'readonly' : 'secondary'
    }
    // A URL store's cache row (or a path row that vanished meanwhile — then no
    // writable URL entry matches either, and it is treated as not persistable).
    const urlEntries = (this.config.stores ?? []).filter(s => !!s.url && s.scope === storeScope)
    if (!urlEntries.some(s => s.readonly !== true)) return 'readonly'
    // Own only when a write to `scope` actually goes to that url store: with a
    // local store selected for the identical personal scope the write stays
    // local, so the cached row must not absorb it.
    return storeScope === scope && this._isRemoteWriteScope(scope) ? 'own-remote' : 'remote-cache'
  },

  async _firstPersistableHit(candidates: Engram[], pred: ((e: Engram) => boolean) | null, scope: string | undefined): Promise<{ hit: Engram | null; foreign: Engram | null }> {
    let foreign: Engram | null = null
    if (!pred) return { hit: null, foreign }
    for (const e of candidates) {
      if (!pred(e)) continue
      const holder = await this._hitHolder(e, scope ?? e.scope)
      if (holder === 'primary' || holder === 'secondary' || holder === 'own-remote') return { hit: e, foreign }
      foreign ??= e
    }
    return { hit: null, foreign }
  },

  async _persistableCandidates(rows: Engram[]): Promise<Engram[]> {
    const out: Engram[] = []
    for (const e of rows) {
      const holder = await this._hitHolder(e, e.scope)
      if (holder === 'primary' || holder === 'secondary' || holder === 'own-remote') out.push(e)
    }
    return out
  },

  async _crossScopeMatch(statement: string, allEngrams: Engram[], scope: string, opts?: { creditOnly?: boolean }): Promise<{ hit: Engram | null; foreign: Engram | null }> {
    // `creditOnly`: the caller only CREDITS the hit and writes anyway (the
    // remote route), so the absorb rule below does not apply.
    if (!opts?.creditOnly && !this._crossScopeRecurrenceApplies(scope)) return { hit: null, foreign: null }
    const pred = this._crossScopePredicate(statement, scope)
    // For a SHARED write a shared hit is preferred, the same order as
    // `_crossScopeRecurrenceDetect`. The hit is only credited either way
    // (`_isTeamValidation`).
    if (pred && isSharedScope(scope)) {
      const shared = await this._firstPersistableHit(allEngrams, e => pred(e) && isSharedScope(e.scope), scope)
      if (shared.hit) return shared
      const any = await this._firstPersistableHit(allEngrams, pred, scope)
      return { hit: any.hit, foreign: shared.foreign ?? any.foreign }
    }
    return this._firstPersistableHit(allEngrams, pred, scope)
  },

  async _noteUnpersistableRecurrence(hit: Engram, scope: string, storedAs: string): Promise<void> {
    try {
      const heldIn = await this._hitHolder(hit, scope)
      this._appendHistory({
        event: 'recurrence_detected',
        engram_id: hit.id,
        timestamp: new Date().toISOString(),
        data: {
          previous_scope: hit.scope,
          new_scope: hit.scope,
          previous_commitment: hit.commitment ?? null,
          new_commitment: hit.commitment ?? null,
          // The hit's own count, unchanged: nothing was written to it.
          recurrence_count: (hit as any).recurrence_count ?? 0,
          from_scope: scope,
          matched: hit.scope === scope ? 'same-scope' : 'cross-scope',
          held_in: heldIn,
          persisted_to: 'history-only',
          stored_as: storedAs,
        },
      })
    } catch { /* history is an audit trail, never a gate on the write */ }
  },

  async wouldDeduplicate(statement: string, context?: LearnContext): Promise<string | null> {
    const guarded = await this._guardSensitiveScope(statement, context)
    const scope = guarded.scope
    const canDelegate = this._learnCanDelegate() && !this._remoteOnly
    const allEngrams = this._remoteOnly
      ? await this._writeDedupCorpus(scope)
      : canDelegate ? await this._loadSecondaryAndPacks() : await this._loadAllEngrams()
    const { hashMatch } = await this._learnHashMatch(statement, scope, canDelegate, allEngrams)
    if (hashMatch) return hashMatch.id
    // A cross-scope hit absorbs only a non-shared save. A shared save is
    // credited and written anyway.
    const { hit } = await this._crossScopeMatch(statement, allEngrams, scope)
    return hit && !this._isTeamValidation(scope, hit) ? hit.id : null
  },

  async dedupScopeFor(statement: string, context?: LearnContext): Promise<{ scope: string; acrossScopes: boolean }> {
    const { scope } = await this._guardSensitiveScope(statement, context)
    // A shared save is never absorbed by another scope's row, so its in-file
    // duplicates are keyed by (hash, scope) as well.
    return { scope, acrossScopes: !this._learnCanDelegate() && this._crossScopeRecurrenceApplies(scope) && !isSharedScope(scope) }
  },
}
