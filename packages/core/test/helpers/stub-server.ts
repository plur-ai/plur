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
  // #1310: `capabilities` is optional and absent by default (older server);
  // setMe({ capabilities: ['feedback.source'] }) simulates a capable server.
  private me: { username: string; org_id: string; role: string; scopes: string[]; scope_metadata?: unknown[]; capabilities?: unknown[] } = {
    username: 'testuser', org_id: 'test-org', role: 'developer', scopes: ['group:test'],
  }
  /** When set, POST /engrams returns this as the assigned id instead of a valid
   *  one — to simulate a buggy/hostile server (e.g. for the #404 id-shape test). */
  badAppendId: unknown = null
  /** When set, POST /engrams short-circuits to this error response BEFORE reading
   *  the body — to simulate a server that rejects the write (#912 sanitise test). */
  appendErrorResponse: { status: number; body: string } | null = null
  /** Per-scope refusal for POST /engrams, keyed by the body's `scope` — to
   *  simulate a server that refuses one scope while accepting another on the
   *  same host (#1308). Checked after the body is read. */
  appendErrorByScope: Record<string, { status: number; body: string }> = {}
  /** Delay before answering POST /engrams, ms — a slow-but-alive remote, for
   *  bounded-flush tests (#1269). The write is still applied when it answers. */
  appendDelayMs = 0
  /** Number of POST /api/v1/engrams requests received, answered or refused
   *  (#1299: proves a backed-off outbox entry did not dial the server). */
  appendCalls = 0
  /** With `appendDelayMs`: store the engram only when the delayed answer is
   *  sent, so a client that gives up first leaves nothing on the server. */
  appendDropWhileDelayed = false
  /** Statement of every POST /engrams body received, in arrival order. The
   *  server ignores the key unless `honourIdempotency` is set, so this counts
   *  every push that reached it — duplicates included. */
  appendStatements: string[] = []
  /** Pending holds, consumed one per POST /engrams in arrival order: the
   *  engram is stored on receipt, but the answer waits for `release()`. */
  private appendHolds: Array<{ arrived: (statement: string) => void; released: Promise<void> }> = []
  /** `Idempotency-Key` header of the most recent POST /engrams. */
  lastAppendIdempotencyKey: string | null = null
  /** Every `Idempotency-Key` received on an accepted POST /engrams, in order. */
  appendKeys: Array<string | null> = []
  /** Model a server that follows docs/remote-store-contract.md on POST: a key
   *  already accepted from the same token replays the original response. */
  honourIdempotency = false
  private idempotencyReplies = new Map<string, { id: string; scope: string; status: string; data: Record<string, unknown> }>()
  /** When set, PATCH /engrams/:id still applies the update server-side but
   *  echoes this value as the {engram: ...} body — to simulate a server whose
   *  echoed row fails RemoteRowSchema validation (#327). */
  badPatchEcho: unknown = null
  /** Raw JSON body of the most recent POST /engrams — lets tests assert what
   *  the client actually transmits on the wire (#768: optional fields like
   *  pinned/rationale/tags were silently never sent). */
  lastAppendBody: Record<string, unknown> | null = null
  /** Number of DELETE /engrams/:id requests received. */
  deleteCalls = 0
  /** When set, awaited before a POST /engrams is handled, with the 1-based call
   *  number — lets a test hold one write on the wire while another client runs
   *  (deterministic interleaving across two clients). */
  appendHook: ((n: number) => Promise<void>) | null = null
  /** Every POST /engrams/:id/feedback body received, in order (#1310: assert
   *  whether `source` was sent). */
  feedbackBodies: Array<Record<string, unknown>> = []
  /** Number of GET /api/v1/me requests received (#1310 capability caching). */
  meCalls = 0
  /** Number of GET /api/v1/engrams/:id requests received (#1318 review: remote
   *  ids are fetched only from stores that advertise the capability). */
  getByIdCalls = 0
  /** Delay before answering POST /engrams/:id/feedback, ms — to simulate a
   *  slow server a hook watchdog cuts off mid-way (#1318 review). */
  feedbackDelayMs = 0
  /** When set, GET /api/v1/me answers only after this settles — a server
   *  that holds the answer while the test changes the client's world (#1415
   *  review: a folder swapped for a symlink to $HOME during the round trip). */
  beforeMe: (() => void | Promise<void>) | null = null

  // --- POST /api/v1/recall (#776 server-authoritative recall envelope) ---
  /** Rows served in the envelope's `results` (top-level engram shape, each
   *  optionally carrying a per-response 0-1 `score`). */
  recallRows: unknown[] = []
  /** Force an HTTP status for /recall (401/403/404/429/500...). null = 200. */
  recallStatus: number | null = null
  /** Retry-After header value served with a forced 429. */
  recallRetryAfter: string | null = null
  /** Raw body override (serialized as JSON) — for invalid-envelope tests. */
  recallBodyOverride: unknown = null
  /** Delay before responding, ms — for timeout tests. */
  recallDelayMs = 0
  /** Serve an oversize (>128KB) body. */
  recallOversize = false
  /** Old-server mode: bare `{results, count}` envelope without
   *  mode/vector/effective_scopes/dropped_scopes (#628 tolerance). */
  recallBare = false
  /** Extra envelope fields (mode/vector/dropped_scopes/...) merged in. */
  recallEnvelope: Record<string, unknown> = {}
  /** Number of POST /api/v1/recall requests received (call spy). */
  recallCalls = 0
  /** Last POST /api/v1/recall request body (assert scopes/query/timeout_ms). */
  lastRecallBody: Record<string, unknown> | null = null

  constructor(private readonly validToken: string) {}

  /** Override the GET /api/v1/me response (authorized scope set, identity).
   *  #345 D2: pass `scope_metadata` to simulate a server that serves
   *  self-describing scope metadata. */
  setMe(me: Partial<{ username: string; org_id: string; role: string; scopes: string[]; scope_metadata: unknown[]; capabilities: unknown[] }>): void {
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
      // Drop connections a delayed response is still holding, or close() waits
      // for them (#1269 bounded-flush tests leave one open on purpose).
      this.server.closeAllConnections?.()
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

  /**
   * Hold the answer to the next POST /engrams that arrives (after any holds
   * already queued). `arrived` resolves with its statement once the engram is
   * stored; the client gets its answer only after `release()`. For ordering
   * separate writer processes deterministically.
   */
  holdNextAppend(): { arrived: Promise<string>; release: () => void } {
    let arrived!: (statement: string) => void
    let release!: () => void
    const arrivedP = new Promise<string>(r => { arrived = r })
    const released = new Promise<void>(r => { release = r })
    this.appendHolds.push({ arrived, released })
    return { arrived: arrivedP, release }
  }

  /** How many POST /engrams bodies with this statement arrived. */
  appendCountFor(statement: string): number {
    return this.appendStatements.filter(s => s === statement).length
  }

  /** Reset all data without restarting. */
  reset(): void {
    this.engrams.clear()
    this.idCounter = 0
    this.badAppendId = null
    this.appendErrorResponse = null
    this.appendErrorByScope = {}
    this.appendDelayMs = 0
    this.appendCalls = 0
    this.appendDropWhileDelayed = false
    this.appendStatements = []
    this.appendHolds = []
    this.lastAppendIdempotencyKey = null
    this.appendKeys = []
    this.honourIdempotency = false
    this.idempotencyReplies.clear()
    this.badPatchEcho = null
    this.recallRows = []
    this.recallStatus = null
    this.recallRetryAfter = null
    this.recallBodyOverride = null
    this.recallDelayMs = 0
    this.recallOversize = false
    this.recallBare = false
    this.recallEnvelope = {}
    this.recallCalls = 0
    this.lastRecallBody = null
    this.lastAppendBody = null
    this.feedbackBodies = []
    this.meCalls = 0
    this.getByIdCalls = 0
    this.feedbackDelayMs = 0
    this.beforeMe = null
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
      this.meCalls++
      const hook = this.beforeMe
      if (hook) {
        const me = this.me
        Promise.resolve().then(() => hook()).then(() => this.json(res, 200, me), () => this.json(res, 500, { error: 'beforeMe failed' }))
        return
      }
      this.json(res, 200, this.me)
      return
    }

    // POST /api/v1/recall — server-authoritative recall envelope (#776/#628).
    // Mirrors the enterprise contract: {results (rows with per-response 0-1
    // score), count, mode, requested_mode, vector, effective_scopes,
    // dropped_scopes}. Failure-injection knobs above simulate the full
    // client failure table.
    if (method === 'POST' && path === '/api/v1/recall') {
      this.recallCalls++
      this.readBody(req, (body) => {
        this.lastRecallBody = body
        const respond = () => {
          if (this.recallStatus !== null) {
            const headers: Record<string, string> = {}
            if (this.recallStatus === 429 && this.recallRetryAfter !== null) {
              headers['Retry-After'] = this.recallRetryAfter
            }
            const payload = JSON.stringify({ error: `forced ${this.recallStatus}` })
            res.writeHead(this.recallStatus, {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              ...headers,
            })
            res.end(payload)
            return
          }
          if (this.recallOversize) {
            this.json(res, 200, { results: [], padding: 'x'.repeat(256 * 1024) })
            return
          }
          if (this.recallBodyOverride !== null) {
            this.json(res, 200, this.recallBodyOverride)
            return
          }
          const requestedScopes = Array.isArray(body.scopes) ? body.scopes as string[] : null
          const envelope = this.recallBare
            ? { results: this.recallRows, count: this.recallRows.length }
            : {
                results: this.recallRows,
                count: this.recallRows.length,
                mode: 'hybrid',
                requested_mode: (body.mode as string) ?? 'hybrid',
                vector: true,
                effective_scopes: requestedScopes ?? this.me.scopes,
                dropped_scopes: [],
                ...this.recallEnvelope,
              }
          this.json(res, 200, envelope)
        }
        if (this.recallDelayMs > 0) setTimeout(respond, this.recallDelayMs)
        else respond()
      })
      return
    }

    // POST /api/v1/engrams — create
    if (method === 'POST' && path === '/api/v1/engrams') {
      const n = ++this.appendCalls
      const handleAppend = (): void => {
      if (this.appendErrorResponse !== null) {
        const { status, body } = this.appendErrorResponse
        res.writeHead(status, { 'Content-Type': 'text/plain' })
        res.end(body)
        return
      }
      const idemKey = req.headers['idempotency-key']
      this.lastAppendIdempotencyKey = typeof idemKey === 'string' ? idemKey : null
      this.readBody(req, (body) => {
        this.lastAppendBody = body
        const key = typeof idemKey === 'string' ? idemKey : null
        this.appendKeys.push(key)
        const replayKey = key ? `${req.headers.authorization}\0${key}` : null
        if (this.honourIdempotency && replayKey && this.idempotencyReplies.has(replayKey)) {
          this.json(res, 201, this.idempotencyReplies.get(replayKey))
          return
        }
        const { statement, scope, domain, type, source } = body
        if (typeof statement === 'string') this.appendStatements.push(statement)
        const hold = this.appendHolds.shift()
        const refusal = typeof scope === 'string' ? this.appendErrorByScope[scope] : undefined
        if (refusal) {
          res.writeHead(refusal.status, { 'Content-Type': 'text/plain' })
          res.end(refusal.body)
          return
        }
        // Recorded with the row, as docs/remote-store-contract.md recommends.
        const idempotency_key = body.idempotency_key
        const id = `ENG-SRV-${String(++this.idCounter).padStart(3, '0')}`
        const now = new Date().toISOString()
        const engram: StoredEngram = {
          id,
          // readBody yields Record<string, unknown>; narrow rather than trust
          // the wire. A non-string scope falls back the same way a missing one does.
          scope: typeof scope === 'string' ? scope : 'global',
          status: 'active',
          // `source` carries rescope provenance over the wire (#676) — keep it
          // so tests can assert the pushed shape.
          data: {
            statement, domain, type,
            ...(source !== undefined ? { source } : {}),
            ...(idempotency_key !== undefined ? { idempotency_key } : {}),
          },
          created_at: now,
          updated_at: now,
        }
        const store = () => {
          this.engrams.set(id, engram)
          if (replayKey) this.idempotencyReplies.set(replayKey, { id, scope: engram.scope, status: engram.status, data: engram.data })
        }
        if (!(this.appendDelayMs > 0 && this.appendDropWhileDelayed)) store()
        // Normally the server returns the real assigned id; badAppendId lets a
        // test make it return a malformed one (#404).
        const returnedId = this.badAppendId !== null ? this.badAppendId : id
        const respond = () => {
          if (!res.writableEnded && !res.destroyed) {
            if (this.appendDelayMs > 0 && this.appendDropWhileDelayed) store()
            this.json(res, 201, { id: returnedId, scope: engram.scope, status: engram.status, data: engram.data })
          }
        }
        if (hold) {
          hold.arrived(typeof statement === 'string' ? statement : '')
          void hold.released.then(respond)
        } else if (this.appendDelayMs > 0) setTimeout(respond, this.appendDelayMs).unref()
        else respond()
      })
      }
      if (this.appendHook) void this.appendHook(n).then(handleAppend)
      else handleAppend()
      return
    }

    // GET /api/v1/engrams/:id — get by ID
    const idMatch = path.match(/^\/api\/v1\/engrams\/([^/]+)$/)
    if (method === 'GET' && idMatch) {
      this.getByIdCalls++
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
      this.deleteCalls++
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
      this.readBody(req, async (body) => {
        if (this.feedbackDelayMs > 0) await new Promise(r => setTimeout(r, this.feedbackDelayMs))
        this.feedbackBodies.push(body)
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
