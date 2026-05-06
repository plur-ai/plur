import type { Engram } from '../schemas/engram.js'
import type { EngramStore } from './types.js'

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

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      ...extra,
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
          const r = await fetch(u, { headers: this.headers() })
          if (!r.ok) {
            // 403 (no read access) and 404 (scope doesn't exist) are
            // not errors at the store level — that store just contributes
            // nothing. Bubble other 5xx as logs.
            if (r.status >= 500) console.error(`[plur:remote-store] ${this.url} returned ${r.status} loading scope ${this.scope}`)
            break
          }
          const body = await r.json() as { rows: any[]; total_count: number }
          // Server returns DB rows shaped {id, scope, status, data, created_at, updated_at}
          // — the engram contents live in row.data. Reshape to the Engram shape callers expect.
          for (const row of body.rows) {
            const d = row.data ?? {}
            all.push({
              id: row.id,
              scope: row.scope,
              status: row.status,
              ...d,
            } as unknown as Engram)
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
    const data = await r.json().catch(() => ({})) as { id?: string }
    if (!data.id) {
      throw new Error(`Remote store append succeeded but server returned no id`)
    }
    this.cache = null
    return { id: data.id }
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
      return { id: row.id, scope: row.scope, status: row.status, ...(row.data ?? {}) } as unknown as Engram
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

  async count(filter?: { status?: string }): Promise<number> {
    // Cheap-ish: load (cached) and filter client-side. The server has
    // a count column we could add an endpoint for, but at pilot scale
    // this is fine.
    const all = await this.load()
    if (filter?.status) return all.filter(e => e.status === filter.status).length
    return all.length
  }

  async close(): Promise<void> {
    // Stateless HTTP — nothing to close. Drop the cache for hygiene.
    this.cache = null
  }
}
