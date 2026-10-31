import { createHash } from 'crypto'
import { sep } from 'path'
import { tokenFromEnv } from '../config.js'
import { Plur } from '../index.js'
import type { StoreEntry } from '../schemas/config.js'
import type { Engram } from '../schemas/engram.js'
import { ATTRIBUTION_UNIDENTIFIED } from '../schemas/engram.js'
import { SENSITIVITY_CATEGORIES, type SensitivityCategory } from '../schemas/scope-metadata.js'
import { EXPANDED_FROM, safeOrigin } from '../store-expand.js'
import { normalizeEndpointUrl } from '../store/remote-store.js'
import type {
    LearnContext
} from '../types.js'


/**
 * Sanitize a remote-served `forbid` list to the known SENSITIVITY_CATEGORIES
 * (scope-audit 2026-07-24). Belt-and-braces behind the /me schema validation:
 * persistScopeMetadata may receive discoveries built by other callers (tests,
 * future code paths), and a `forbid` that sanitizes to EMPTY would be maximal
 * loosening — so empty falls to the safe default, mirroring
 * ScopeSensitivitySchema's preprocess. See the trust rule on
 * {@link Plur.persistScopeMetadata}.
 */
export function sanitizeForbidCategories(forbid: readonly string[]): SensitivityCategory[] {
  const kept = forbid.filter((c): c is SensitivityCategory =>
    (SENSITIVITY_CATEGORIES as readonly string[]).includes(c))
  return kept.length ? [...new Set(kept)] : [...SENSITIVITY_CATEGORIES]
}


/**
 * Key-order-insensitive JSON for VALUE-equality comparison (scope-audit
 * 2026-07-24). persistScopeMetadata's change-detector compares "what will be
 * persisted" against the loaded entry; a plain JSON.stringify is key-order
 * sensitive, and object spreads vs a zod re-parse can order the same keys
 * differently — which would report a phantom "change" forever (the exact
 * rewrite-every-session_start loop the detector exists to prevent). Arrays
 * keep their order (element order is meaningful for covers/forbid).
 */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_key, val) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val)
}


/**
 * LLM dedup circuit breaker (convergence Phase 2).
 *
 * Sliding window rather than a consecutive-failure counter: see
 * `_recordLlmSuccess`. The threshold of 3 is unchanged from the counter
 * version; the window is what makes it concurrency-safe. It is generous enough
 * (5 min) that three failures inside it still mean "the LLM is broken", and
 * short enough that three failures spread across an afternoon do not.
 */
/**
 * Cap on the persisted outbox local→server id map.
 *
 * One row per remote write, forever, unless bounded. Sized so a busy install
 * keeps months of mappings while the file stays well under a megabyte —
 * comfortably more history than the queued-correction case that needs it.
 */
/**
 * Total time an ambiguity guard may spend probing remotes, across ALL stores.
 *
 * The per-request bound (`fetchBounded`, 30s) stops one host hanging forever;
 * it does not stop N hosts costing N × 30s. These guards run INSIDE the primary
 * store lock, whose acquire budget is 180s — so four stalled remotes would
 * exhaust it and every waiting writer would throw "Failed to acquire lock",
 * which is the silent-lost-write failure the per-request bound was added to
 * close. A budget for the WHOLE walk is what actually bounds it.
 *
 * 45s: comfortably above one healthy round-trip per store for a handful of
 * stores, comfortably below the lock budget even when every store is stalled.
 *
 * Expiry needs no new policy — it routes into the SAME "cannot tell" branch an
 * unreachable store already takes, and the two callers already differ there by
 * design: `forget` refuses (a mis-targeted retire is irreversible), `feedback`
 * warns and proceeds (a mis-targeted rating is recoverable, and rating is a
 * hot path).
 */
export const REMOTE_GUARD_BUDGET_MS = 45_000


export const OUTBOX_ID_MAP_MAX = 5000


/**
 * How long a push claim is honoured when its owner is on ANOTHER host, whose
 * pid cannot be checked: longer than one bounded request (30s). An owner on
 * this host holds its claim while its process is alive (see
 * `_outboxClaimHeld`).
 */
export const OUTBOX_CLAIM_LEASE_MS = 60_000


/**
 * Hard cap on a live same-host owner's claim: far above one push's worst case
 * (a 30s request plus the 180s store-lock wait before the merge-back), so it
 * never cuts a real push short, but finite so a recycled pid cannot hold an
 * entry forever.
 */
export const OUTBOX_CLAIM_MAX_AGE_MS = 15 * 60_000


/**
 * How many dead takeover markers a claimer walks past before it gives up.
 * Each level is a racer that died inside a critical section a few syscalls
 * long, so reaching this means something is badly wrong; the entry waits.
 */
export const OUTBOX_TAKEOVER_MAX_DEPTH = 8


/** id → idempotency key of every row still queued in the outbox (not retired). */
export function queuedOutboxKeys(rows: Engram[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  for (const e of rows) {
    const ob = (e as any).structured_data?._outbox
    if (ob && e.status !== 'retired') out.set(e.id, typeof ob.idempotency_key === 'string' ? ob.idempotency_key : undefined)
  }
  return out
}


/** Names one exact claim (or marker) content, for its takeover marker. */
export function outboxClaimTag(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}


/** Is this process still running? (`kill 0` probes without signalling.) */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}


export const LLM_BREAKER_THRESHOLD = 3

export const LLM_BREAKER_WINDOW_MS = 5 * 60 * 1000

export const LLM_BREAKER_COOLDOWN_MS = 60 * 60 * 1000


/** Map engram type to default cognitive level (Idea 5). */
/**
 * `LearnContext.related` as a list of ids. A plain string is one id; anything
 * else that is not an array of non-empty strings contributes nothing.
 */
export function relatedIds(related: unknown): string[] {
  if (typeof related === 'string') return related ? [related] : []
  if (!Array.isArray(related)) return []
  return [...new Set(related.filter((x): x is string => typeof x === 'string' && x.length > 0))]
}


export const TYPE_TO_COGNITIVE: Record<string, string> = {
  behavioral: 'apply',
  terminological: 'remember',
  procedural: 'apply',
  architectural: 'evaluate',
}


/** Default memory_class per engram type when the caller sets none (SP2 Idea 3). */
export const TYPE_TO_MEMORY_CLASS: Record<string, 'semantic' | 'episodic' | 'procedural' | 'metacognitive'> = {
  behavioral: 'semantic',
  terminological: 'semantic',
  procedural: 'procedural',
  architectural: 'semantic',
}


export const VALID_ENGRAM_TYPES = new Set<string>(['behavioral', 'terminological', 'procedural', 'architectural'])


export const INGEST_PATTERNS = [
  { re: /(?:we decided|the decision is|agreed to)\s+(.+?)\.?$/gim, type: 'architectural' as const },
  { re: /(?:always|never|must|should)\s+(.+?)\.?$/gim, type: 'behavioral' as const },
  { re: /(?:the convention is|the rule is|the pattern is)\s+(.+?)\.?$/gim, type: 'procedural' as const },
  { re: /(?:use|prefer)\s+(\w+)\s+(?:for|over|instead of)\s+(.+?)\.?$/gim, type: 'behavioral' as const },
  { re: /(?:important|note|remember):\s*(.+?)\.?$/gim, type: 'behavioral' as const },
]


/**
 * How many extra candidates a pushdown fetches per requested result.
 *
 * The store cannot evaluate expiry or `min_strength`, so those run after the
 * SQL LIMIT. Without headroom a page of `limit` rows that are then filtered
 * returns short — and short is invisible: the caller gets fewer results and no
 * indication that any were removed.
 */
export const PUSHDOWN_OVERFETCH = 3

/**
 * How many times `recall`'s pushdown may widen its fetch before giving up.
 *
 * 3 rounds at 3x is 27x the requested limit. Derived, not picked: the
 * recoverable rejection ceiling is `1 - OVERFETCH^(-MAX_ROUNDS)` = 1 - 3⁻³ =
 * 26/27 ≈ 96.3%. Residual filters (expiry, min_strength) may reject up to
 * that fraction of every page and a full `limit` still comes back; past it
 * the shortfall is bounded and deterministic — recall returns what the last
 * 27x page yielded rather than escalating into an unbounded scan.
 *
 * Cost note, measured against the one shipping `role: 'primary'` adapter:
 * `PostgresAdapter.searchBM25` deliberately computes the FULL candidate set
 * regardless of the fetch limit (its trigram prefilter cannot rank, so SQL
 * LIMIT before scoring would drop true positives). For that adapter a widening
 * round therefore re-runs an identical query to take a longer slice of an
 * answer it already computed — a 2–3x amplification exactly in the
 * high-rejection case, correctness-preserving but wasteful. The loop cannot
 * see this: `narrowed.length == fetch` is indistinguishable from "more rows
 * exist". An adapter-side exhaustion signal (return fewer than `fetch` when
 * the candidate set is complete) is the fix, tracked in #753.
 */
export const PUSHDOWN_MAX_ROUNDS = 3


/**
 * Rows per `listEngramsMissingEmbeddings` batch in the primary-store
 * auto-embed pass (#762). Bounds how much of the corpus is ever held in
 * memory by the pass — the pass itself runs to convergence, one batch at a
 * time, in the background. Each batch is a fresh anti-join, so concurrent
 * writers and a mid-pass crash both converge on the next pass.
 */
export const PRIMARY_AUTO_EMBED_BATCH = 100


/**
 * True when a background-pass error means "the store was torn down under
 * us", not "something is wrong" (#762 follow-up, caught by smoke-packaged).
 *
 * The auto-embed pass is fire-and-track, so a short-lived process — the
 * packaged smoke, a CLI invocation, any script that closes or drops its
 * store when its work is done — can legitimately tear the store down while
 * a pass is mid-flight. That is a benign cancellation: there is nothing to
 * fix, nothing to retry, and the next engine over a live store converges.
 * Reporting it as a background FAILURE (warning + `lastIndexError`) is
 * noise at best; at worst the stray warning lands after the process's real
 * output, which is exactly how the release smoke's last-line gate caught it.
 *
 * Patterns, each tied to a specific teardown path:
 *   - Postgres `42P01` (undefined_table) / `3F000` (invalid_schema_name):
 *     `dropSchema()` won the race against the pass's next query.
 *   - "adapter is closed": `close()` beat the pass's next `getPool()`.
 *   - "after calling end": node-postgres's "Cannot use a pool after calling
 *     end on the pool" — same race, seen from a checkout already in flight.
 */
export function isStoreTeardownError(err: unknown): boolean {
  const code = (err as { code?: string }).code
  if (code === '42P01' || code === '3F000') return true
  const msg = (err as Error)?.message ?? ''
  return msg.includes('adapter is closed') || msg.includes('after calling end')
}


/**
 * The origin block, written only when the caller chose a licence (#970).
 *
 * The block is left off otherwise. A default licence written into every engram
 * would be indistinguishable from one somebody picked, and the whole point of
 * marking defaults is that the difference is visible.
 */
/** How far back a derivation chain is followed before it is truncated. */
export const MAX_CHAIN_DEPTH = 32


/**
 * The ancestors of a new engram, nearest first (#958, spec §4.1).
 *
 * `chain` was the last of the four origin fields that nothing ever wrote — not
 * read anywhere, not written anywhere, for the whole life of the schema.
 *
 * It is a SHORTCUT, not the truth. Section 2.1 of the profile is explicit that
 * where the shortcut and the history log disagree, the log wins. It exists so a
 * reader can see the lineage without walking a log they may not have — which is
 * exactly the case for a portable record.
 *
 * `supersedes` comes before `derived_from` because a replacement is the nearer
 * relationship: engram C that replaces B, which was derived from A, has B as its
 * immediate ancestor.
 *
 * The walk is bounded and cycle-guarded. Neither should happen — supersession is
 * acyclic by construction — but a chain built from store data that a user can
 * edit by hand has no business hanging on a loop somebody typed.
 */
export function buildChain(
  context: LearnContext | undefined,
  ancestorsOf: (id: string) => string[],
): string[] {
  const immediate = [...(context?.supersedes ?? []), ...(context?.derived_from ? [context.derived_from] : [])]
  const chain: string[] = []
  const seen = new Set<string>()
  const queue = [...immediate]
  while (queue.length && chain.length < MAX_CHAIN_DEPTH) {
    const id = queue.shift() as string
    if (!id || seen.has(id)) continue
    seen.add(id)
    chain.push(id)
    for (const parent of ancestorsOf(id)) {
      if (!seen.has(parent)) queue.push(parent)
    }
  }
  return chain
}


/**
 * The origin block, written when there is something to record in it.
 *
 * Was gated on a licence alone, which meant the other three fields could only
 * be written by somebody who happened to be licensing their memory — so `chain`
 * stayed empty even where the lineage was known. It is now written whenever any
 * of origin, chain or licence has content.
 *
 * A licence is still only recorded when somebody chose one. A default written
 * here would be indistinguishable from a decision, which is the whole point of
 * marking defaults.
 */
export function buildProvenanceBlock(
  context: LearnContext | undefined,
  ancestorsOf: (id: string) => string[] = () => [],
): NonNullable<Engram['provenance']> | undefined {
  const chain = buildChain(context, ancestorsOf)
  const origin = context?.source
    ?? (context?.session_episode_id ? `session:${context.session_episode_id}` : undefined)
  if (!context?.license && !origin && chain.length === 0) return undefined
  return {
    // `direct` only when there is other content worth a block. As the sole
    // occupant it said nothing at all.
    origin: origin ?? 'direct',
    chain,
    signature: null,
    ...(context?.license ? { license: context.license } : {}),
  } as NonNullable<Engram['provenance']>
}


/**
 * Assemble the attribution block for a new engram (#961).
 *
 * Returns undefined when the caller supplied nothing, so the field is absent
 * rather than present-and-empty. We never invent a runtime, and we never read
 * the operating system account for an identity.
 */
export function buildAttribution(
  context?: LearnContext,
  /** `provenance.identity` from config, when the user has set one. */
  configuredIdentity?: string,
): NonNullable<Engram['attribution']> | undefined {
  const a = context?.attribution
  const out: NonNullable<Engram['attribution']> = {}

  // WHO. Three states, and the third is the point.
  //
  //   the caller said so         -> use it (a per-engram override)
  //   the user configured one    -> use that
  //   neither                    -> the `unidentified` marker, written OUT
  //
  // Writing the marker rather than omitting the field is what makes the record
  // honest. An absent field cannot be told apart from a record written before
  // identity was captured at all; the marker says we looked and found nobody.
  //
  // Never the operating system account. That writes a real person's name into
  // shared records because they installed software, not because they chose to
  // be named.
  out.asserted_by = a?.asserted_by ?? configuredIdentity ?? ATTRIBUTION_UNIDENTIFIED

  // WHAT WROTE IT. Always recorded, because it is the one fact we always have:
  // software knows its own name.
  //
  // No version here, deliberately. Core has no version constant, and adding one
  // would create a seventeenth place `release.sh` has to bump — a standing cost
  // for a value that is almost never the one a reader wants. Every real write
  // arrives through a wrapper that DOES track its version (plur-mcp, plur-cli),
  // and those pass name and version both; this is the honest floor beneath them.
  out.runtime = a?.runtime ?? { name: 'plur-core' }

  if (a?.model) out.model = a.model
  if (a?.tool) out.tool = a.tool
  if (a?.on_behalf_of) out.on_behalf_of = a.on_behalf_of
  return out
}


/** Most remote ids `getByIds` fetches from one store in one call (#1318 review). */
export const GET_BY_IDS_REMOTE_CAP = 20


/**
 * Reciprocal-rank-fusion score of `id` across ranked lists — the same formula
 * (`Σ 1/(k + rank + 1)`, k = 60) `hybrid-search.ts` `rrfMerge` sums. Used by
 * the PGLite recall path to report its top score (decision I4).
 */
export function rrfScoreOf(id: string, lists: ReadonlyArray<ReadonlyArray<{ id: string }>>, k = 60): number {
  let score = 0
  for (const list of lists) {
    const rank = list.findIndex(e => e.id === id)
    if (rank >= 0) score += 1 / (k + rank + 1)
  }
  return score
}


/** Budget for ONE live collision probe (0.21.1). Was the 30 s request deadline. */
export const REMOTE_PROBE_TIMEOUT_MS = 5_000


/**
 * Deadline for a routed save's server request when the caller sets none
 * (#1532 review F3): MCP plur_learn, learnBatch, the Claw and opencode
 * plugins. Past it the engram is saved here and queued in the outbox, so a
 * hanging server costs 10 s instead of the driver's 30 s. A request that lands
 * after the deadline is collapsed on retry by its idempotency key, which the
 * team server honours; a server that ignores the key could store it twice,
 * exactly as with the 30 s deadline before.
 */
export const DEFAULT_REMOTE_WRITE_TIMEOUT_MS = 10_000


/** Refusal from {@link Plur.addRemoteStore} (#1265). `code` is stable for
 *  callers; `message` never contains the token. */
/** True for an in-memory entry expanded from a multi-scope server entry (#1631). */
export function isFromServerEntry(entry: StoreEntry): boolean {
  return typeof serverEntryIdOf(entry) === 'string'
}


/** The identity of the server entry an in-memory entry was expanded from (#1631). */
export function serverEntryIdOf(entry: StoreEntry): string | undefined {
  const id = (entry as unknown as Record<string, unknown>)[EXPANDED_FROM]
  return typeof id === 'string' ? id : undefined
}


export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}


/** The string members of a raw YAML list value ([] for anything else). */
export function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}


/** A raw config entry that {@link Plur.refreshServerScopes} may update (C6):
 *  an http(s) `url`, a `scopes` list and an `enterprise` block. */
export function isEnterpriseServerEntry(raw: unknown): raw is Record<string, unknown> & { url: string } {
  return isPlainObject(raw) && typeof raw.url === 'string' && Array.isArray(raw.scopes) && isPlainObject(raw.enterprise)
}


/** scope → url for every remote entry whose normalized url is not `exceptUrl`:
 *  the scopes another server already serves (#1631). */
export function scopesServedElsewhere(rawStores: unknown[], exceptUrl: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of rawStores) {
    if (!isPlainObject(r) || typeof r.url !== 'string' || normalizeEndpointUrl(r.url) === exceptUrl) continue
    const scopes = [...stringList(r.scopes), ...stringList(r.pinned_scopes), ...(typeof r.scope === 'string' ? [r.scope] : [])]
    for (const sc of scopes) if (!out.has(sc)) out.set(sc, r.url)
  }
  return out
}


/** The key a server entry's /me request is sent with, and its revision (#1631,
 *  Codex round 2 finding 1): the source (`token`, or `token_env:<NAME>`) plus a
 *  sha256 fingerprint of the resolved key — never the key. An answer may land
 *  only on an entry whose revision is still the one it was requested with. */
export function serverCredential(r: Record<string, unknown>): { token: string | undefined; tokenEnv: string | undefined; revision: string } {
  const tokenEnv = typeof r.token_env === 'string' ? r.token_env : undefined
  const inline = typeof r.token === 'string' && r.token ? r.token : undefined
  const token = inline ?? tokenFromEnv(tokenEnv)
  const source = inline ? 'token' : tokenEnv ? `token_env:${tokenEnv}` : 'none'
  const revision = `${source}:${token ? createHash('sha256').update(token).digest('hex') : '-'}`
  return { token, tokenEnv, revision }
}


/** The known fields of a server entry's `discovery` snapshot that an accepted
 *  answer replaces; every other key is kept as it is on disk (#1631, Codex
 *  round 2 finding 5). */
export const DISCOVERY_SNAPSHOT_KEYS = [
  'discovered_at', 'scopes_status', 'gitlab_host', 'project_paths', 'username',
  'org_id', 'key_expires_at', 'status', 'checked_at',
] as const


/** How often an unchanged discovery answer refreshes its timestamp (#1631).
 *  Well inside the 7-day stale-cache limit, so an unchanged answer keeps the
 *  cache fresh while writing config.yaml at most once a day. */
export const DISCOVERY_TIMESTAMP_REFRESH_MS = 24 * 60 * 60 * 1000


/** Whether `next` must be written over `entry`: anything but the discovery
 *  timestamps changed, or the timestamp that answer would refresh (`stamp`) is
 *  older than {@link DISCOVERY_TIMESTAMP_REFRESH_MS}, in the future or
 *  unparsable. An unchanged answer otherwise never rewrites config.yaml. */
export function discoveryChanged(entry: Record<string, unknown>, next: Record<string, unknown>, stamp: 'discovered_at' | 'checked_at', now: number): boolean {
  const strip = (e: Record<string, unknown>): Record<string, unknown> => {
    if (!isPlainObject(e.discovery)) return e
    const { discovered_at: _d, checked_at: _c, ...rest } = e.discovery
    return { ...e, discovery: rest }
  }
  if (stableJson(strip(next)) !== stableJson(strip(entry))) return true
  const prev = isPlainObject(entry.discovery) ? entry.discovery[stamp] : undefined
  const at = typeof prev === 'string' ? Date.parse(prev) : NaN
  return !Number.isFinite(at) || at > now || now - at >= DISCOVERY_TIMESTAMP_REFRESH_MS
}


/** Why one scope of a server entry cannot be replaced or removed on its own. */
export function serverEntryScopeRefusal(scope: string, url: string): string {
  return `scope "${scope}" belongs to the server entry for ${safeOrigin(url)}, which lists all its scopes in one entry ` +
    `and shares one key between them. A single scope of it cannot be replaced or removed. Nothing was changed. ` +
    `To change that server's scope list, re-run the enterprise setup.`
}


export class AddRemoteStoreError extends Error {
  constructor(
    readonly code: 'invalid_url' | 'missing_token' | 'missing_scope' | 'auth_rejected' | 'unreachable' | 'scope_not_authorised' | 'scope_conflict',
    message: string,
    readonly authorised: string[] = [],
  ) {
    super(message)
    this.name = 'AddRemoteStoreError'
  }
}


/** True when `child` is strictly inside `parent` (both already canonical). */
export function isUnder(child: string, parent: string): boolean {
  if (child === parent) return false
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}
