/**
 * Lightweight in-process HTTP stub server for MCP e2e testing.
 * Mirrors `packages/core/test/helpers/stub-server.ts` — keep in sync
 * when RemoteStore adds new endpoints.
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
  // Identity returned by GET /api/v1/me (#292). Override per-test with setMe().
  private me: { username: string; org_id: string; role: string; scopes: string[] } = {
    username: 'testuser', org_id: 'test-org', role: 'developer', scopes: ['group:test'],
  }

  constructor(private readonly validToken: string) {}

  /** Override the GET /api/v1/me response (authorized scope set, identity). */
  setMe(me: Partial<{ username: string; org_id: string; role: string; scopes: string[] }>): void {
    this.me = { ...this.me, ...me }
  }

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

  get engramCount(): number { return this.engrams.size }

  getEngram(id: string): StoredEngram | undefined {
    const e = this.engrams.get(id)
    return e ? { ...e } : undefined
  }

  reset(): void {
    this.engrams.clear()
    this.idCounter = 0
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
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
        this.json(res, 201, { id, scope: engram.scope, status: engram.status, data: engram.data })
      })
      return
    }

    const idMatch = path.match(/^\/api\/v1\/engrams\/([^/]+)$/)

    if (method === 'GET' && idMatch) {
      const id = decodeURIComponent(idMatch[1])
      const engram = this.engrams.get(id)
      if (!engram) { this.json(res, 404, { error: 'Not found' }); return }
      this.json(res, 200, engram)
      return
    }

    if (method === 'DELETE' && idMatch) {
      const id = decodeURIComponent(idMatch[1])
      const engram = this.engrams.get(id)
      if (!engram) { this.json(res, 404, { error: 'Not found' }); return }
      engram.status = 'retired'
      engram.updated_at = new Date().toISOString()
      this.json(res, 200, { id: engram.id, scope: engram.scope, status: 'retired' })
      return
    }

    if (method === 'GET' && path === '/api/v1/engrams') {
      const scope = url.searchParams.get('scope')
      const limit = parseInt(url.searchParams.get('limit') ?? '200', 10)
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10)
      let all = Array.from(this.engrams.values())
      if (scope) all = all.filter(e => e.scope === scope)
      const total_count = all.length
      const rows = all.slice(offset, offset + limit)
      this.json(res, 200, { rows, total_count })
      return
    }

    // PATCH /api/v1/engrams/:id — partial update (pin, promote, reportFailure)
    if (method === 'PATCH' && idMatch) {
      const id = decodeURIComponent(idMatch[1])
      const engram = this.engrams.get(id)
      if (!engram) { this.json(res, 404, { error: 'Not found' }); return }
      this.readBody(req, (body) => {
        const data = engram.data as any
        if (body.pinned !== undefined) data.pinned = body.pinned === null ? undefined : body.pinned
        if (body.status !== undefined) engram.status = body.status as string
        if (body.statement !== undefined) data.statement = body.statement as string
        if (body.commitment !== undefined) data.commitment = body.commitment as string
        if (body.locked_reason !== undefined) data.locked_reason = body.locked_reason as string
        engram.updated_at = new Date().toISOString()
        const updated = Object.keys(body).filter(k => ['pinned','status','statement','commitment','locked_reason'].includes(k))
        this.json(res, 200, { id, updated, ok: true })
      })
      return
    }

    const feedbackMatch = path.match(/^\/api\/v1\/engrams\/([^/]+)\/feedback$/)
    if (method === 'POST' && feedbackMatch) {
      const id = decodeURIComponent(feedbackMatch[1])
      const engram = this.engrams.get(id)
      if (!engram) { this.json(res, 404, { error: 'Not found' }); return }
      this.readBody(req, (body) => {
        const signal = body.signal as string
        const data = engram.data as any
        if (!data.feedback_signals) data.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
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
      try { cb(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
      catch { cb({}) }
    })
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
    res.end(payload)
  }
}
