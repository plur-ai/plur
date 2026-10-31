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
/** Create engram with content hash + commitment + cognitive level.
   * Fast-path hash dedup returns existing on exact match.
   */
/**
   * Resolve self-describing metadata for a scope from the loaded config (#345).
   * Metadata is carried on a `stores` entry: the first entry whose `scope`
   * matches and that declares any metadata field (`description`/`covers`/
   * `sensitivity`) is materialized into a {@link ScopeMetadata}. Returns
   * `undefined` when the scope is unknown or declares no metadata — callers
   * (notably the leak guard) treat that as "fall back to default behavior".
   *
   * This is the Stage 2 local resolver. The enterprise `/api/v1/scopes` source
   * is a separate track; when it lands it can back this same accessor.
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
   * Suggest which registered scope(s) an engram belongs in, ranked by fit
   * (#345/#346, Stage 3a). Deterministic — NO LLM, NO network. Scores the
   * engram's signals (statement keywords, `domain` namespace, `tags`) against
   * the `covers[]` each scope declares (see {@link rankScopes} for the weights).
   *
   * ADVISORY ONLY. This does NOT route or store anything — `learn()` /
   * `learnRouted()` ignore it. The auto-route behavior flip is the gated Stage
   * 3b PR; this method just answers "where would this fit?".
   *
   * `options.minConfidence` (#670) floors the returned list — candidates
   * strictly below it are dropped. Precedence: explicit option >
   * `scope_routing.min_confidence` config > 0 (unfiltered, the historical
   * default). This floors the SUGGESTION surface only; the auto-route gate is
   * `scope_routing.match_threshold` and is deliberately independent. Returns
   * candidates sorted by confidence descending — an empty array means nothing
   * matched OR every match fell below the floor.
   */
/**
   * Registered scopes eligible as an AUTO-ROUTE target: those declaring
   * metadata, minus readonly stores (MED-12). Shared by the write path and
   * {@link previewAutoRoute} so the two cannot rank different candidate sets —
   * the same drift #1115 is about, one level up from the decision itself.
   */
/** @internal */
_writableScopeMetadata(): ScopeMetadata[]

/**
   * What a genuinely-unscoped write of these signals WOULD do (#1115).
   *
   * `suggestScope` ranks; this decides. They answered differently before: the
   * ranker weighs domain, tags and statement keywords, while the write path
   * routed a forward domain-prefix match deterministically and ignored the rest.
   * A user could consult the suggestion tool and then write without a scope and
   * land somewhere else. Both now go through `decideAutoRoute`, so a suggestion
   * surface can report the real outcome instead of an approximation of it.
   */
previewAutoRoute(input: ScopeSignals): AutoRouteDecision

suggestScope(input: ScopeSignals, options?: { minConfidence?: number }): ScopeCandidate[]

/**
   * Read-only view of the `scope_routing` config block (#670). Lets display
   * surfaces (the MCP `plur_suggest_scope` handler) resolve the configured
   * suggestion floor without reaching into the private config — precedence at
   * that surface is: explicit tool arg > this config value >
   * SUGGEST_DISPLAY_MIN_CONFIDENCE.
   */
getScopeRoutingConfig(): Readonly<ScopeRoutingConfig>

/**
   * Write-time leak guard. If the target scope can let data leave the machine —
   * either SHARED (`isSharedScope`: group:/project:/space:/team:/org:/public, so
   * others can read it) OR REMOTE-backed (`_hasUrlStoreForScope`: routes to a
   * remote store, e.g. a personal `user:` scope on plur.datafund.io) — AND the
   * statement trips `detectSensitive` (IPs, internal hosts, basic-auth, host:port,
   * secrets), DEMOTE to a private local scope — the engram is kept but never
   * written to a shared/remote store — and warn. Purely-local scopes
   * (`global`/`local`/local-file stores) are exempt: infra notes legitimately
   * live there and never leave the machine. Called at the top of both
   * `learn()` and `learnRouted()`, so every client (CLI, MCP, hooks, OpenClaw,
   * Hermes) is covered, since they all route through one of those two.
   *
   * Per-scope policy (#345): when the target scope declares `sensitivity`
   * metadata, that policy decides demotion. A matched category is tolerated when
   * it is in `sensitivity.allow` (by category name OR by the specific detector
   * pattern name) OR not in `sensitivity.forbid`. Only categories that are both
   * forbidden and not allowed trigger demotion. When the scope has NO metadata,
   * this falls back EXACTLY to the Stage 1 behavior: any `detectSensitive` hit on
   * a shared scope demotes. The default policy (`forbid: ['secrets','infra']`,
   * `allow: []`) reproduces that demote-on-sensitive behavior, so adding metadata
   * is non-breaking.
   */
/**
   * Single source of truth for "does this content carry sensitivity that scope
   * `scope` forbids?". Returns the offending {@link SecretMatch} hits, or `[]`
   * when there are none.
   *
   * Scope discipline: data can leak when the scope is SHARED (`isSharedScope`,
   * others can read it) OR REMOTE-backed (`_hasUrlStoreForScope`, it routes off
   * this machine — e.g. a `user:` scope on plur.datafund.io). For a scope that is
   * neither — `global`/`local`/a local-file store — this returns `[]`
   * unconditionally: infra notes legitimately live in local storage, the content
   * never leaves the machine, and the demotion target is local anyway, so a local
   * write is always coherent.
   *
   * Policy: scan `text` with `detectSensitive`, then keep only the hits the
   * scope's per-scope `sensitivity` policy forbids. With no scope metadata the
   * default policy is `forbid:['secrets','infra'], allow:[]` — i.e. every hit is
   * offending (the Stage 1 behavior). A hit is tolerated when its category is in
   * `allow` (by category name OR by the specific detector pattern name) or when
   * its category is not in `forbid`.
   *
   * Used by `_guardSensitiveScope` (the learn/learnRouted guard) AND by the
   * mutation-path guards (learnAsync UPDATE/MERGE, reportFailure, updateEngram)
   * so there is exactly one definition of "offending".
   */
/** @internal */
_offendingHitsForScope(statement: string, scope: string): SecretMatch[]

/**
   * Everything on an engram, apart from its statement, for the explicit-update /
   * meta / outbox-reguard / rescope leak scan (LOW-2, #353).
   *
   * This used to be a hand-kept list of context-ish fields that had to mirror
   * `LearnContext`, and it drifted three times (#381, #405, and the #1002
   * review: `attribution`, `claim_class` and `provenance.license` were added to
   * the write path and not here, so a credential in `attribution.asserted_by`
   * rescoped from local into a shared scope unscanned). It now serialises the
   * whole engram — see `engramContentFields` for the one deliberate exclusion —
   * so a field that reaches the engram by any route is scanned by construction.
   */
/** @internal */
_engramContextFields(engram: Engram): Record<string, unknown> | undefined

/**
   * Leak guard for the EXPLICIT-update mutation path (`updateEngram` /
   * `updateEngramAsync`). Unlike learn/learnAsync, the caller hands us a fully
   * formed engram and chose its scope deliberately, so the response differs by
   * residence (#353):
   *
   * - REMOTE-resident (`isRemote: true`): there is no coherent demotion (we
   *   can't silently re-scope an engram living on someone else's server), so a
   *   forbidden hit THROWS — mirroring the hard `detectSecrets` guard. The
   *   caller must re-scope locally or set `config.allow_secrets`.
   * - LOCAL-resident: a forbidden hit DEMOTES in place (scope→'local',
   *   visibility→'private') and warns. Returns the override the caller applies
   *   before persisting; returns `null` when the statement is clean.
   *
   * LOW-2 (#353): scan the FULL content like `_guardSensitiveScope`, not just
   * `statement`. Callers pass the engram's context-ish fields (rationale,
   * source, snippet, dual_coding, structured_data) via `contextFields`; we
   * serialize them onto the scan text so a credential hiding in a context field
   * is caught. The 64KB byte-aware truncation (PR-2) is applied inside
   * `detectSensitive` (reached via `_offendingHitsForScope`), so the scan is
   * bounded here too.
   */
/** @internal */
_guardExplicitUpdate(statement: string, scope: string, isRemote: boolean, contextFields?: Record<string, unknown>): { scope: string; visibility: 'private' } | null

/**
   * Resolve the scope for a write whose caller supplied NO explicit scope and
   * for which no session/`.plur.yaml` default is in effect — the genuinely
   * UNSCOPED case (Stage 3b, #351). Two non-explicit signals decide it:
   *
   *  - `config.auto_route_scope` (default true): run the deterministic
   *    {@link suggestScope} ranker over the registered scopes' `covers[]`.
   *      - If the top writable candidate matched via a FULL domain-prefix
   *        (`domainMatch`), route to it DETERMINISTICALLY — bypass the
   *        squash/threshold. A full domain match is the strongest, most
   *        deliberate routing signal; under the current weights a LONE domain
   *        match squashes to EXACTLY {@link SCOPE_MATCH_THRESHOLD} (0.5) and
   *        would route only via the edge-of-threshold `>=` gate (#353 PR-6).
   *        The deterministic bypass removes that fragility with headroom and is
   *        independent of the weight curve.
   *      - Otherwise (tag-only / keyword-only — NO domain match): apply the
   *        threshold to the squashed confidence exactly as before. Weak signals
   *        stay gated — only a genuine domain-prefix match gets the bypass.
   *  - otherwise (auto_route_scope false): fall to `config.unscoped_default`.
   *
   * INERT until scopes declare `covers` (Stage 5): with no `covers` the ranker
   * returns `[]` and every unscoped write falls to `unscoped_default`. Both
   * `local` and `global` are PERSONAL scopes, so this is an organizational
   * default, not a leak-safety control — the sensitivity guard runs AFTER this
   * and still demotes an auto-routed SHARED scope carrying sensitive content.
   *
   * Returns the resolved scope and, when auto-routing fired, a `routed` marker
   * `{ scope, confidence, reason }`; `routed` is null on the `unscoped_default`
   * fall-through (so an explicit/default `global` is never mislabeled as routed).
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

/** @internal */
_guardSensitiveScope(statement: string, context?: LearnContext): Promise<{ scope: string; context: LearnContext | undefined; demotion: { from: string; to: string; patterns: string } | null; routed: { scope: string; confidence: number; reason: string } | null; refusedShared: { scope: string; confidence: number; reason: string } | null; scopeSource: ScopeSource }>

/**
   * `measured_under` as it may be persisted (#869 review): validated against
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
   * The input gate every learn path runs before touching a store.
   *
   * The statement must be a non-empty string; line terminators are collapsed
   * so a crafted boundary cannot be promoted to system-prompt authority by the
   * renderer's splitter (#952, #940); the type must be a known engram type —
   * checked BEFORE the secret scan (#729) so a bad type fails loudly even when
   * the statement would also trip the detector; and, unless
   * `config.allow_secrets`, the statement plus every caller-supplied content
   * field — as listed by `LEARN_CONTEXT_FIELD_ROLES`, which the compiler
   * checks against `LearnContext` (#381, #389, #1002 review) — must carry no
   * secret. Shared/remote writes are additionally policy-scanned by
   * `_guardSensitiveScope`.
   *
   * `learn()` and `learnRouted()` both call it on entry. learnRouted must,
   * because on its remote route it never enters learn(): it posts the shape it
   * builds and the outbox fallback writes that same shape locally — a gate
   * living only in learn() would miss the CLI and the Python SDK, and the
   * highest-impact variant (a forged entry on a SHARED store reaching other
   * people's system prompts). Idempotent, so the local route gating twice is
   * harmless. Returns the sanitised statement, which every downstream gate
   * and the content hash must see. One function (2026-09 audit): it used to
   * be two inline copies that had already diverged on the empty-statement
   * check.
   */
/** @internal */
_validateLearnInput(fn: 'learn' | 'learnRouted', statement: string, context?: LearnContext): string

/** learn()'s delegation test (#828) — the capability SET, see learn(). */
/** @internal */
_learnCanDelegate(): boolean

/** learn()'s same-scope content-hash dedup: the store seam first (a primary
   *  match has always won), then the in-memory scan. One implementation for
   *  learn(), learnRouted(), learnAsync's hash step and {@link wouldDeduplicate}.
   *
   *  Decision A ("always store my write", owner 2026-09-27): only a hit the
   *  writer can persist absorbs the write (`hashMatch`). A match held only
   *  where the writer cannot persist it — a pack, a readonly store, another
   *  scope's remote cache — comes back as `foreign`: the caller stores a new
   *  row and records the recurrence against it in history only. */
/** @internal */
_learnHashMatch(statement: string, scope: string, canDelegate: boolean, allEngrams: Engram[]): Promise<{ primaryHashMatch: Engram | null; hashMatch: Engram | null; foreign: Engram | null }>

/** `_hashDedup`'s match rule as a predicate (null: nothing can match, #896). */
/** @internal */
_hashDedupPredicate(statement: string, scope?: string): ((e: Engram) => boolean) | null

/** `_crossScopeRecurrenceDetect`'s match rule as a predicate. */
/** @internal */
_crossScopePredicate(statement: string, scope: string): ((e: Engram) => boolean) | null

/**
   * Where a dedup hit lives, as far as a writer to `scope` is concerned
   * (Decision A). `primary`, a writable `secondary` path store, and
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

/** Decision A for learnAsync's dedup candidates: keep only rows the writer
   *  can persist (`_hitHolder` of the row in its own scope). */
/** @internal */
_persistableCandidates(rows: Engram[]): Promise<Engram[]>

/** #176 cross-scope match over `allEngrams`, split by Decision A like
   *  {@link _learnHashMatch}. Nothing when `_crossScopeRecurrenceApplies`
   *  says a cross-scope hit may not absorb a write into `scope`. */
/** @internal */
_crossScopeMatch(statement: string, allEngrams: Engram[], scope: string, opts?: { creditOnly?: boolean }): Promise<{ hit: Engram | null; foreign: Engram | null }>

/**
   * Decision A: the write was stored as `storedAs` although its statement was
   * already held by `hit`, which the writer cannot persist (pack, readonly
   * store, another scope's remote cache). The hit is NOT mutated — not on disk
   * and not in memory; the recurrence is recorded in history only.
   */
/** @internal */
_noteUnpersistableRecurrence(hit: Engram, scope: string, storedAs: string): Promise<void>

/**
   * Would `learn(statement, context)` resolve to an EXISTING engram instead of
   * writing a new one? Returns that engram's id, or null. Writes nothing.
   *
   * Same scope resolution (`_guardSensitiveScope`) and the same dedup code as
   * learn(): the same-scope hash match (store seam or scan), then cross-scope
   * recurrence over the corpus learn() scans — which on a delegating store
   * (Postgres/PGLite) deliberately excludes the primary store (scopes are a
   * permission boundary there). So a dry run — the importer's — predicts the
   * real run on every backend (R2-Retrieval core-retrieval#10 residual).
   * Covers learn()'s local dedup; secret refusal is the caller's own check.
   *
   * Decision A: a hit the writer cannot persist (pack, readonly store, another
   * scope's remote cache) does not count — learn() stores a new row — so it
   * answers null. Decision R: the importer asks this BEFORE learn() and skips
   * without writing when it answers an id.
   */
wouldDeduplicate(statement: string, context?: LearnContext): Promise<string | null>

/**
   * The scope learn() would write `statement` into (after the sensitive-scope
   * guard and routing), and whether learn()'s dedup there also matches a row
   * of ANOTHER scope in the primary store (#176 over the corpus). False on a
   * delegating store (Postgres/PGLite: scopes are a permission boundary, see
   * learn()) and for a writable-remote scope (`_crossScopeRecurrenceApplies`).
   * Writes nothing. The importer's dry run keys its in-file duplicate map with
   * it, so two records of one file in different scopes are predicted as the
   * real run treats them (dry-run parity, owner 2026-09-27).
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

// Synchronous. An automated add-awaits pass made this `async` during the
// Phase 2 flip even though it does no async work — every call in its body
// is synchronous. Reverted: 0.16.0 is unreleased, so this method was never
// actually breaking, and leaving it async would have been a breaking
// signature change that bought nothing. Shrinking the migration surface is
// worth more than uniformity.
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
    this.reloadConfigIfChanged()  // pick up out-of-process config edits (#307)
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
    // entry rely on this scan (#1515 re-audit 3, M2).
    if (!isSharedScope(scope) && !this._hasUrlStoreForScope(scope)) return []
    const hits = detectSensitive(statement)
    if (hits.length === 0) return []
    const policy = this.getScopeMetadata(scope)?.sensitivity
    // An EMPTY forbid list means "not configured", not "forbid nothing" (#847).
    //
    // `??` supplies the default only for null/undefined, so an explicit `[]`
    // used to forbid nothing and switch this scope's scan off entirely. Nobody
    // declares a sensitivity block in order to forbid nothing — omitting the
    // block already says that, and more clearly. The realistic origin is a
    // layer that normalises a partial policy into a complete object by filling
    // absent keys with empty arrays, which is the obvious way to write one.
    //
    // The failure ran in the dangerous direction: the scope then looked MORE
    // governed than a scope with no policy at all, while being the only one
    // with no scan. Length check rather than `??`, so both shapes default.
    const forbid = new Set<SensitivityCategory>(
      policy?.forbid && policy.forbid.length > 0 ? policy.forbid : ['secrets', 'infra'],
    )
    const allow = new Set<string>(policy?.allow ?? [])
    return hits.filter(h => {
      // Fail-closed (#386): a truncated-scan signal is always offending — the
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
    // Scan statement + context fields (mirrors _guardSensitiveScope scanText at
    // index.ts:1052). Omit the context join entirely when there are no fields so
    // the clean-statement scan is byte-identical to the old behavior.
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
    // Pick up out-of-process config edits (#307) — mirrors suggestScope. Without
    // this the WRITE path routed against a stale stores/covers snapshot: a scope
    // registered (or covers synced) by another process after startup was
    // invisible to auto-routing until restart (scope-audit 2026-07-24). Cheap:
    // one statSync, reload only on an actual mtime change.
    this.reloadConfigIfChanged()
    // Match the schema default (config.ts `unscoped_default.default('global')`)
    // so the two cannot drift; reverted local→global in 0.10.0 (#353).
    const fallback = this.config.unscoped_default ?? 'global'
    if (this.config.auto_route_scope === false) {
      return { scope: fallback, routed: null, refusedShared: null }
    }
    // MED-12 (#353, COSMETIC/REPORTING per D3): exclude readonly / non-writable
    // scopes from the AUTO-ROUTE candidate set so a clean unscoped write is never
    // LABELED as routed to a scope a write can't land on. This is not a
    // write-safety fix — `_resolveRemoteStoreForScope` already `continue`s on
    // readonly (line ~495), so a write to a readonly remote already falls to
    // local; the only defect is that the ranker could RANK/LABEL a readonly scope
    // as the target. `readonly` is one boolean on StoreEntry and applies to both
    // path- and url-based stores, so this view covers both. `listScopeMetadata()`
    // and `suggestScope()` are left UNCHANGED — advisory discovery still surfaces
    // readonly scopes.
    const writableScopeMetadata = this._writableScopeMetadata()
    // Scope-routing tuning (#362): enterprise installs with many narrow,
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
    // #1115: ONE decision function, shared with `previewAutoRoute` (and through
    // it the `plur_suggest_scope` surface), so the write path and the suggestion
    // tool can no longer disagree about where an unscoped write lands.
    //
    // Eligibility is unchanged — a FORWARD domain match routes deterministically,
    // everything weaker stays gated by `matchThreshold`. What changed is that a
    // SHARED candidate is refused unless this install opted in: an unscoped write
    // whose domain prefix happened to match a team scope's covers used to land in
    // that team store and be pushed to its remote, where local cleanup could not
    // undo it. A refused shared candidate does not end the search — the next
    // eligible PERSONAL candidate still wins, so personal-scope routing is intact.
    // Decision E1 "me-only": a URL-backed personal candidate that is not the
    // user's own `/me` namespace (or whose identity is unknown) is refused
    // exactly like a shared one — same predicate as previewAutoRoute.
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
    // Every egress decision below reads the CURRENT config (core-index#9,
    // round 2): this ran `reloadConfigIfChanged` only on the unscoped path, so
    // an explicit-scope write in a long-running process was guarded — and
    // routed — against a `sensitivity` policy another process had since
    // tightened. One statSync; reloads only on an mtime change.
    this.reloadConfigIfChanged()
    // remote-only folder (owner decisions 2026-10-01): the folder's team scope
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
    // not read off a shared field — under concurrent sessions the shared field
    // let one session's `setSessionScope` decide another session's write. See
    // `session-scopes.ts`.
    const sessionScope = this._sessionScopes.get(context?.session) ?? this._gitFolderScope()
    let routed: { scope: string; confidence: number; reason: string } | null = null
    let refusedShared: { scope: string; confidence: number; reason: string } | null = null
    let scope: string
    // #1221: WHO chose this scope. The decision is made here and nowhere else,
    // so it is recorded here rather than inferred later from the absence of a
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
      // to global (#353). No behavior change for the default-global user.
      scope = context?.scope ?? sessionScope ?? (this.config.unscoped_default ?? 'global')
      // A session / `.plur.yaml` scope is a human's standing choice, not a
      // guess — deliberate, but not stated on this call, which is a distinction
      // a server reviewing writes may reasonably care about.
      scopeSource = context?.scope != null ? 'explicit' : 'session'
    }
    // A personal `user:` scope that names a configured store under a
    // different case writes to that store under ITS configured scope — the
    // same case-folded, exact-first, single-entry match the recall dial uses
    // (`_canonicalPersonalScope`, #1515 audit F5). Every configured store
    // counts, path-backed ones included, so a scope that exactly names a
    // LOCAL store is never redirected to a remote case twin (re-audit N1).
    const canonical = this._canonicalPersonalScope(scope)
    if (canonical !== scope) {
      // On the auto-routing path the router already judged `scope` with the
      // "me-only" ownership check (Decision E1). The rewrite must not carry
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
    // `user:` scope on plur.datafund.io). Purely-local scopes (`global`/`local`/
    // local-file stores) stay on this machine and are exempt — same gate as
    // _offendingHitsForScope, kept in sync because this short-circuits before it.
    // The scan gate is "a url store has this exact scope" (`_hasUrlStoreForScope`),
    // not the personal-store selection (#1515 re-audit 3, M2).
    if (!isSharedScope(scope) && !this._hasUrlStoreForScope(scope)) {
      return { scope, context, demotion: null, routed, refusedShared, scopeSource }
    }
    // Scan the FULL content the engram will carry — the statement AND the
    // context fields (rationale, key_files, source, …), not just the statement.
    // Sensitive material hides in context too (#326 review, finding 1).
    const scanText = `${statement}\n${JSON.stringify(context ?? {})}`
    // Single source of truth for the offending-hit policy (#353).
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
      // Scan the statement AND every caller-supplied content field (#381,
      // #389, #1002 review). The field set comes from ONE table,
      // `LEARN_CONTEXT_FIELD_ROLES`, checked against `LearnContext` by the
      // compiler — a hand-picked subset here is how `attribution` and
      // `license` went unscanned. Shared/remote writes are additionally
      // policy-scanned by _guardSensitiveScope below.
      const secrets = detectSecrets(this._hardScanText(statement, context))
      if (secrets.length > 0) {
        throw new Error(`Secret detected in statement or context: ${secrets[0].pattern}. Use config.allow_secrets to override.`)
      }
    }
    // D4 (2026-09 audit): `detectPromptInjection` (secrets.ts) was wired only
    // to pack installs, on the premise "a third-party pack is untrusted, my
    // own conversation is trusted." An adapter that auto-harvests engrams
    // from text an agent merely READ (a webpage it summarized, a file it was
    // asked to quote, tool output) breaks that premise: the "conversation"
    // can itself carry attacker-authored content the agent never asserted on
    // its own account.
    //
    // The signal that distinguishes the two is `claim_class: 'inferred'`
    // (#963) — "I worked this out", set by every automatic harvester
    // (opencode's self-report/user-text paths; `@plur-ai/mcp`'s
    // `plur_session_end` engram_suggestions) and never set by a human calling
    // `plur_learn` directly. Gating on it rather than on `source` (free text,
    // one string per adapter, easy to add a new harvester without updating an
    // allowlist) means a human-invoked write is untouched by construction —
    // nobody types `claim_class: 'inferred'` to describe their own assertion.
    // Refuses (does not quarantine) on a hit, mirroring the secret check just
    // above: there is no queued-for-review path for engram writes yet, and a
    // caller can still write the statement as `asserted`/omitted if it
    // genuinely came from the user.
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
    // A queued remote-only save never absorbs a write (gate review of #1663).
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
    // local store selected for the identical personal scope (#1515 re-audit 3,
    // L2) the write stays local, so the cached row must not absorb it.
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
    // remote route, #1268 A1), so the absorb rule below does not apply.
    if (!opts?.creditOnly && !this._crossScopeRecurrenceApplies(scope)) return { hit: null, foreign: null }
    const pred = this._crossScopePredicate(statement, scope)
    // #1268: for a SHARED write a shared hit is preferred, the same order as
    // `_crossScopeRecurrenceDetect`. The hit is only credited either way
    // (decision A1, `_isTeamValidation`).
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
    // #1268 decision A1 (and F1 for the importer): a cross-scope hit absorbs
    // only a non-shared save. A shared save is credited and written anyway.
    const { hit } = await this._crossScopeMatch(statement, allEngrams, scope)
    return hit && !this._isTeamValidation(scope, hit) ? hit.id : null
  },

async dedupScopeFor(statement: string, context?: LearnContext): Promise<{ scope: string; acrossScopes: boolean }> {
    const { scope } = await this._guardSensitiveScope(statement, context)
    // A shared save is never absorbed by another scope's row (#1268 decision
    // A1), so its in-file duplicates are keyed by (hash, scope) as well.
    return { scope, acrossScopes: !this._learnCanDelegate() && this._crossScopeRecurrenceApplies(scope) && !isSharedScope(scope) }
  },
}
