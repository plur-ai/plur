import { z } from 'zod'
import type { Engram } from '../schemas/engram.js'
import type { EngramStore } from './types.js'
import { logger } from '../logger.js'

/**
 * Lenient validation for semi-trusted remote rows (security audit 2026-06-10,
 * finding #3). The server may legitimately omit optional engram fields, so we
 * don't demand the full Engram shape — but we DO type-check the security-relevant
 * fields and reject structurally-broken rows. Without this, a compromised or
 * malicious remote could spread arbitrary / type-confused data (and instruction-
 * carrying `statement`s) into the local injection pool via `as unknown as Engram`.
 * `.passthrough()` keeps unmodeled fields; the point is to gate the meaningful ones.
 */
const RemoteRowSchema = z.object({
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
    // append /api/v1.
    return this.url.replace(/\/sse\/?$/, '').replace(/\/$/, '') + '/api/v1'
  }

  private get ttlMs(): number { return this.opts.ttlMs ?? 60_000 }

  /**
   * Reshape a DB row {id, scope, status, data} into an Engram and validate it.
   * Authoritative columns (id/scope/status) win over anything in `data`. Returns
   * null (and logs) for malformed rows so callers can drop them. (finding #3)
   */
  private reshape(raw: { id?: unknown; scope?: unknown; status?: unknown; data?: unknown }): Engram | null {
    const d = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : {}
    const candidate = { ...d, id: raw.id, scope: raw.scope, status: raw.status }
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
    return parsed.data as unknown as Engram
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
  async me(): Promise<{ username: string; org_id: string; role: string; scopes: string[] }> {
    const r = await fetch(`${this.apiBase}/me`, { headers: this.headers() })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      throw new Error(`Remote /me failed: ${r.status} ${text}`)
    }
    const body = await r.json().catch(() => ({})) as Partial<{ username: string; org_id: string; role: string; scopes: unknown[] }>
    return {
      username: body.username ?? '',
      org_id:   body.org_id ?? '',
      role:     body.role ?? '',
      // Validate every /me scope to a safe grammar at the trust boundary:
      //  - #427: a non-string element would later throw in isSharedScope's
      //    `scope.startsWith(...)` BEFORE the per-scope try/catch — drop non-strings.
      //  - #426: scope names render verbatim into the session-start guide (the
      //    agent's directive surface); a name carrying newlines/control chars is a
      //    prompt-injection channel — require `[\w:./-]+` (allows group:org/team,
      //    user:*, etc.) so nothing malformed enters from a hostile/MITM remote.
      scopes:   Array.isArray(body.scopes)
        ? body.scopes.filter((s): s is string => typeof s === 'string' && /^[\w:./-]+$/.test(s))
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
        for (let i = 0; i < maxPages; i++) {
          const u = `${this.apiBase}/engrams?scope=${encodeURIComponent(this.scope)}&limit=${limit}&offset=${offset}`
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), LOAD_FETCH_TIMEOUT_MS)
          const r = await fetch(u, { headers: this.headers(), signal: ctrl.signal }).finally(() => clearTimeout(t))
          if (!r.ok) {
            // 403 (no read access) and 404 (scope doesn't exist) are
            // not errors at the store level — that store just contributes
            // nothing. Bubble other 5xx as logs.
            if (r.status >= 500) console.error(`[plur:remote-store] ${this.url} returned ${r.status} loading scope ${this.scope}`)
            break
          }
          const body = await r.json() as { rows: any[]; total_count: number }
          // Server returns DB rows shaped {id, scope, status, data, created_at, updated_at}
          // — the engram contents live in row.data. Reshape + validate; drop malformed.
          for (const row of body.rows) {
            const e = this.reshape(row)
            if (e) all.push(e)
          }
          if (all.length >= body.total_count || body.rows.length < limit) break
          offset += limit
        }
        this.cache = { ts: Date.now(), engrams: all }
        return all
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
   * carries statement + scope + domain + type — the server handles
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
    const body = JSON.stringify({
      statement: (engram as any).statement,
      scope:     engram.scope,
      domain:    (engram as any).domain,
      type:      (engram as any).type,
    })
    const r = await fetch(`${this.apiBase}/engrams`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body,
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
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
      const text = await r.text().catch(() => '')
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
      const text = await r.text().catch(() => '')
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
