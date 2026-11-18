import type { RemoteOnlyStatus } from './remote-only.js'
import type { Engram, MeasuredUnder } from './schemas/engram.js'
import type { InjectionSource } from './history.js'
import type { RecallRemoteReport } from './remote-recall.js'
export type { Engram, KnowledgeAnchor, Association, MeasuredUnder } from './schemas/engram.js'
export type { Episode } from './schemas/episode.js'
export type { PlurConfig } from './schemas/config.js'
export type { PackManifest } from './schemas/pack.js'

export interface UploadLocalResult {
  id: string
  outcome: 'sent' | 'queued' | 'already_on_server' | 'held_for_review' | 'demoted_secret' | 'failed'
  new_id?: string
  error?: string
  /** Planned outcome only: no mutation or network request was made. */
  dry_run?: true
}

export interface LearnContext {
  type?: 'behavioral' | 'terminological' | 'procedural' | 'architectural'
  scope?: string
  domain?: string
  source?: string
  tags?: string[]
  rationale?: string
  visibility?: 'private' | 'public' | 'template'
  knowledge_anchors?: Array<{ path: string; relevance?: string; snippet?: string }>
  dual_coding?: { example?: string; analogy?: string }
  abstract?: string | null
  derived_from?: string | null
  /** Commitment level. Defaults to 'leaning' for new engrams. */
  commitment?: 'exploring' | 'leaning' | 'decided' | 'locked' | 'draft'
  /** Reason for locking (required when commitment='locked'). */
  locked_reason?: string
  /** Explicit memory_class override. Auto-set from type if not provided. */
  memory_class?: 'semantic' | 'episodic' | 'procedural' | 'metacognitive'
  /** Current session episode ID for episodic anchoring. */
  session_episode_id?: string
  /**
   * Who is answerable for this engram. Every field optional. A caller
   * that does not know a value omits it rather than guessing — a record with no
   * agent is valid, a record with a guessed agent is worse than one with none.
   */
  attribution?: {
    asserted_by?: string
    runtime?: { name: string; version?: string }
    model?: { name: string; prompt_id?: string; prompt_version?: string; prompt_sha256?: string }
    tool?: { name: string; version?: string }
    on_behalf_of?: string
  }
  /**
   * What kind of claim this is: observed, documented, structural,
   * asserted, inferred or revised. Omitted when it cannot be determined.
   */
  claim_class?: 'observed' | 'documented' | 'structural' | 'asserted' | 'inferred' | 'revised'
  /**
   * Which licence governs reuse of this engram's content.
   *
   * Omit it and the schema default applies. That default is not a decision
   * anybody made, and a provenance record says so rather than presenting it
   * beside recorded facts, so a caller who cares about reuse terms has to
   * say which ones.
   */
  license?: string
  /**
   * The session that produced this write, recorded in `sources[].session_id`.
   * Provenance only: it never selects a scope. `session` below picks
   * the per-session default scope and may hold an internal registry key or
   * `NO_SESSION`, neither of which is a session anybody could look up, so the
   * two stay separate fields.
   */
  session_id?: string
  /** Always-load flag — bypass keyword-relevance gate during injection. */
  pinned?: boolean
  /**
   * Tier within the pinned budget (pinned two-tier model). "hard": a sub-cap
   * inside the pinned quota (`injection.pinned_hard_ratio` of it, default 0.5);
   * the write is rejected if it would grow the hard tier past that cap.
   * "soft": gets what the hard tier leaves. Default: "soft".
   */
  pin_tier?: 'hard' | 'soft'
  /**
   * Soft-tier priority, an integer 1–100 (default 50); anything else is
   * rejected. Higher is selected first within an origin. Ignored for
   * pin_tier="hard".
   */
  pinned_priority?: number
  /**
   * Start of the knowledge's validity window (ISO YYYY-MM-DD). Stored in
   * `temporal.valid_from`; inject/recall skip the engram before this date.
   */
  valid_from?: string
  /**
   * Expiry of the knowledge (ISO YYYY-MM-DD). Stored in
   * `temporal.valid_until`; inject/recall skip the engram after this date.
   * When omitted, an explicit expiry phrase in the statement ("valid until
   * 31 May 2026", "expires 2026-12-01") is auto-extracted — the parsed date
   * is echoed back via `structured_data._expiry_extracted`, never guessed.
   */
  valid_until?: string
  /**
   * IDs of engrams this one intentionally replaces. Writes
   * `relations.supersedes` on the new engram and the reverse
   * `relations.superseded_by` edge on each target found in the local
   * primary store (best-effort -- remote-store targets are not patched).
   * Supersedes-linked pairs are skipped by the tension scanner: an
   * intentional update is not a contradiction.
   */
  supersedes?: string[]
  /**
   * Internal (used by the duplicate checker's supersede): drop any
   * `supersedes` target that is locked at write time, checked under the
   * store lock. A locked memory is never superseded automatically; the
   * caller reads `relations.supersedes` on the returned engram to see
   * whether the supersede applied, and sends the pair to review if not.
   */
  supersedes_unless_locked?: boolean
  /**
   * IDs of engrams this one is related to. Written to `relations.related` on
   * the new engram only; the targets are not modified. Batch learning uses it
   * to link an item to the memory the duplicate checker said it resembles,
   * because batch learning never overwrites an existing memory.
   */
  related?: string[]
  /**
   * Measurement context for numeric or benchmark-derived claims.
   * Records model, source_type, hardware, dataset, and/or date under which
   * the asserted value was measured. When omitted, the field is absent from
   * the stored engram (not null). See MeasuredUnderSchema for field details.
   */
  measured_under?: MeasuredUnder
  /**
   * Session key this write belongs to.
   *
   * Resolves the session default scope from the per-session registry instead of
   * the process-wide slot. Supply it whenever one `Plur` instance serves more
   * than one session concurrently — without it, `setSessionScope()` is a single
   * shared field and one session's scope silently becomes another's (see
   * `session-scopes.ts`). Never persisted on the engram; it selects a scope, it
   * is not part of one. The session recorded in provenance is `session_id`.
   */
  session?: string
}

/** Extended context for async learn with LLM dedup. */
export interface LearnAsyncContext extends LearnContext {
  llm?: LlmFunction
  budget?: RecallBudget
  caller_session_id?: string
}

export type DedupDecision = 'ADD' | 'UPDATE' | 'MERGE' | 'NOOP'

export interface DedupConfig {
  enabled?: boolean
  threshold?: number
  mode?: 'llm' | 'cosine' | 'off'
}

export interface LearnAsyncResult {
  engram: Engram
  decision: DedupDecision
  existing_id?: string
  tensions?: string[]
  /**
   * Set when an UPDATE onto a locked memory saved the new statement as a draft
   * but its review item could not be opened. The draft is never
   * injected, and without the review nobody is asked about it, so this is
   * reported rather than only logged.
   */
  review_error?: string
  /**
   * Present when the duplicate checker answered MERGE. Learning never
   * overwrites (single and batch saves alike): the item was saved as its own
   * memory (decision 'ADD') and linked to the existing one through
   * `relations.related`. `checker_decision` is what the checker suggested;
   * nothing was changed on the existing memory. (An UPDATE answer supersedes
   * instead and is reported as decision 'UPDATE'.)
   */
  likely_duplicate_of?: {
    id: string
    checker_decision: 'UPDATE' | 'MERGE'
    note: string
  }
  /**
   * What the dedup pass was actually able to do, and what it saw, so a write
   * that was only hash-checked is not reported like one that was semantically
   * checked.
   *
   *  - 'llm'       — an LLM judged it
   *  - 'cosine'    — local embeddings judged it, no API call
   *  - 'hash-only' — neither was available; only exact content-hash ran, so an
   *                  ADD here means "not identical", NOT "not a duplicate"
   */
  dedup?: {
    mode: 'llm' | 'cosine' | 'hash-only'
    /**
     * Closest candidates and their scores — present whenever similarity ran.
     *
     * `statement` carries a preview of the neighbour's own text, so reading
     * the neighbour before writing costs no extra round-trip. Cosine never
     * gates a write.
     */
    near_duplicates?: Array<{ id: string; score: number; statement?: string }>
  }
  /**
   * Position of this result's statement in the original learnBatch input
   * array. `results` is compacted (failed statements are absent), so callers
   * must NOT assume `results[i]` corresponds to `inputs[i]` — read `input_index`
   * to map a result back to its input. Undefined for a single (non-batch)
   * learnAsync call, where there is no input array to index into.
   */
  input_index?: number
}

/**
 * A single statement that threw while being processed by learnBatch. Carrying
 * the original array index lets callers correlate the failure back to their
 * input; `results` only holds the statements that succeeded.
 */
export interface LearnBatchFailure {
  index: number
  statement: string
  error: string
}

export interface LearnBatchResult {
  /** Successful outcomes, in input order (excludes failed statements). */
  results: LearnAsyncResult[]
  stats: { added: number; updated: number; merged: number; noops: number; failed: number }
  /** Per-statement failures — a bad item does not abort the whole batch. */
  failures: LearnBatchFailure[]
}

/**
 * Function that calls an LLM. Model-agnostic — consumer provides this.
 * Takes a prompt, returns the LLM's text response.
 */
export type LlmFunction = (prompt: string) => Promise<string>

/** Budget constraints for bounded sub-agent expansion. */
export interface RecallBudget {
  max_tokens?: number
  max_results?: number
  ttl_seconds?: number
}

/**
 * Project-level remote endpoint from `.plur.yaml`. Its presence IS the
 * org context for dialing on the hook path: the project explicitly names this
 * host as part of the current work, so it is dialed even when the org-affinity
 * heuristic alone would not implicate it. Project config wins over
 * `config.stores` for the hook path (matching-URL group dials with the
 * project's token when one is supplied).
 */
export interface RemoteProjectConfig {
  url: string
  token?: string
  scopes?: string[]
}

export interface RecallOptions {
  scope?: string
  /** Workspace dialing context only; never an authorization or result filter. */
  context_scopes?: string[]
  /**
   * Permitted-scope allow-list — an AUTHORIZATION filter, distinct from the
   * `scope` visibility filter (contract: `ScopeRestriction` in storage-adapter.ts).
   * Absent = unrestricted; `[]` = matches NOTHING (never widened); non-empty =
   * EXACT membership, no hierarchy expansion or personal-family pass-through.
   * Pushed into the query so `limit` counts permitted results.
   */
  scopes?: string[]
  domain?: string
  limit?: number
  min_strength?: number
  /** Search mode: 'fast' (BM25, default) or 'agentic' (LLM-assisted semantic search) */
  mode?: 'fast' | 'agentic'
  /** LLM function for agentic mode. Required when mode='agentic'. */
  llm?: LlmFunction
  budget?: RecallBudget
  caller_session_id?: string
  /**
   * Force a query intent for routing instead of letting the classifier
   * decide. 'general' is the neutral baseline (no re-ranking perturbation).
   */
  intentOverride?: 'entity' | 'temporal' | 'event' | 'general'
  /**
   * Cross-encoder rerank stage, applies to hybrid/semantic recall:
   *   - `true`  → opt in for this call (loads the configured reranker, or
   *     bge-reranker-v2-m3 if PLUR_RERANKER is unset/off).
   *   - `false` → skip the rerank stage even if PLUR_RERANKER is set.
   *   - omitted → respect PLUR_RERANKER (default off → zero cost).
   *
   * Two reranker tiers exist: `ms-marco-minilm-l6` (tiny, ~ms-scale
   * on CPU — hot-path candidate) and `bge-reranker-v2-m3` (quality,
   * seconds-scale on CPU — offline/batch). Select via PLUR_RERANKER.
   */
  rerank?: boolean
  /**
   * Server-authoritative remote recall leg. Default true: dials every remote
   * host implicated by the current work (see remote-recall.ts) in parallel and
   * RRF-merges. INTERNAL CALLERS MUST PASS false (learn-dedup, forget-by-search,
   * self-eval): otherwise every learn fires prompt-derived POSTs to all hosts
   * and a remote row can silently suppress a local write as a "dedup match".
   */
  remote?: boolean
  /** Per-call remote budget in ms (env PLUR_REMOTE_RECALL_TIMEOUT_MS wins).
   *  Hook path passes 1500; MCP recall defaults to 2000; session_start warm
   *  and the first remote recall of a `plur recall` process pass 5000. */
  remote_timeout_ms?: number
  /** End-to-end deadline for this recall in ms. The call returns
   *  within it with whatever is ready and reports what is missing. Default
   *  10 s; env PLUR_RECALL_DEADLINE_MS wins. */
  deadline_ms?: number
  /** The same deadline as an absolute time (epoch ms), for a caller that
   *  started its clock before calling — e.g. the MCP handler, whose own
   *  awaits (workspace resolution) count against the reply.
   *  Wins over `deadline_ms`. */
  deadline_at?: number
  /** `.plur.yaml` remote endpoint — establishes the org context for dialing
   *  on the hook path. See {@link RemoteProjectConfig}. */
  remote_project?: RemoteProjectConfig
  /**
   * Session key this recall belongs to. Used ONLY to resolve the
   * session default scope as the dialing context for the remote leg when no
   * explicit `scope` is passed: a session whose default scope names org X
   * dials org-X hosts (see `_remoteRecallHosts`). An explicit `scope` always
   * wins. Same registry key as {@link LearnContext.session} — thread the same
   * value through both when one `Plur` serves concurrent sessions.
   */
  session?: string
}

/**
 * Why a hybrid recall or injection answered without (part of) its semantic
 * leg: the model is not on disk (run `plur doctor`), the
 * semantic leg missed the recall deadline, or only the reranker did.
 */
export type DegradedReason = 'embedding_model_missing' | 'semantic_deadline' | 'reranker_deadline'

export interface InjectOptions {
  budget?: number
  scope?: string
  /**
   * Permitted-scope allow-list — the AUTHORIZATION filter, same contract as
   * {@link RecallOptions.scopes}: absent = unrestricted, `[]` = matches
   * NOTHING, non-empty = exact membership with no hierarchy expansion.
   *
   * `scope` above is a VISIBILITY filter that deliberately passes the entire
   * personal family through (`local`, `global`, `user:*`, `agent:*`); a
   * multi-tenant caller needs this filter so one principal's personal engrams
   * do not land in another principal's context.
   */
  scopes?: string[]
  boost_recent?: boolean
  /** Force a query intent for routing; omitted → classifier decides. */
  intentOverride?: 'entity' | 'temporal' | 'event' | 'general'
  /** Cross-encoder rerank stage: true=opt in, false=skip, omitted=respect PLUR_RERANKER. */
  rerank?: boolean
  /** Session ID (from plur_session_start) recorded on the co_injection provenance event. */
  session_id?: string
  /**
   * The session whose default scope sets the remote dialing context, when it
   * is not `session_id`. The MCP server passes the workspace's own
   * registry key here for a read with no session default of its own, so the
   * folder's team store is dialed while `session_id` — what is recorded on
   * the co_injection event — stays the caller's real session (or none).
   * Omitted: `session_id` sets the dialing context.
   */
  dial_session?: string
  /** Which surface asked for this injection. Recorded on the co_injection event. */
  source?: InjectionSource
  /**
   * Server-authoritative remote recall leg for `injectHybrid`.
   * Default true. Same contract as {@link RecallOptions.remote}; BM25-only
   * `inject()` NEVER dials regardless of this flag.
   */
  remote?: boolean
  /** Per-call remote budget in ms — see {@link RecallOptions.remote_timeout_ms}. */
  remote_timeout_ms?: number
  /** End-to-end deadline for `injectHybrid` — see {@link RecallOptions.deadline_ms}. */
  deadline_ms?: number
  /** Absolute form — see {@link RecallOptions.deadline_at}. */
  deadline_at?: number
  /** `.plur.yaml` remote endpoint (hook path org context) — see
   *  {@link RemoteProjectConfig}. */
  remote_project?: RemoteProjectConfig
}

export interface InjectionResult {
  directives: string
  constraints: string
  consider: string
  count: number
  tokens_used: number
  injected_ids: string[]
  /**
   * Per-pack engram counts for this injection. Key is pack name or '__personal__'
   * for engrams from the user's personal store. Used for session activation-rate
   * telemetry at plur_session_end. Only present when at least one engram was injected.
   */
  injected_packs?: Record<string, number>
  /**
   * Persisted-tension warnings: present when an injected engram
   * participates in an unresolved tension (confirmed → either side injected;
   * detected → both sides injected together). Surface, don't adjudicate.
   */
  warnings?: string[]
  /**
   * Set by `injectHybrid`: which retrieval
   * legs contributed, as in `HybridSearchResult.mode`. `hybrid-degraded` = the
   * embedder was meant to run and failed, so the injection used keyword
   * matching only (`embedder_error` says why); `bm25-only` = embeddings are
   * turned off by choice, not a fault.
   */
  mode?: 'hybrid' | 'hybrid-degraded' | 'bm25-only'
  embedder_error?: string
  /** Set by `injectHybrid` when it ran without its semantic leg: why. */
  degraded_reason?: DegradedReason
  /** Set by `injectHybrid`: what the remote (server) leg
   *  did on THIS call, as on recall. */
  remote?: RecallRemoteReport
  /** Set by `injectHybrid`: false when a leg that should have contributed did
   *  not — a dialed host was not ok, or the semantic leg was cut by the
   *  deadline. */
  results_complete?: boolean
  /**
   * Present only when the instance is bound to a remote-only folder: whether the folder's team server served this
   * injection. `served: false` means no memory this time — the personal store
   * is never used instead — and an adapter says so once per session.
   */
  remote_only?: RemoteOnlyStatus
  /**
   * Pinned engrams that did NOT make this injection, with what each would have
   * cost and which cap it lost to.
   *
   * `pinned: true` means priority subject to capacity, not guaranteed
   * inclusion, so a caller must be able to see what it did not get.
   *
   * Absent when nothing was omitted.
   */
  omitted_pinned?: Array<{ id: string; cost: number; reason: 'pinned-sub-budget' | 'total-budget' | 'hard-tier-cap' | 'soft-tier-budget' }>
}

export interface CaptureContext {
  agent?: string
  channel?: string
  session_id?: string
  tags?: string[]
}

export interface TimelineQuery {
  since?: Date
  until?: Date
  agent?: string
  channel?: string
  search?: string
}
