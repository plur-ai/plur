/**
 * Lightweight in-process HTTP stub server for integration testing
 * RemoteStore against a real TCP connection (no fetch mocking).
 *
 * ## Why this exists
 *
 * Unit tests mock `globalThis.fetch` — fast but can't catch wire-level bugs
 * (serialization, URL encoding, header handling, status codes). The full
 * enterprise server (plur-ai/enterprise) requires Docker + Postgres — too
 * heavy for the plur monorepo CI.
 *
 * This stub implements the 4 REST endpoints RemoteStore calls, using Node's
 * built-in `http` module and an in-memory Map. No external dependencies.
 * Starts/stops in <50ms.
 *
 * ## Endpoints implemented
 *
 * | Method | Path | Behavior |
 * |--------|------|----------|
 * | GET | /api/v1/me | Resolved identity + authorized scopes (override via setMe) |
 * | GET | /api/v1/engrams?scope=...&limit=...&offset=... | List engrams by scope, paginated |
 * | GET | /api/v1/engrams/:id | Get single engram or 404 |
 * | POST | /api/v1/engrams | Create engram, assigns server ID |
 * | DELETE | /api/v1/engrams/:id | Soft-retire (set status=retired) or 404 |
 *
 * ## Auth
 *
 * Checks `Authorization: Bearer <token>`. Returns 401 on mismatch.
 * Pass any string as the valid token at construction time.
 *
 * ## Usage
 *
 * ```typescript
 * const server = new StubServer('test-token-123')
 * const { url, token } = await server.start()
 * // url = 'http://127.0.0.1:<port>' — use as RemoteStore URL
 * // ... run tests ...
 * await server.stop()
 * ```
 *
 * ## Keeping this in sync
 *
 * When RemoteStore adds new endpoints (e.g. POST /engrams/:id/feedback),
 * add the corresponding handler here. The stub should mirror the contract
 * documented in RemoteStore's JSDoc, not the full enterprise server.
 *
 * See: https://github.com/plur-ai/plur/issues/81
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'

interface StoredEngram {
  id: string
  scope: string
  status: string
  data: Record<string, unknown>
  created_at: string
  updated_at: string
}

export class StubServer {
  private server: Server | null = null
  private engrams = new Map<string, StoredEngram>()
  private idCounter = 0
  private port = 0
  // Identity returned by GET /api/v1/me (#292). Defaults to a single-scope
  // user; override per-test with setMe() to simulate multi-team authorization.
  // #345 D2: scope_metadata is optional and defaults to absent so older-server
  // behavior is the default; setMe({ scope_metadata }) opts a test into it.
  private me: { username: string; org_id: string; role: string; scopes: string[]; scope_metadata?: unknown[] } = {
    username: 'testuser', org_id: 'test-org', role: 'developer', scopes: ['group:test'],
  }
  /** When set, POST /engrams returns this as the assigned id instead of a valid
   *  one — to simulate a buggy/hostile server (e.g. for the #404 id-shape test). */
  badAppendId: unknown = null
  /** When set, PATCH /engrams/:id still applies the update server-side but
   *  echoes this value as the {engram: ...} body — to simulate a server whose
   *  echoed row fails RemoteRowSchema validation (#327). */
  badPatchEcho: unknown = null

  constructor(private readonly validToken: string) {}

  /** Override the GET /api/v1/me response (authorized scope set, identity).
   *  #345 D2: pass `scope_metadata` to simulate a server that serves
   *  self-describing scope metadata. */
  setMe(me: Partial<{ username: string; org_id: string; role: string; scopes: string[]; scope_metadata: unknown[] }>): void {
    this.me = { ...this.me, ...me }
  }

  /** Start the server on a random available port. Returns the base URL and token. */
  async start(): Promise<{ url: string; token: string }> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (!addr || typeof addr === 'string') return reject(new Error('unexpected address'))
        this.port = addr.port
        resolve({ url: `http://127.0.0.1:${this.port}`, token: this.validToken })
      })
      this.server.on('error', reject)
    })
  }

  /** Stop the server and clear all data. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => {
        this.server = null
        this.engrams.clear()
        this.idCounter = 0
        resolve()
      })
    })
  }

  /** How many engrams are stored (for test assertions). */
  get engramCount(): number { return this.engrams.size }

  /** Direct access for test assertions — returns a copy. */
  getEngram(id: string): StoredEngram | undefined {
    const e = this.engrams.get(id)
    return e ? { ...e } : undefined
  }

  /** Seed an engram directly (for cold-start tests). */
  seedEngram(engram: { id: string; scope: string; status: string; data: Record<string, unknown> }): void {
    this.engrams.set(engram.id, {
      id: engram.id,
      scope: engram.scope,
      status: engram.status,
      data: engram.data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  }

  /** Reset all data without restarting. */
  reset(): void {
    this.engrams.clear()
    this.idCounter = 0
    this.badAppendId = null
    this.badPatchEcho = null
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Auth check
    const authHeader = req.headers.authorization
    if (authHeader !== `Bearer ${this.validToken}`) {
      this.json(res, 401, { error: 'Invalid or expired token' })
      return
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    // GET /api/v1/me — resolved identity + authorized scopes (#292)
    if (method === 'GET' && path === '/api/v1/me') {
      this.json(res, 200, this.me)
      return
    }

    // POST /api/v1/engrams — create
    if (method === 'POST' && path === '/api/v1/engrams') {
      this.readBody(req, (body) => {
        const { statement, scope, domain, type } = body
        const id = `ENG-SRV-${String(++this.idCounter).padStart(3, '0')}`
        const now = new Date().toISOString()
        const engram: StoredEngram = {
          id,
          scope: scope ?? 'global',
          status: 'active',
          data: { statement, domain, type },
          created_at: now,
          updated_at: now,
        }
        this.engrams.set(id, engram)
        // Normally the server returns the real assigned id; badAppendId lets a
        // test make it return a malformed one (#404).
        const returnedId = this.badAppendId !== null ? this.badAppendId : id
        this.json(res, 201, { id: returnedId, scope: engram.scope, status: engram.status, data: engram.data })
      })
      return
    }

    // GET /api/v1/engrams/:id — get by ID
    const idMatch = path.match(/^\/api\/v1\/engrams\/([^/]+)$/)
    if (method === 'GET' && idMatch) {
      const id = decodeURIComponent(idMatch[1])
      const engram = this.engrams.get(id)
      if (!engram) {
        this.json(res, 404, { error: 'Not found' })
        return
      }
      this.json(res, 200, engram)
      return
    }

    // DELETE /api/v1/engrams/:id — retire
    if (method === 'DELETE' && idMatch) {
      const id = decodeURIComponent(idMatch[1])
      const engram = this.engrams.get(id)
      if (!engram) {
        this.json(res, 404, { error: 'Not found' })
        return
      }
      engram.status = 'retired'
      engram.updated_at = new Date().toISOString()
      this.json(res, 200, { id: engram.id, scope: engram.scope, status: 'retired' })
      return
    }

    // PATCH /api/v1/engrams/:id — partial update (enterprise PR #111).
    // Accepts subset of {pinned, status, statement, ...}; merges into engram.data.
    if (method === 'PATCH' && idMatch) {
      const id = decodeURIComponent(idMatch[1])
      const engram = this.engrams.get(id)
      if (!engram) {
        this.json(res, 404, { error: 'Not found' })
        return
      }
      this.readBody(req, (body) => {
        const data = engram.data as any
        // Apply each field present in body to engram.data
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined) continue
          if (k === 'status') {
            engram.status = String(v)
          }
          data[k] = v
        }
        engram.updated_at = new Date().toISOString()
        // #327: optionally echo a malformed row AFTER applying the write, to
        // simulate "PATCH succeeded but the response fails validation".
        if (this.badPatchEcho !== null) {
          this.json(res, 200, { engram: this.badPatchEcho })
          return
        }
        // Server returns the patched engram in {engram: ...} envelope so the
        // client can observe the post-write authoritative state.
        this.json(res, 200, { engram: { id: engram.id, scope: engram.scope, status: engram.status, data } })
      })
      return
    }

    // GET /api/v1/engrams?scope=...&limit=...&offset=... — list
    if (method === 'GET' && path === '/api/v1/engrams') {
      const scope = url.searchParams.get('scope')
      const limit = parseInt(url.searchParams.get('limit') ?? '200', 10)
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10)

      let all = Array.from(this.engrams.values())
      if (scope) {
        all = all.filter(e => e.scope === scope)
      }
      const total_count = all.length
      const rows = all.slice(offset, offset + limit)
      this.json(res, 200, { rows, total_count })
      return
    }

    // POST /api/v1/engrams/:id/feedback — feedback
    const feedbackMatch = path.match(/^\/api\/v1\/engrams\/([^/]+)\/feedback$/)
    if (method === 'POST' && feedbackMatch) {
      const id = decodeURIComponent(feedbackMatch[1])
      const engram = this.engrams.get(id)
      if (!engram) {
        this.json(res, 404, { error: 'Not found' })
        return
      }
      this.readBody(req, (body) => {
        const signal = body.signal as string
        const data = engram.data as any
        if (!data.feedback_signals) {
          data.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
        }
        data.feedback_signals[signal] = (data.feedback_signals[signal] ?? 0) + 1
        if (signal === 'positive') {
          data.retrieval_strength = Math.min(1.0, (data.retrieval_strength ?? 0.7) + 0.05)
        } else if (signal === 'negative') {
          data.retrieval_strength = Math.max(0.0, (data.retrieval_strength ?? 0.7) - 0.1)
        }
        engram.updated_at = new Date().toISOString()
        this.json(res, 200, { id, signal, applied: true })
      })
      return
    }

    this.json(res, 404, { error: `Unknown route: ${method} ${path}` })
  }

  private readBody(req: IncomingMessage, cb: (body: Record<string, unknown>) => void): void {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        cb(body)
      } catch {
        // Empty or invalid JSON — pass empty object
        cb({})
      }
    })
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }
}
