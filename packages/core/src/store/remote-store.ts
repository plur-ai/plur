import { z } from 'zod'
import type { Engram } from '../schemas/engram.js'
import type { EngramStore } from './types.js'
import { logger } from '../logger.js'
import { normalizeEngramInput } from '../normalize-engram.js'
import { ScopeMetadataSchema, type ScopeMetadata } from '../schemas/scope-metadata.js'

/**
 * Lenient validation for semi-trusted remote rows (security audit 2026-06-10,
 * finding #3). The server may legitimately omit optional engram fields, so we
 * don't demand the full Engram shape — but we DO type-check the security-relevant
 * fields and reject structurally-broken rows. Without this, a compromised or
 * malicious remote could spread arbitrary / type-confused data (and instruction-
 * carrying `statement`s) into the local injection pool via `as unknown as Engram`.
 * `.passthrough()` keeps unmodeled fields; the point is to gate the meaningful ones.
 *
 * Exported (#776): the server-authoritative recall leg (remote-recall.ts)
 * validates /api/v1/recall rows through the SAME schema — one trust boundary,
 * not two that can drift.
 */
export const RemoteRowSchema = z.object({
  id: z.string().regex(/^(ENG|ABS|META)-[A-Za-z0-9-]+$/),
  scope: z.string().min(1),
  status: z.enum(['active', 'dormant', 'retired', 'candidate']),
  statement: z.string().min(1),
  type: z.enum(['behavioral', 'terminological', 'procedural', 'architectural']).optional(),
  pinned: z.boolean().optional(),
  commitment: z.enum(['exploring', 'leaning', 'decided', 'locked']).optional(),
  visibility: z.enum(['private', 'public', 'template']).optional(),
  // Fields rendered into agent context or used in arithmetic — type confusion
  // here either throws at injection time (confidence_score.toFixed in
  // formatLayer3) or feeds non-string data into the context. nullish() because
  // servers may emit explicit nulls for absent values.
  confidence_score: z.number().nullish(),
  rationale: z.string().nullish(),
  summary: z.string().nullish(),
  domain: z.string().nullish(),
}).passthrough()

// #912: Truncate and strip control chars from server error bodies before
// persisting them (append → _outbox.last_error) or surfacing in thrown errors.
// Mirrors the treatment applied to server-assigned ids in append().
function sanitiseResponseBody(raw: string): string {
  return raw.slice(0, 200).replace(/[^\x20-\x7E]/g, '?')
}

/**
 * Remote engram store — speaks to a PLUR Enterprise server over its
 * public REST API (/api/v1).
 *
 * Implements the same EngramStore interface as YamlStore + SqliteStore
 * so the multi-store recall path doesn't need to know the difference.
 *
 * Caching: load() is called by `Plur._loadCached()` on every recall,
 * so we hold a per-instance TTL cache (default 60s) over the result.
 * That keeps recall fast in tight loops without going stale for long.
 *
 * Failure mode: any network error returns an empty array from load()
 * — the upstream merge sees "no engrams from this store right now"
 * rather than blowing up. Callers learn about the problem via logs.
 */
// Timeout for each page fetch inside load(). Background loads are not on
// the hot path — a degraded network that never delivers headers must still
// eventually unblock the caller (#504). 30 s is generous for a healthy
// server while still keeping the process mortal on a blackholed route.
const LOAD_FETCH_TIMEOUT_MS = 30_000

/**
 * Canonical endpoint identity for a configured remote URL (scope-audit
 * 2026-07-24). Users configure the SSE URL (mcp.json shape), so
 * `https://x.com`, `https://x.com/`, and `https://x.com/sse` all name the SAME
 * server — RemoteStore.apiBase has always folded them at HTTP time. Every
 * IDENTITY comparison (endpoint dedup, addStore same-URL dedup, /me metadata ↔
 * store-entry matching, registered-vs-offerable splits) must apply the same
 * fold, or the three spellings count as three distinct endpoints and a scope
 * registered under one spelling is re-offered under another.
 *
 * Comparison-time only: callers must NEVER rewrite a stored config value with
 * the normalized form — the user's spelling is preserved on disk.
 */
export function normalizeEndpointUrl(url: string): string {
  return url.replace(/\/sse\/?$/, '').replace(/\/$/, '')
}

export class RemoteStore implements EngramStore {
  private cache: { ts: number; engrams: Engram[] } | null = null
  private inFlight: Promise<Engram[]> | null = null

  constructor(
    private readonly url: string,    // e.g. https://plur.datafund.io/sse — but we hit /api/v1
    private readonly token: string,
    private readonly scope: string,  // narrow listing on the server side
    private readonly opts: { ttlMs?: number } = {},
  ) {}

  private get apiBase(): string {
    // The user configures the SSE URL (consistent with mcp.json shape);
    // /api/v1 is rooted at the same host. Strip /sse if present, then
    // append /api/v1. Shares normalizeEndpointUrl so HTTP-time and
    // identity-time normalization can never drift (scope-audit 2026-07-24).
    return normalizeEndpointUrl(this.url) + '/api/v1'
  }

  private get ttlMs(): number { return this.opts.ttlMs ?? 60_000 }

  /**
   * Reshape a DB row {id, scope, status, data} into an Engram and validate it.
   * Authoritative columns (id/scope/status) win over anything in `data`. Returns
   * null (and logs) for malformed rows so callers can drop them. (finding #3)
   */
  private reshape(raw: { id?: unknown; scope?: unknown; status?: unknown; data?: unknown; created_at?: unknown }): Engram | null {
    const d = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : {}
    // Same field-compat rules as the YAML and Postgres loaders (#877). Without
    // this, a server row still carrying a pre-#866 `reference_count` arrived
    // with the old key and no `write_count`, and every read site had to know to
    // fall back — which two of the three did not.
    const candidate = normalizeEngramInput({ ...d, id: raw.id, scope: raw.scope, status: raw.status })
    const parsed = RemoteRowSchema.safeParse(candidate)
    if (!parsed.success) {
      // #408: do NOT echo server-controlled VALUES into the log. Zod messages can
      // embed the received value, and a crafted id could carry newlines/control
      // chars to forge log lines (log injection) or leak data. Log only the field
      // PATHS + failure CODES, plus a sanitized, bounded id.
      const why = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.code}`).join('; ')
      const safeId = String(raw.id ?? '').replace(/[^\w:./-]/g, '?').slice(0, 64)
      logger.warning(`[plur:remote-store] ${this.url} returned a malformed engram (id="${safeId}") — dropped: ${why}`)
      return null
    }
    // #768 round-trip: the server stores the validity window FLAT in row data
    // (valid_from / valid_until — enterprise#627), while every local consumer
    // reads the nested `temporal` block (inject's expiry gate, decay). Map
    // flat → nested on ingest so remote validity windows actually drive local
    // expiry. Nested values win; only well-typed strings are mapped.
    const out = parsed.data as Record<string, unknown>
    const nested = out.temporal && typeof out.temporal === 'object'
      ? out.temporal as Record<string, unknown>
      : {}
    const flatFrom  = typeof out.valid_from  === 'string' ? out.valid_from  : undefined
    const flatUntil = typeof out.valid_until === 'string' ? out.valid_until : undefined
    const mapFrom  = flatFrom  !== undefined && typeof nested.valid_from  !== 'string'
    const mapUntil = flatUntil !== undefined && typeof nested.valid_until !== 'string'
    if (mapFrom || mapUntil) {
      out.temporal = {
        ...nested,
        // `temporal.learned_at` is required by the schema — prefer what the
        // row carries, then the row's created_at, then "now" as a last resort.
        learned_at: typeof nested.learned_at === 'string' ? nested.learned_at
          : typeof raw.created_at === 'string' ? raw.created_at
          : new Date().toISOString(),
        ...(mapFrom  ? { valid_from: flatFrom }   : {}),
        ...(mapUntil ? { valid_until: flatUntil } : {}),
      }
    }
    return out as unknown as Engram
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      ...extra,
    }
  }

  /**
   * Resolve the identity behind this token — `GET /api/v1/me`. Returns the
   * full authorized scope set the server resolved from group memberships, so
   * the client can discover scopes a token can access without registering them
   * out-of-band (#292). Scope-independent: `/me` is keyed on the token alone,
   * so the driver's `scope` is irrelevant here.
   *
   * Throws on a non-2xx response (caller decides whether to swallow per URL).
   */
  async me(): Promise<{ username: string; org_id: string; role: string; scopes: string[]; scope_metadata: ScopeMetadata[] }> {
    const r = await fetch(`${this.apiBase}/me`, { headers: this.headers() })
    if (!r.ok) {
      const text = sanitiseResponseBody(await r.text().catch(() => ''))
      throw new Error(`Remote /me failed: ${r.status} ${text}`)
    }
    const body = await r.json().catch(() => ({})) as Partial<{ username: string; org_id: string; role: string; scopes: unknown[]; scope_metadata: unknown[] }>
    const scopes = Array.isArray(body.scopes)
      // Validate every /me scope to a safe grammar at the trust boundary:
      //  - #427: a non-string element would later throw in isSharedScope's
      //    `scope.startsWith(...)` BEFORE the per-scope try/catch — drop non-strings.
      //  - #426: scope names render verbatim into the session-start guide (the
      //    agent's directive surface); a name carrying newlines/control chars is a
      //    prompt-injection channel — require `[\w:./-]+` (allows group:org/team,
      //    user:*, etc.) so nothing malformed enters from a hostile/MITM remote.
      ? body.scopes.filter((s): s is string => typeof s === 'string' && /^[\w:./-]+$/.test(s))
      : []
    return {
      username: body.username ?? '',
      org_id:   body.org_id ?? '',
      role:     body.role ?? '',
      scopes,
      // #345 D2: self-describing scope metadata served by the enterprise
      // `scopes` table. Validate each entry through the SAME ScopeMetadataSchema
      // the local config path uses — a hostile/old remote can send anything, so
      // drop entries that don't parse (and any whose `scope` isn't in the
      // authorized set, so a remote can't smuggle metadata for an unrelated
      // scope into discovery). Absent/empty → [] (older servers).
      // #843: a dropped entry must SAY SO. A server/client shape mismatch here
      // disabled covers-based auto-routing on a live deployment and produced no
      // signal anywhere — no warning, no log line, no degraded-mode flag. It was
      // found only by diffing plur_scopes_discover against the admin UI, because
      // `rankScopes` skips entries with empty covers, so an empty metadata list
      // means zero candidates and every unscoped write falls to the personal
      // `unscoped_default`. Team knowledge silently stopped reaching team scopes
      // while the admin dashboard rendered all five scopes as fine.
      //
      // One warning on the first connection would have caught it. The authorized-
      // set drop stays quiet: that one is a deliberate refusal (a remote must not
      // smuggle metadata for a scope it did not grant), not an unexpected shape.
      scope_metadata: Array.isArray(body.scope_metadata)
        ? body.scope_metadata.flatMap((m) => {
            const parsed = ScopeMetadataSchema.safeParse(m)
            if (!parsed.success) {
              // Log PATHS and CODES only, never server-controlled values (#408):
              // a Zod message can embed the received value, and a crafted one
              // could carry control chars to forge log lines.
              const why = parsed.error.issues
                .map(i => `${i.path.join('.') || '(root)'}: ${i.code}`)
                .join('; ')
              const safeScope = String((m as { scope?: unknown } | null)?.scope ?? '<unknown>')
                .replace(/[^\w:./-]/g, '?')
                .slice(0, 64)
              logger.warning(
                `[plur:remote-store] ${this.url} sent scope metadata for "${safeScope}" that does not conform ` +
                `(${why}) — DROPPED. That scope cannot participate in covers-based auto-routing until the ` +
                `server sends a conforming shape, so unscoped writes may fall back to the personal default (#843).`,
              )
              return []
            }
            if (!scopes.includes(parsed.data.scope)) return []
            return [parsed.data]
          })
        : [],
    }
  }

  /**
   * Load all engrams visible to this token at this scope. Cached up to
   * ttlMs; in-flight calls deduplicate to avoid thundering-herd on
   * the remote when 5 things ask for engrams at once.
   */
  async load(): Promise<Engram[]> {
    const now = Date.now()
    if (this.cache && now - this.cache.ts < this.ttlMs) return this.cache.engrams
    if (this.inFlight) return this.inFlight

    this.inFlight = (async () => {
      try {
        // Page through results — the server caps at 200/page; for a pilot
        // that's plenty per scope, but we walk pages defensively.
        const all: Engram[] = []
        let offset = 0
        const limit = 200
        const maxPages = 50  // hard cap to avoid runaway loops
        // #550: only cache a result set from a clean (complete) pagination run.
        // A mid-pagination abort/error must not overwrite a prior good cache with
        // a partial view — that's the "cache poisoning" class fixed in #130 for
        // cold-cache appends, and reintroduced by #531 for page-fetch errors.
        let paginationComplete = false
        for (let i = 0; i < maxPages; i++) {
          const u = `${this.apiBase}/engrams?scope=${encodeURIComponent(this.scope)}&limit=${limit}&offset=${offset}`
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), LOAD_FETCH_TIMEOUT_MS)
          try {
            const r = await fetch(u, { headers: this.headers(), signal: ctrl.signal })
            if (!r.ok) {
              // 403 (no read access) and 404 (scope doesn't exist) are stable
              // states: the scope genuinely has nothing for us. Cache [] so we
              // don't spam the server on every TTL expiry.
              // 5xx are transient — don't cache the partial/empty result; fall
              // back to the prior good cache so recall stays useful.
              if (r.status === 403 || r.status === 404) {
                paginationComplete = true
              } else if (r.status >= 500) {
                console.error(`[plur:remote-store] ${this.url} returned ${r.status} loading scope ${this.scope}`)
              }
              break
            }
            const body = await r.json() as { rows: any[]; total_count: number }
            // Server returns DB rows shaped {id, scope, status, data, created_at, updated_at}
            // — the engram contents live in row.data. Reshape + validate; drop malformed.
            for (const row of body.rows) {
              const e = this.reshape(row)
              if (e) all.push(e)
            }
            if (all.length >= body.total_count || body.rows.length < limit) {
              paginationComplete = true
              break
            }
            offset += limit
          } catch (err) {
            const msg = (err as Error).name === 'AbortError'
              ? `page fetch timed out after ${LOAD_FETCH_TIMEOUT_MS}ms`
              : (err as Error).message
            console.error(`[plur:remote-store] ${this.url} load page failed: ${msg}`)
            break
          } finally {
            clearTimeout(t)
          }
        }
        if (paginationComplete) {
          this.cache = { ts: Date.now(), engrams: all }
          return all
        }
        // Incomplete pagination (transient error / abort): preserve the prior
        // good cache and return it so callers keep seeing valid engrams. Fall
        // back to the partial set only if there is no prior cache at all.
        return this.cache?.engrams ?? all
      } catch (err) {
        console.error(`[plur:remote-store] ${this.url} load failed: ${(err as Error).message}`)
        // Don't poison the cache on failure — let the next call retry.
        return this.cache?.engrams ?? []
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  /**
   * Append a single engram to the remote store. POST /api/v1/engrams
   * carries the core four (statement + scope + domain + type) plus every
   * optional field that is set — pinned, rationale, tags, commitment,
   * validity window, supersedes, locked_reason (#768). The server handles
   * ID assignment, content_hash, status.
   *
   * Returns void to satisfy the EngramStore interface contract. Callers
   * that need the server-assigned ID (e.g. so the user can later
   * forget/feedback on it) should use `appendAndGetServerId()` instead.
   */
  async append(engram: Engram): Promise<void> {
    await this.appendAndGetServerId(engram)
  }

  /**
   * Like append() but returns the server-assigned ID. Required because
   * the server picks its own ID (e.g. ENG-2026-05-06-007) and ignores
   * any id we'd send. Without this, callers see the local placeholder
   * ID (e.g. ENG-2026-0506-017) and a later `forget(id)` against that
   * placeholder will fail — the engram only exists on the server with
   * the server's ID.
   */
  async appendAndGetServerId(engram: Engram): Promise<{ id: string }> {
    // #768: transmit the full engram, not just the core four — pinned,
    // rationale, tags, commitment, validity windows and supersedes were
    // silently dropped, so team-scope pins never round-tripped. Optional
    // fields are included only when set, so older servers that ignore
    // unknown keys see no behavioral change.
    const e = engram as any
    // Canonical engrams carry the validity window nested under `temporal`
    // (temporal.valid_from / temporal.valid_until, #347) and supersession
    // under `relations.supersedes` (#240) — the wire contract
    // (POST /api/v1/engrams, enterprise#627) takes them as FLAT top-level
    // keys, so flatten here. Top-level reads are kept as a fallback for
    // non-canonical shapes; they are always undefined on production engrams.
    const valid_from  = e.temporal?.valid_from  ?? e.valid_from
    const valid_until = e.temporal?.valid_until ?? e.valid_until
    const supersedes  = Array.isArray(e.relations?.supersedes) && e.relations.supersedes.length > 0
      ? e.relations.supersedes
      : e.supersedes
    const body = JSON.stringify({
      statement: e.statement,
      scope:     engram.scope,
      domain:    e.domain,
      type:      e.type,
      ...(Array.isArray(e.tags) && e.tags.length > 0 ? { tags: e.tags } : {}),
      ...(e.pinned !== undefined            ? { pinned: e.pinned }             : {}),
      ...(e.rationale != null               ? { rationale: e.rationale }       : {}),
      ...(e.commitment !== undefined        ? { commitment: e.commitment }     : {}),
      ...(valid_from != null                ? { valid_from }                   : {}),
      ...(valid_until != null               ? { valid_until }                  : {}),
      ...(Array.isArray(supersedes) && supersedes.length > 0 ? { supersedes } : {}),
      ...(e.locked_reason != null           ? { locked_reason: e.locked_reason } : {}),
      // Provenance rides the wire when present (#676 rescope: the pushed copy
      // carries "rescoped from <original id>" in `source`). Additive — servers
      // that don't model `source` ignore the field, and it is omitted entirely
      // when unset so the historical body is byte-identical without it.
      ...(e.source != null                  ? { source: e.source }             : {}),
    })
    const r = await fetch(`${this.apiBase}/engrams`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body,
    })
    if (!r.ok) {
      const text = sanitiseResponseBody(await r.text().catch(() => ''))
      throw new Error(`Remote store append failed: ${r.status} ${text}`)
    }
    const data = await r.json().catch(() => ({})) as { id?: unknown }
    // #404: validate the server-assigned id's SHAPE, not just truthiness. It
    // becomes this engram's id (cached, rendered, used as a key), so a non-string,
    // empty, over-long, or control-char-bearing id from a buggy/hostile endpoint
    // must be rejected rather than trusted.
    const id = data.id
    if (typeof id !== 'string' || id.length === 0 || id.length > 128 || !/^[\w:./-]+$/.test(id)) {
      const shown = typeof id === 'string' ? `"${id.slice(0, 64).replace(/[^\w:./-]/g, '?')}"` : typeof id
      throw new Error(`Remote store append: server returned an invalid id (${shown})`)
    }
    // Optimistic cache insert (issue #89): the POST succeeded so the server
    // has the engram. Insert with the server-assigned id so the very next
    // recall sees it without waiting for a background refresh. If the server
    // transformed other fields, the next refresh corrects them.
    const stored = { ...(engram as any), id } as Engram
    if (this.cache) {
      this.cache.engrams.push(stored)
    } else {
      // Cold cache (no prior load()): one engram is not "all engrams in
      // this scope". Mark stale (ts: 0) so the next load() refetches
      // from the server instead of treating the partial view as fresh.
      this.cache = { ts: 0, engrams: [stored] }
    }
    return { id }
  }

  /**
   * `save(all)` — used by migrations to bulk-replace. Not supported
   * on remote: the server keeps an audit trail and we don't want a
   * single client to be able to nuke + replace the whole store. Throws.
   */
  async save(_engrams: Engram[]): Promise<void> {
    throw new Error('Remote store does not support bulk save() — use append()/remove() per engram')
  }

  async getById(id: string): Promise<Engram | null> {
    try {
      const r = await fetch(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, { headers: this.headers() })
      if (r.status === 404) return null
      if (!r.ok) return null
      const row = await r.json() as any
      return this.reshape(row)
    } catch {
      return null
    }
  }

  /**
   * Existence probe that distinguishes "definitely absent" from "cannot tell".
   *
   * `getById` collapses both onto `null` — a 404 and a dead network return the
   * same value — which is safe for the read paths that only want the engram,
   * and unsafe for anything deciding whether it is free to act. `forget()`
   * needs the distinction: treating an unreachable store as "not there" is how
   * an id collision goes unnoticed and the wrong engram gets retired (#831).
   *
   * Returns false ONLY on an authoritative 404. Anything else — transport
   * failure, 5xx, auth rejection — throws, so the caller must decide what an
   * unknown means rather than inheriting a silent "no".
   *
   * BOUNDED, and that is not a nicety (2026-08-13 data-loss audit, F2). Both
   * callers — `forget()` and `feedback()` — run this INSIDE the primary store
   * lock, one probe per configured remote. An unbounded `fetch` inherits
   * undici's 300s `headersTimeout`, so a host that completes its handshake and
   * then stalls holds the lock every other write path needs for five minutes,
   * past the 180s `DEFAULT_ACQUIRE_TIMEOUT` — waiting `plur_learn` calls throw
   * "Failed to acquire lock" and the engram is silently never stored. The
   * budget is the same one `load()` uses, for the same reason.
   */
  async existsById(id: string): Promise<boolean> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), LOAD_FETCH_TIMEOUT_MS)
    let r: Response
    try {
      r = await fetch(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, {
        headers: this.headers(),
        signal: ctrl.signal,
      })
    } catch (err) {
      // An abort is "cannot tell", not "absent" — the whole point of this
      // method — so it must surface as a throw like any other transport
      // failure, with a message that says which it was.
      throw new Error(
        ctrl.signal.aborted
          ? `existence probe for ${id} timed out after ${LOAD_FETCH_TIMEOUT_MS}ms against ${this.apiBase}`
          : `existence probe for ${id} failed against ${this.apiBase}: ${(err as Error).message}`,
      )
    } finally {
      clearTimeout(timer)
    }
    if (r.status === 404) return false
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${this.apiBase}`)
    // A 200 is not on its own proof of existence — confirm the body actually
    // describes THIS engram. Servers and proxies return 200 with collection or
    // envelope payloads on routes they do not recognise, and inferring
    // existence from the status line alone would turn that into a false
    // collision report on every forget.
    const row = await r.json().catch(() => null) as { id?: unknown } | null
    return typeof row?.id === 'string' && row.id === id
  }

  /** Remove → DELETE /api/v1/engrams/:id (server soft-retires). */
  async remove(id: string): Promise<boolean> {
    const r = await fetch(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!r.ok) return false
    this.cache = null
    return true
  }

  /**
   * Apply feedback to a remote engram. POST /api/v1/engrams/:id/feedback
   * sends the raw signal; the server owns the mutation logic (strength
   * adjustment, commitment promotion, counter increment).
   *
   * Not part of the EngramStore interface — RemoteStore-specific.
   * Requires server support: see https://github.com/plur-ai/plur/issues/85
   */
  async feedback(id: string, signal: 'positive' | 'negative' | 'neutral'): Promise<void> {
    const r = await fetch(`${this.apiBase}/engrams/${encodeURIComponent(id)}/feedback`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ signal }),
    })
    if (!r.ok) {
      const text = sanitiseResponseBody(await r.text().catch(() => ''))
      throw new Error(`Remote feedback failed: ${r.status} ${text}`)
    }
    this.cache = null
  }

  async count(filter?: { status?: string }): Promise<number> {
    // Cheap-ish: load (cached) and filter client-side. The server has
    // a count column we could add an endpoint for, but at pilot scale
    // this is fine.
    const all = await this.load()
    if (filter?.status) return all.filter(e => e.status === filter.status).length
    return all.length
  }

  /**
   * Partial update of a remote engram. PATCH /api/v1/engrams/:id accepts
   * any subset of {pinned, status, statement, ...}. The server applies
   * the diff atomically; unsupplied fields are unchanged.
   *
   * Not part of the EngramStore interface — RemoteStore-specific.
   * Requires server support: enterprise PR #111 (merged 2026-05-21).
   * Used by setPinned, promote, reportFailure for remote routing
   * (closes the pin/promote/reportFailure remainder of issue #86).
   */
  async patch(id: string, updates: Partial<Engram>): Promise<Engram | null> {
    const r = await fetch(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(updates),
    })
    if (r.status === 404) return null
    if (!r.ok) {
      const text = sanitiseResponseBody(await r.text().catch(() => ''))
      throw new Error(`Remote patch failed: ${r.status} ${text}`)
    }
    // #327: the server confirmed the write (2xx). Capture the pre-write row
    // from the cache BEFORE invalidating so the fallback below can merge it.
    const prev = this.cache?.engrams.find(e => e.id === id) ?? null
    this.cache = null
    // Server returns {engram: {id, scope, status, data: {...}, ...}}; reshape
    // to top-level Engram (same as load() does for rows[]).
    const body = await r.json().catch(() => null) as { engram?: { id: string; scope: string; status: string; data?: any } } | null
    const reshaped = body?.engram ? this.reshape(body.engram) : null
    if (reshaped) return reshaped
    // #327: 2xx but the echoed row was missing or failed validation. Returning
    // null here would be indistinguishable from the 404 above — callers would
    // misreport a successful write as not-found, or retry it. Return the
    // optimistically-merged engram (pre-write cached row + the acknowledged
    // updates); the next load() observes the server's authoritative state.
    // Only defined update values are applied, mirroring what JSON.stringify
    // actually sent to the server. Same #408 id sanitization as reshape().
    const safeId = id.replace(/[^\w:./-]/g, '?').slice(0, 64)
    logger.warning(`[plur:remote-store] ${this.url} PATCH ${safeId} succeeded but the echoed row was unusable — returning optimistic merge`)
    const merged: Record<string, unknown> = prev ? { ...(prev as unknown as Record<string, unknown>) } : {}
    for (const [k, v] of Object.entries(updates)) if (v !== undefined) merged[k] = v
    merged.id = id
    return merged as unknown as Engram
  }

  async close(): Promise<void> {
    // Stateless HTTP — nothing to close. Drop the cache for hygiene.
    this.cache = null
  }
}
